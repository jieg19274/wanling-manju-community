import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,readdirSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as model from '../dist-server/shared/model.js';
import {generationSignature,assetInputHash} from '../dist-server/shared/generation.js';
import {speechChecklist} from '../dist-server/shared/speech-contract.js';
const root=mkdtempSync(path.join(os.tmpdir(),'manju-http-races-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');process.env.MANJU_BACKUP_DIR=path.join(root,'backups');
const store=await import('../dist-server/server/store.js');
const {probe}=await import('../dist-server/server/media.js');
const clips=path.join(root,'data','media');mkdirSync(clips,{recursive:true});
const clip=path.join(clips,'fixture.mp4');
const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=navy:s=96x54:r=5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','30','-c:v','libx264','-c:a','aac',clip],{windowsHide:true,encoding:'utf8'});
assert.equal(result.status,0,result.stderr);const measured=await probe(clip);
const image=path.join(root,'slow-image.mjs'),video=path.join(root,'slow-video.mjs'),text=path.join(root,'slow-text.mjs'),upscale=path.join(root,'slow-upscale.mjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6e8AAAAASUVORK5CYII=','base64');
writeFileSync(image,`import{readFileSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(process.argv[2]));writeFileSync(${JSON.stringify(path.join(root,'image-started'))},'started');await new Promise(x=>setTimeout(x,600));writeFileSync(process.argv[3],Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));`);
writeFileSync(video,`import{readFileSync,writeFileSync,copyFileSync}from'node:fs';const r=JSON.parse(readFileSync(process.argv[2]));writeFileSync(r.outputPath+'.started','started');await new Promise(x=>setTimeout(x,600));copyFileSync(${JSON.stringify(clip)},process.argv[3]);`);
writeFileSync(text,`import{readFileSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(process.argv[2]));writeFileSync(${JSON.stringify(path.join(root,'text-started'))},r.task);await new Promise(x=>setTimeout(x,600));const result=r.task==='semantic-review'?{entries:r.beats.map(b=>({beatId:b.id,sourceStart:0,sourceEnd:r.sourceText.length,notes:'mock完整原文依据须由人工逐项确认',highlightIds:r.highlights.map(h=>h.id)})),warnings:[]}:{groups:[r.units.map(u=>u.id)],budgets:[{spokenSec:10,actionSec:12,reactionSec:6,notes:'mock依据正式事件动作反应安排预算'}]};writeFileSync(process.argv[3],JSON.stringify(result));`);
writeFileSync(upscale,`import{readFileSync,writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';const r=JSON.parse(readFileSync(process.argv[2]));writeFileSync(${JSON.stringify(path.join(root,'upscale-started'))},'started');await new Promise(x=>setTimeout(x,700));const p=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',r.sourcePath,'-vf','scale=iw*2:ih*2','-c:a','copy',process.argv[3]],{windowsHide:true});process.exitCode=p.status;`);
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
let child=spawn(process.execPath,['dist-server/server/index.js'],{windowsHide:true,stdio:'ignore',env:{...process.env,MANJU_PORT:String(port),MANJU_JIANYING_DRAFTS_DIR:path.join(root,'drafts'),MANJU_UPSCALE_ADAPTER:upscale,MANJU_ADAPTER_TIMEOUT_MS:'5000',MANJU_VIDEO_ADAPTER_DEMO:'0'}});
after(async()=>{child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));store.db.close();});
const base=`http://127.0.0.1:${port}`;
async function api(route,method='GET',body) {const response=await fetch(base+route,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;}
async function wait(predicate) {for(let i=0;i<400;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('mock检查点未到达');}
await wait(async()=>{try{return (await api('/api/health')).ok;}catch{return false;}});
function seed(name,{withVideo=true,adapter=video}={}) {
  const project=model.makeProject(name,'standard'),episode=model.makeEpisode(1,'测试');project.episodes=[episode];project.assets=[];
  project.videoModel={name:'mock',modelId:'mock',adapterPath:adapter};project.textModel={name:'mock',modelId:'mock',adapterPath:text};
  episode.sourceText='原文连续内容'.repeat(30);episode.sourceReviewedHash=model.sourceHash(episode);episode.highlightReport='原文因果与人物反应';episode.highlightReviewedHash=model.highlightHash(episode);
  const beat={...model.makeBeat(),sourceQuote:'原文连续内容',event:'人物发现屋外来客，走到门边查看来客的身影。',reaction:'人物确认同伴安全，伸手阻止同伴继续向门外走去。',dialogue:['人物：先不要开门。']};episode.scriptBeats=[beat];model.lockScript(episode);
  const segment=episode.segments[0];segment.durationSec=30;segment.subshots=model.defaultSubshots(beat,30).map((shot,index)=>({...shot,action:(index<3?beat.event:beat.reaction).slice((index%3)*4,(index%3)*4+4)}));segment.subshotsReviewed=true;segment.visualPlan='门边近景到中景与末帧';
  const prompt={id:model.id(),kind:'prompt',createdAt:model.now(),sourceHash:model.contentHash(episode,segment),content:model.composePrompt(episode,segment)};
  if(withVideo){segment.artifacts=[prompt];segment.selected.prompt=prompt.id;const stat=statSync(clip);
    const artifact={id:model.id(),kind:'video',createdAt:model.now(),sourceHash:model.contentHash(episode,segment),generationHash:generationSignature(project,episode,segment),referenceHashes:[],mediaPath:'fixture.mp4',technical:{...measured,inspectedAt:model.now(),warnings:[],size:stat.size,modifiedAt:stat.mtimeMs},review:{status:'approved',notes:'mock仅技术验收',reviewedAt:model.now(),checks:{story:true,voice:true,assets:true,labels:true,pacing:true,continuity:true},speech:speechChecklist(episode,segment).map(line=>({id:line.id,heard:true,speaker:true,startSec:line.startSec,endSec:line.startSec+2}))}};
    segment.artifacts.push(artifact);segment.selected.video=artifact.id;episode.previewCuts=[{segmentId:segment.id,artifactId:artifact.id,startSec:0,durationSec:1}];}
  episode.auditApprovedHash=model.approvalHash(episode);store.insertProject(project);return {project,episode,segment,prompt};
}
test('HTTP image generation retains old-input results while streamed uploads reject changed descriptions',async()=>{
  const project=await api('/api/projects','POST',{name:'图片竞态',mode:'standard'}),route=`/api/projects/${project.id}`;
  await api(route+'/actions','POST',{type:'project.model',kind:'image',name:'mock',modelId:'mock',adapterPath:image});
  let saved=await api(route+'/actions','POST',{type:'asset.add',kind:'scene',name:'room',identity:'original'});const asset=saved.assets[0];
  const originalHash=assetInputHash(saved,asset.id);
  const pending=api(`${route}/assets/${asset.id}/images/generate`,'POST',{}).then(value=>({value}),error=>({error}));
  await wait(()=>existsSync(path.join(root,'image-started')));
  await api(route+'/actions','POST',{type:'asset.update',assetId:asset.id,name:'room',identity:'changed',voice:''});
  const generated=await pending;assert.equal(generated.error,undefined);
  saved=await api(route);const oldImage=saved.assets[0].images[0];
  assert.equal(saved.assets[0].images.length,1);assert.equal(oldImage.retainedAsOldVersion,true);
  assert.equal(oldImage.inputHash,originalHash);assert.notEqual(oldImage.inputHash,assetInputHash(saved,asset.id));
  assert.equal(oldImage.generationInput.asset.identity,'original');assert.equal(oldImage.review,undefined);
  assert.ok(existsSync(path.join(root,'data','media',oldImage.mediaPath)));
  await assert.rejects(api(route+'/actions','POST',{type:'asset.imageReview',assetId:asset.id,imageId:oldImage.id,status:'approved',checks:{identity:true,state:true,shape:true,clothing:true}}),/旧资产描述/);
  const rejected=await api(route+'/actions','POST',{type:'asset.imageReview',assetId:asset.id,imageId:oldImage.id,status:'rejected'});
  assert.equal(rejected.assets[0].images[0].review.status,'rejected');assert.equal(rejected.assets[0].images[0].inputHash,originalHash);
  await assert.rejects(api(route+'/actions','POST',{type:'asset.imageReview',assetId:asset.id,imageId:oldImage.id,status:'approved',checks:{identity:true,state:true,shape:true,clothing:true}}),/旧资产描述/);
  let resolveUpload;const uploaded=new Promise(resolve=>resolveUpload=resolve);
  const request=http.request(base+`${route}/assets/${asset.id}/images`,{method:'POST',headers:{'Content-Length':png.length}},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>resolveUpload({status:response.statusCode,data}));});
  request.on('error',error=>resolveUpload({error}));request.write(png.subarray(0,16));
  const folder=path.join(root,'data','media','assets',asset.id);await wait(()=>existsSync(folder)&&readdirSync(folder).some(name=>name.endsWith('.upload')));
  await api(route+'/actions','POST',{type:'asset.update',assetId:asset.id,name:'room',identity:'changed again',voice:''});request.end(png.subarray(16));
  const uploadResult=await uploaded;assert.equal(uploadResult.status,400);assert.match(uploadResult.data,/上传期间变化/);assert.equal((await api(route)).assets[0].images.length,1);
});
test('HTTP generation retains old-input candidate and immutable spec when prompt changes in flight',async()=>{
  const {project,episode,segment,prompt}=seed('视频竞态'),route=`/api/projects/${project.id}`;
  const alternative={...prompt,id:model.id(),content:prompt.content+'\n另一提示词版本'};store.updateProject(project.id,p=>p.episodes[0].segments[0].artifacts.push(alternative));
  const [job]=await api(route+'/jobs','POST',{episodeId:episode.id,segmentIds:[segment.id],kinds:['video'],regenerate:true});
  await wait(()=>existsSync(path.join(root,'data','media','generated',episode.id,segment.id,job.id+'.mp4.started')));
  await api(route+'/actions','POST',{type:'segment.select',episodeId:episode.id,segmentId:segment.id,kind:'prompt',artifactId:alternative.id});
  await wait(async()=> (await api(route+'/jobs')).find(item=>item.id===job.id)?.status==='completed');
  const current=(await api(route)).episodes[0].segments[0],artifact=current.artifacts.find(item=>item.jobId===job.id);
  assert.equal(artifact.retainedAsOldVersion,true);assert.notEqual(current.selected.video,artifact.id);
  const spec=await api(`${route}/specs/${job.id}`);assert.equal(spec.project.episodes[0].segments[0].selected.prompt,prompt.id);
  await assert.rejects(api(route+'/actions','POST',{type:'segment.select',episodeId:episode.id,segmentId:segment.id,kind:'video',artifactId:artifact.id}),/输入已变化/);
});
test('HTTP semantic and segment candidates cannot overwrite changed authoritative inputs',async()=>{
  for(const task of ['semantic-review','segment-plan']) {
    const {project,episode}=seed(task,{withVideo:false}),route=`/api/projects/${project.id}`;
    const pending=api(`${route}/episodes/${episode.id}/assist/${task}`,'POST',{}).then(value=>({value}),error=>({error}));
    await wait(()=>existsSync(path.join(root,'text-started'))&&readFileSync(path.join(root,'text-started'),'utf8')===task);
    await api(route+'/actions','POST',{type:'script.newVersion',episodeId:episode.id});
    await api(route+'/actions','POST',{type:'beat.update',episodeId:episode.id,beatId:episode.scriptBeats[0].id,event:'人物作出新的正式动作与因果推进',reaction:'人物明确改变原有反应'});
    assert.match((await pending).error.message,/变化|过期/);
    const current=(await api(route)).episodes[0];assert.equal(current.semanticCandidate,undefined);assert.equal(current.segmentPlanCandidate,undefined);assert.equal(current.auditApprovedHash,undefined);
  }
});
test('HTTP export rejects concurrent export and an edit while awaiting upscale; maintenance restores only to a new directory',async()=>{
  const {project,episode}=seed('导出竞态'),route=`/api/projects/${project.id}`;
  let completed;
  const pending=api(`${route}/episodes/${episode.id}/export`,'POST',{upscale:true}).then(value=>completed={value},error=>completed={error});
  await wait(()=>existsSync(path.join(root,'upscale-started')) || completed);
  assert.ifError(completed?.error);
  await assert.rejects(api(`${route}/episodes/${episode.id}/export`,'POST',{}),/导出|稍后/);
  await api(route+'/actions','POST',{type:'episode.update',episodeId:episode.id,title:'changed during export'});
  assert.match((await pending).error.message,/项目已变化/);
  assert.ok(!existsSync(path.join(root,'drafts')) || readdirSync(path.join(root,'drafts')).length===0);
  assert.equal((await api('/api/runtime')).ready,true);
  const backup=await api('/api/storage/backup','POST',{});assert.equal((await api('/api/storage/backups')).some(item=>item.id===backup.id),true);
  const restored=await api('/api/storage/restore','POST',{id:backup.id});assert.equal(restored.activeDataUnchanged,true);assert.ok(existsSync(path.join(restored.directory,'studio.db')));
  assert.equal((await api(route)).episodes[0].title,'changed during export');
  await assert.rejects(api('/api/storage/restore','POST',{id:'../outside'}),/ID无效/);
});

test('HTTP model configuration preserves declared capability provenance and rejects unsupported selected resolution',async()=>{
  const project=await api('/api/projects','POST',{name:'能力声明',mode:'standard'}),route=`/api/projects/${project.id}`;
  const input={type:'project.model',kind:'video',name:'mock',modelId:'mock',adapterPath:video,declaredCapabilities:{nativeAudio:false,minDurationSec:5,maxDurationSec:30,resolutions:['1920x1080']},catalogFetchedAt:'2026-09-30T00:00:00.000Z',capabilities:{nativeAudio:true,maxDurationSec:30,maxReferences:8,resolutions:['1920x1080'],outputResolution:'1920x1080'}};
  const saved=await api(route+'/actions','POST',input);
  assert.equal(saved.videoModel.declaredCapabilities.nativeAudio,false);assert.equal(saved.videoModel.capabilities.nativeAudio,true);
  assert.equal(saved.videoModel.catalogFetchedAt,input.catalogFetchedAt);assert.ok(saved.videoModel.capabilities.confirmedAt);
  await assert.rejects(api(route+'/actions','POST',{...input,capabilities:{...input.capabilities,outputResolution:'1080x1920'}}),/能力参数无效/);
  assert.equal((await api(route)).videoModel.capabilities.outputResolution,'1920x1080');
});
async function imageProject(name,adapter=image){
  const p=await api('/api/projects','POST',{name,mode:'standard'}),route=`/api/projects/${p.id}`;
  await api(route+'/actions','POST',{type:'project.model',kind:'image',name:'mock',modelId:'mock.image',adapterPath:adapter});
  const saved=await api(route+'/actions','POST',{type:'asset.add',kind:'scene',name:'测试房间',identity:'门边房间'});
  return {route,project:saved,asset:saved.assets[0]};
}
async function reserve(route,input,requestId=model.id()){
  const preview=await api(route+'/candidates/preview','POST',input);
  return {preview,request:{...input,requestId,hash:preview.hash,confirmed:true}};
}
async function batchOf(route,id){return (await api(route+'/candidates')).find(b=>b.id===id);}

test('candidate consent is bounded, unknown pricing is explicit and concurrent replay creates only one batch',async()=>{
  const {route,asset}=await imageProject('幂等候选');const input={kind:'image',assetId:asset.id,role:'main',count:2,feedback:'光线柔和一些'};
  const {preview,request}=await reserve(route,input);
  assert.equal(preview.cost.known,false);assert.equal(preview.cost.maximumSubmissions,2);assert.match(preview.cost.message,/未知.*不是免费/);assert.equal(preview.cost.amount,undefined);
  await assert.rejects(api(route+'/candidates','POST',{...request,confirmed:false}),/确认/);
  await assert.rejects(api(route+'/candidates/preview','POST',{...input,count:5}),/1–4/);
  const responses=await Promise.all(Array.from({length:5},()=>api(route+'/candidates','POST',request)));
  assert.ok(responses.every(b=>b.id===request.requestId&&b.items.map(i=>i.id).join()===responses[0].items.map(i=>i.id).join()));
  await assert.rejects(api(route+'/candidates','POST',{...request,count:3}),/同一确认号/);
  await wait(async()=> (await batchOf(route,request.requestId)).items.every(i=>i.status==='completed'));
  const saved=await api(route);assert.equal(saved.assets[0].images.length,2);assert.equal(new Set(saved.assets[0].images.map(i=>i.candidateId)).size,2);
  const requests=store.db.prepare("SELECT snapshot FROM adapter_tasks WHERE project_id=? AND task='asset-image'").all(saved.id).map(r=>JSON.parse(r.snapshot).request);
  assert.equal(requests.length,2);assert.ok(requests.every(r=>r.instruction.includes('光线柔和一些')&&r.instruction.includes('不得覆盖正式剧情')));
  const second=await reserve(route,{...input,count:1});await api(route+'/candidates','POST',second.request);
  await wait(async()=> (await batchOf(route,second.request.requestId)).items[0].status==='completed');assert.equal((await api(route)).assets[0].images.length,3);
});

test('multiple deliberate video candidates keep selected version and full prompt provenance',async()=>{
  const {project,episode,segment}=seed('视频多候选'),route=`/api/projects/${project.id}`,selected=segment.selected.video;
  const input={kind:'video',episodeId:episode.id,segmentId:segment.id,count:2,feedback:'保持剧情，光线更柔和'};
  const {preview,request}=await reserve(route,input);assert.equal(preview.cost.totalVideoSeconds,60);
  const batch=await api(route+'/candidates','POST',request);
  await wait(async()=> (await batchOf(route,batch.id)).items.every(i=>i.status==='completed'));
  const saved=await api(route),s=saved.episodes[0].segments[0],videos=s.artifacts.filter(a=>a.batchId===batch.id);
  assert.equal(videos.length,2);assert.equal(s.selected.video,selected);
  for(const v of videos){const spec=await api(`${route}/specs/${v.specId}`);assert.equal(spec.candidate.feedback,input.feedback);const req=JSON.parse(readFileSync(path.join(root,'data','media',v.mediaPath.replace(/\.mp4$/,'.json'))));assert.equal(req.durationSec,30);assert.ok(req.prompt.startsWith(preview.summary.prompt));assert.match(req.prompt,/光线更柔和/);}
});

test('candidate cancellation stops only unsubmitted slots and does not cancel an in-flight request',async()=>{
  const {route,asset}=await imageProject('取消候选');const {request}=await reserve(route,{kind:'image',assetId:asset.id,count:3});const batch=await api(route+'/candidates','POST',request);
  await wait(async()=> (await api(route+'/jobs')).some(j=>j.id===batch.items[0].id&&j.status==='running'));
  await api(`${route}/candidates/${batch.id}/cancel`,'POST',{});
  await wait(async()=> (await batchOf(route,batch.id)).items[0].status==='completed');
  const final=await batchOf(route,batch.id);assert.equal(final.cancelled,true);assert.deepEqual(final.items.slice(1).map(i=>i.status),['cancelled','cancelled']);assert.equal((await api(route)).assets[0].images.length,1);
  await api(route+'/candidates','POST',request);assert.equal((await batchOf(route,batch.id)).items.length,3);
});

test('partial image failure pauses remainder, blocks unknown billing and requires explicit reconciliation to continue',async()=>{
  const adapter=path.join(root,'partial-image.mjs'),counter=path.join(root,'partial-counter');
  writeFileSync(adapter,`import{existsSync,readFileSync,writeFileSync}from'node:fs';const n=existsSync(${JSON.stringify(counter)})?Number(readFileSync(${JSON.stringify(counter)}))+1:1;writeFileSync(${JSON.stringify(counter)},String(n));if(n===2){process.stderr.write('mock计费未知');process.exitCode=1;}else writeFileSync(process.argv[3],Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));`);
  const {route,asset}=await imageProject('部分失败',adapter);const {request}=await reserve(route,{kind:'image',assetId:asset.id,count:3}),batch=await api(route+'/candidates','POST',request);
  await wait(async()=> (await batchOf(route,batch.id)).paused===true);
  let current=await batchOf(route,batch.id);assert.deepEqual(current.items.map(i=>i.status),['completed','failed','queued']);assert.equal(Number(readFileSync(counter)),2);
  await api(route+'/jobs/retry','POST',{});assert.equal((await api(route+'/jobs')).find(j=>j.id===batch.items[1].id).status,'failed');
  const other=await reserve(route,{kind:'image',assetId:asset.id,count:1});await api(route+'/candidates','POST',other.request);
  await wait(async()=> (await batchOf(route,other.request.requestId)).items[0].status==='failed');assert.equal(Number(readFileSync(counter)),2);
  await assert.rejects(api(`${route}/jobs/${batch.items[1].id}/reconcile`,'POST',{confirmed:false,receipt:'mock-confirmed-failed',status:'failed'}),/凭据/);
  await api(`${route}/jobs/${batch.items[1].id}/reconcile`,'POST',{confirmed:true,receipt:'mock-confirmed-failed',status:'failed'});
  await api(`${route}/candidates/${batch.id}/resume`,'POST',{});await wait(async()=> (await batchOf(route,batch.id)).items[2].status==='completed');
  current=await batchOf(route,batch.id);assert.deepEqual(current.items.map(i=>i.status),['completed','failed','completed']);assert.equal(Number(readFileSync(counter)),3);assert.equal((await api(route)).assets[0].images.length,2);
});

test('paused candidate inputs are revalidated and stale consent cannot submit after edits',async()=>{
  const {route,asset}=await imageProject('暂停后修改');const {request}=await reserve(route,{kind:'image',assetId:asset.id,count:2}),batch=await api(route+'/candidates','POST',request);
  await wait(async()=> (await api(route+'/jobs')).some(j=>j.id===batch.items[0].id&&j.status==='running'));
  await api(`${route}/candidates/${batch.id}/pause`,'POST',{});await wait(async()=> (await batchOf(route,batch.id)).items[0].status==='completed');
  await api(route+'/actions','POST',{type:'asset.update',assetId:asset.id,name:asset.name,identity:'改变了房间结构'});
  await api(`${route}/candidates/${batch.id}/resume`,'POST',{});await wait(async()=> (await batchOf(route,batch.id)).items[1].status==='failed');
  assert.match((await batchOf(route,batch.id)).items[1].error,/输入已变化/);assert.equal((await api(route)).assets[0].images.length,1);
  await assert.rejects(api(route+'/candidates','POST',{...request,requestId:model.id()}),/输入已变化/);
});

test('asset replacement impact is precise, read-only until confirmed and stale impact is rejected',async()=>{
  const {project,episode,segment}=seed('换图影响');const other={...structuredClone(segment),id:model.id(),number:2,assetBindings:[],artifacts:[],artifactIds:[],selected:{}};episode.segments.push(other);
  const asset={id:model.id(),kind:'scene',name:'房间',identity:'固定房间',voice:'',states:[],images:[{id:'old-main',role:'main',mediaPath:'old.png',source:'upload',createdAt:model.now()},{id:'new-main',role:'main',mediaPath:'new.png',source:'upload',createdAt:model.now()}]};project.assets=[asset];segment.assetBindings=[{assetId:asset.id,imageId:'old-main'}];store.updateProject(project.id,p=>Object.assign(p,project));
  const route=`/api/projects/${project.id}`,action={type:'segment.assets',episodeId:episode.id,segmentId:segment.id,bindings:[{assetId:asset.id,imageId:'new-main'}]};
  const impact=await api(route+'/candidates/impact','POST',action);assert.deepEqual(impact.affected.map(s=>s.segmentId),[segment.id]);assert.equal((await api(route)).episodes[0].segments[0].assetBindings[0].imageId,'old-main');
  await api(route+'/actions','POST',{type:'asset.update',assetId:asset.id,name:'房间',identity:'更新身份'});
  await assert.rejects(api(route+'/candidates/change','POST',{action,hash:impact.hash}),/重新预览/);
  const fresh=await api(route+'/candidates/impact','POST',action);await api(route+'/candidates/change','POST',{action,hash:fresh.hash});assert.equal((await api(route)).episodes[0].segments[0].assetBindings[0].imageId,'new-main');assert.equal((await api(route+'/jobs')).length,0);
});

test('service restart never replays interrupted paid image candidate and preserves pending choices',async()=>{
  const adapter=path.join(root,'stuck-candidate.mjs'),marker=path.join(root,'stuck-candidate-pid'),counter=path.join(root,'restart-counter');
  writeFileSync(adapter,`import{writeFileSync,existsSync,readFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));writeFileSync(${JSON.stringify(counter)},String(existsSync(${JSON.stringify(counter)})?Number(readFileSync(${JSON.stringify(counter)}))+1:1));setInterval(()=>{},1000);`);
  const {route,asset}=await imageProject('重启保护',adapter);const {request}=await reserve(route,{kind:'image',assetId:asset.id,count:2}),batch=await api(route+'/candidates','POST',request);
  await wait(()=>existsSync(marker));process.kill(Number(readFileSync(marker)));child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
  child=spawn(process.execPath,['dist-server/server/index.js'],{windowsHide:true,stdio:'ignore',env:{...process.env,MANJU_PORT:String(port),MANJU_JIANYING_DRAFTS_DIR:path.join(root,'drafts'),MANJU_ADAPTER_TIMEOUT_MS:'5000'}});
  await wait(async()=>{try{return (await api('/api/health')).ok;}catch{return false;}});
  await wait(async()=> (await batchOf(route,batch.id)).paused===true);
  const current=await batchOf(route,batch.id);assert.equal(current.items[0].status,'failed');assert.equal(current.items[1].status,'queued');assert.equal(Number(readFileSync(counter)),1);
  const repeated=await api(route+'/candidates','POST',request);assert.deepEqual(repeated.items.map(i=>i.id),batch.items.map(i=>i.id));assert.equal((await api(route)).assets[0].images.length,0);
});
test('downloaded candidate recovery respects visual preference spec and never auto-selects an unselected video',async()=>{
  const adapter=path.join(root,'download-then-fail.mjs');writeFileSync(adapter,`import{copyFileSync}from'node:fs';copyFileSync(${JSON.stringify(clip)},process.argv[3]);process.stderr.write('mock下载后报错');process.exitCode=1;`);
  const {project,episode,segment}=seed('候选找回',{adapter}),route=`/api/projects/${project.id}`;store.updateProject(project.id,p=>{delete p.episodes[0].segments[0].selected.video;});
  const {request}=await reserve(route,{kind:'video',episodeId:episode.id,segmentId:segment.id,count:1,feedback:'光线暖一些'}),batch=await api(route+'/candidates','POST',request);
  await wait(async()=> (await batchOf(route,batch.id)).items[0].status==='failed');
  const recovered=await api(`${route}/jobs/${batch.items[0].id}/recover`,'POST',{});assert.equal(recovered.kind,'video');assert.equal((await api(route)).episodes[0].segments[0].selected.video,undefined);
  await wait(async()=> (await batchOf(route,batch.id)).items[0].status==='completed');
  assert.equal((await api(`${route}/specs/${recovered.specId}`)).candidate.feedback,'光线暖一些');
});
test('renaming an asset cannot bypass unknown candidate billing protection',async()=>{
  const adapter=path.join(root,'always-fail-image.mjs'),counter=path.join(root,'rename-counter');writeFileSync(adapter,`import{existsSync,readFileSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(counter)},String(existsSync(${JSON.stringify(counter)})?Number(readFileSync(${JSON.stringify(counter)}))+1:1));process.stderr.write('mock未知');process.exitCode=1;`);
  const {route,asset}=await imageProject('稳定资产计费保护',adapter),first=await reserve(route,{kind:'image',assetId:asset.id,count:1});await api(route+'/candidates','POST',first.request);await wait(async()=> (await batchOf(route,first.request.requestId)).items[0].status==='failed');
  await api(route+'/actions','POST',{type:'asset.update',assetId:asset.id,name:'更名房间',identity:asset.identity});
  const next=await reserve(route,{kind:'image',assetId:asset.id,count:1});await api(route+'/candidates','POST',next.request);await wait(async()=> (await batchOf(route,next.request.requestId)).items[0].status==='failed');assert.equal(Number(readFileSync(counter)),1);assert.match((await batchOf(route,next.request.requestId)).items[0].error,/计费状态未知/);
});
