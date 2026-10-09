import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'manju-asset-version-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');process.env.MANJU_BACKUP_DIR=path.join(root,'backups');
delete process.env.MANJU_BATCH_BUDGET_PROFILE;
const frozen=JSON.parse(fs.readFileSync(new URL('./fixtures/asset-compat-0.4.20.json',import.meta.url),'utf8'));
const m=await import('../dist-server/shared/model.js');
const g=await import('../dist-server/shared/generation.js');
const store=await import('../dist-server/server/store.js');
const {applyAction}=await import('../dist-server/server/actions.js');
const {candidatePreview}=await import('../dist-server/server/candidates.js');
const {referenceHashes,verifyReferenceProvenance}=await import('../dist-server/server/reference-provenance.js');
const {validateRecoveryRequest,wake}=await import('../dist-server/server/jobs.js');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(index=0){
  const p=structuredClone(frozen.cases[index].project),e=p.episodes[0],s=e.segments[0],video=s.artifacts.find(a=>a.kind==='video');
  return{p,e,s,video};
}
for(const c of frozen.cases){
  const p=structuredClone(c.project);
  for(const a of p.assets)for(const image of a.images){const file=path.join(root,'data/media',image.mediaPath);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(frozen.referencePngBase64,'base64'));assert.equal(hash(fs.readFileSync(file)),image.fileHash);}
  store.insertProject(p);
}

test('0.4.20 scene and whole-sheet projects retain images, bindings, approvals and usable films without rewriting',()=>{
  for(let i=0;i<frozen.cases.length;i++){
    const f=fixture(i),before=hash(JSON.stringify(f.p));
    assert.deepEqual(m.auditEpisode(f.e,f.p),[]);
    assert.notEqual(g.generationSignature(f.p,f.e,f.s),f.video.generationHash,'fixture must exercise the actual historical encoding');
    assert.equal(g.generationSignature(f.p,f.e,f.s),frozen.cases[i].encoding021GenerationHash,'0.4.21–0.4.24 submissions must keep their existing signature');
    assert.equal(g.usableVideo(f.p,f.e,f.s,{...f.video,generationHash:frozen.cases[i].encoding021GenerationHash}),true);
    assert.equal(g.generationSignatureMatches(f.p,f.e,f.s,f.video.generationHash),true);
    assert.equal(g.currentVideo(f.p,f.e,f.s,f.video),true);assert.equal(g.usableVideo(f.p,f.e,f.s,f.video),true);
    assert.doesNotThrow(()=>verifyReferenceProvenance(f.p,f.e,f.s,f.video));
    for(const a of f.p.assets)assert.equal(a.images[0].inputHash,g.assetInputHash(f.p,a.id));
    applyAction(f.p,{type:'segment.assets',episodeId:f.e.id,segmentId:f.s.id,bindings:structuredClone(f.s.assetBindings)});
    applyAction(f.p,{type:'segment.select',episodeId:f.e.id,segmentId:f.s.id,kind:'video',artifactId:f.video.id});
    assert.equal(hash(JSON.stringify(f.p)),before,'compatibility must preserve frozen history and approvals');
  }
});

test('old reviewed assets can preview a new video submission without creating a generation task',()=>{
  for(const c of frozen.cases){
    const p=store.getProject(c.project.id),e=p.episodes[0],s=e.segments[0],before=hash(JSON.stringify(p));
    const preview=candidatePreview(p.id,{kind:'video',episodeId:e.id,segmentId:s.id,count:1});
    assert.equal(preview.summary.references.length,p.assets.length);
    assert.deepEqual(preview.summary.references,referenceHashes(p,e,s));
    assert.equal(hash(JSON.stringify(store.getProject(p.id))),before);
    assert.equal(store.jobsFor(p.id).length,0);
  }
});

test('changing an actual asset binding still clears subshot review and episode approval',()=>{
  const f=fixture(),before=m.contentHash(f.e,f.s);
  const image={...structuredClone(f.p.assets[0].images[0]),id:'replacement-image'};f.p.assets[0].images.push(image);
  applyAction(f.p,{type:'segment.assets',episodeId:f.e.id,segmentId:f.s.id,bindings:[{assetId:f.p.assets[0].id,imageId:image.id}]});
  assert.equal(f.s.subshotsReviewed,false);assert.equal(f.e.auditApprovedHash,undefined);assert.notEqual(m.contentHash(f.e,f.s),before);
});

test('legacy reference encoding never tolerates changed plot, models, images, state timing or missing review',()=>{
  for(const mutate of [
    f=>{f.e.scriptLockedHash='changed';},
    f=>{f.s.subshots[0].action+='额外剧情';},
    f=>{f.p.videoModel.modelId='other-model';},
    f=>{f.p.aspectRatio='9:16';},
    f=>{f.p.assets[0].images[0].fileHash='b'.repeat(64);},
    f=>{f.p.assets[0].images[0].review.status='rejected';},
    f=>{f.p.assets[0].images[0].id='different-image';f.s.assetBindings[0].imageId='different-image';},
    f=>{f.p.assets[0].states=[{id:'new-state',label:'变化',appearance:'新外观',trigger:'变化',startEpisode:1,startSegment:1}];},
    f=>{f.s.assetBindings[0].priorReference={imageId:'earlier',untilSec:5};},
  ]){const f=fixture();mutate(f);assert.equal(g.usableVideo(f.p,f.e,f.s,f.video),false);}
  const f=fixture();assert.equal(g.generationSignatureMatches(f.p,f.e,f.s,undefined),false);
  assert.equal(g.generationSignatureMatches(f.p,f.e,f.s,'invented-signature'),false);
});

test('approved old films retain their exact original prompt while pending and rejected alternatives require review',()=>{
  const f=fixture(),prompt=f.s.artifacts.find(a=>a.kind==='prompt');
  f.s.artifacts.push({...prompt,id:'new-prompt',content:prompt.content+'\n保持正式动作与末帧。'});f.s.selected.prompt='new-prompt';
  assert.equal(g.currentVideo(f.p,f.e,f.s,f.video),false);assert.equal(g.usableVideo(f.p,f.e,f.s,f.video),true);
  for(const review of [undefined,{...f.video.review,status:'rejected'}])assert.equal(g.usableVideo(f.p,f.e,f.s,{...f.video,review}),false);
});

test('legacy immutable recovery specs accept their original request and reject a modified request or formal source',()=>{
  const f=fixture(),job={id:m.id(),project_id:f.p.id,episode_id:f.e.id,segment_id:f.s.id,kind:'video',status:'failed'};
  const snapshot={project:f.p,hash:f.video.generationHash,references:f.video.referenceHashes};
  store.registerGenerationSpec(job.id,f.p.id,snapshot);
  const request={generationHash:snapshot.hash,referenceHashes:snapshot.references,prompt:f.s.artifacts.find(a=>a.kind==='prompt').content,durationSec:30,episodeId:f.e.id,segmentId:f.s.id,aspectRatio:f.p.aspectRatio,model:{id:f.p.videoModel.modelId,capabilities:f.p.videoModel.capabilities}};
  assert.doesNotThrow(()=>validateRecoveryRequest(job,request));
  assert.throws(()=>validateRecoveryRequest(job,{...request,prompt:request.prompt+'篡改'}),/不可变/);
  const changed=structuredClone(snapshot);changed.project.episodes[0].segments[0].subshots[0].action+='篡改';
  const bad={...job,id:m.id()};store.registerGenerationSpec(bad.id,f.p.id,changed);
  assert.throws(()=>validateRecoveryRequest(bad,request),/冻结生成版本/);
});

test('a never-submitted old queued spec keeps its frozen hash in the local mock request and returned artifact',async()=>{
  const f=fixture(),jobId=m.id(),snapshot={project:f.p,hash:f.video.generationHash,references:f.video.referenceHashes};
  const job={id:jobId,project_id:f.p.id,episode_id:f.e.id,segment_id:f.s.id,kind:'video',status:'queued',error:null,created_at:m.now(),updated_at:m.now(),snapshot:JSON.stringify(snapshot)};
  store.insertJobs([job]);wake();
  const deadline=Date.now()+15000;let result;
  do{result=store.jobById(jobId);if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,30));}while(Date.now()<deadline);
  assert.equal(result.status,'completed',result.error||'local mock timed out');
  const request=JSON.parse(fs.readFileSync(path.join(root,'data/media/generated',f.e.id,f.s.id,jobId+'.json'),'utf8'));
  assert.equal(request.generationHash,snapshot.hash);
  const returned=store.getProject(f.p.id).episodes[0].segments[0].artifacts.find(a=>a.jobId===jobId);
  assert.equal(returned.generationHash,snapshot.hash);assert.notEqual(returned.retainedAsOldVersion,true);assert.equal(returned.review,undefined);
  assert.equal(store.getProject(f.p.id).episodes[0].segments[0].selected.video,f.video.id);
});
