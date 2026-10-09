import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {makeProject,makeEpisode,makeBeat,sourceHash,highlightHash,scriptHash} from '../dist-server/shared/model.js';
import {assetInputHash} from '../dist-server/shared/generation.js';
import {videoReferences,segmentReferences,assertAssetImageRole} from '../dist-server/shared/asset-references.js';
import {studioCanvas} from '../dist-server/shared/studio-canvas.js';
import {insertProject,getProject,updateProject,db} from '../dist-server/server/store.js';
import {mediaPath} from '../dist-server/server/media.js';
import {generateAssetImage} from '../dist-server/server/assist.js';
import {applyAction} from '../dist-server/server/actions.js';
import {candidatePreview,createCandidates} from '../dist-server/server/candidates.js';
import {assetImageReferences} from '../dist-server/server/asset-image-references.js';
import {startWorkflow} from '../dist-server/server/agent-workflow.js';
import {assetImagePrompt} from '../adapters/asset-image-prompt.mjs';
const checks={identity:true,state:true,shape:true,clothing:true};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(kind='character',identity='黑发青年，青色衣袍'){
  const p=makeProject('offline whole-sheet contract','standard'),a={id:'identity-'+p.id,kind,name:'测试角色',identity,voice:'青年男声',states:[],images:[]};
  p.assets=[a];p.imageModel={name:'offline',modelId:'fixture',adapterPath:path.resolve('tests/fixtures/character-sheet-adapter.mjs')};insertProject(p);return {p,a};
}
function review(p,a,image,status='approved'){updateProject(p.id,q=>applyAction(q,{type:'asset.imageReview',assetId:a.id,imageId:image.id,status,checks,layout:'three-view-portrait'}));}
function lockedEpisode(p,a,image){
  const e=makeEpisode(1,'完整四视图'),b=makeBeat();b.event='测试角色推开房门。';b.reaction='他抬眼观察屋内。';
  e.sourceText=(b.event+b.reaction).repeat(8);e.highlightReport=b.event+b.reaction;e.sourceReviewedHash=sourceHash(e);e.highlightReviewedHash=highlightHash(e);e.scriptBeats=[b];e.scriptLockedHash=scriptHash(e);
  e.segments=[{id:'seg-'+p.id,number:1,beatId:b.id,visualPlan:'',durationSec:10,artifacts:[],selected:{},assetBindings:[{assetId:a.id,imageId:image.id}]}];
  updateProject(p.id,q=>q.episodes=[e]);return e;
}
test('approved complete sheet reaches video once with all original bytes; pending or wrong-state sheets cannot pass',async()=>{
  const {p,a}=fixture();await generateAssetImage(p.id,a.id,'','turnaround');let q=getProject(p.id),sheet=q.assets[0].images[0];
  const bytes=fs.readFileSync(mediaPath(sheet.mediaPath)),s={number:1,assetBindings:[{assetId:a.id,imageId:sheet.id}]},e={number:1};
  assert.equal(sheet.layout,'three-view-portrait');assert.throws(()=>videoReferences(q,e,s),/已审图/);review(p,a,sheet);q=getProject(p.id);
  const refs=videoReferences(q,e,s);assert.equal(refs.length,1);assert.equal(refs[0].imageId,sheet.id);assert.equal(refs[0].mediaPath,sheet.mediaPath);assert.equal(refs[0].fileHash,hash(bytes));assert.equal(refs[0].referenceLayout,'three-view-portrait');
  assert.deepEqual(fs.readFileSync(mediaPath(sheet.mediaPath)),bytes);assert.equal(q.assets[0].images.length,1);
  q.assets[0].states.push({id:'later',label:'后续状态',appearance:'红袍',trigger:'换装',startEpisode:2,startSegment:1});s.assetBindings[0].stateId='later';assert.throws(()=>videoReferences(q,e,s),/剧情状态不一致/);
});
test('independent character generation, preview and new bindings stop before adapter submission; historic files stay readable',async()=>{
  const {p,a}=fixture();for(const role of ['main','portrait']){
    await assert.rejects(generateAssetImage(p.id,a.id,'',role),/完整四视图/);assert.throws(()=>candidatePreview(p.id,{kind:'image',assetId:a.id,role,count:1}),/完整四视图/);
    assert.throws(()=>assetImagePrompt({asset:{...a,referenceRole:role}}),/完整四视图/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n,0);
  await generateAssetImage(p.id,a.id,'','turnaround');const sheet=getProject(p.id).assets[0].images[0];review(p,a,sheet);const e=lockedEpisode(p,a,sheet);
  updateProject(p.id,q=>q.assets[0].images.push({...q.assets[0].images[0],id:'old-body',role:'main',layout:undefined}));let q=getProject(p.id);
  assert.throws(()=>applyAction(q,{type:'segment.assets',episodeId:e.id,segmentId:e.segments[0].id,bindings:[{assetId:a.id,imageId:'old-body'}]}),/完整四视图/);
  const historic={number:1,assetBindings:[{assetId:a.id,imageId:'old-body'}]};assert.equal(segmentReferences(q,e,historic)[0].imageId,'old-body');assert.throws(()=>videoReferences(q,e,historic),/退出制作流程/);
  applyAction(q,{type:'segment.assets',episodeId:e.id,segmentId:e.segments[0].id,bindings:[{assetId:a.id,imageId:sheet.id}]});assert.equal(q.episodes[0].segments[0].assetBindings[0].portraitImageId,undefined);
});
test('whole-sheet repairs carry real rejected source and frozen files; file tampering stops before charging',async()=>{
  const {p,a}=fixture();await generateAssetImage(p.id,a.id,'','turnaround');let q=getProject(p.id),image=q.assets[0].images[0];review(p,a,image,'rejected');
  const input={kind:'image',assetId:a.id,role:'turnaround',sourceImageId:image.id,count:1,feedback:'保持同一脸，清理脸部污点，保留全部四视图'};
  const preview=candidatePreview(p.id,input);assert.equal(preview.summary.references[0].imageId,image.id);assert.match(preview.summary.references[0].promptUse,/待修正原图/);
  await generateAssetImage(p.id,a.id,'','turnaround',{project:getProject(p.id),candidateId:'repair-'+p.id,feedback:input.feedback},{sourceImageId:image.id,references:preview.summary.references});
  q=getProject(p.id);assert.ok(q.assets[0].images.every(i=>i.role==='turnaround'));assert.equal(q.assets[0].images[1].referenceImages[0].imageId,image.id);
  const count=db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n;
  fs.writeFileSync(mediaPath(image.mediaPath),Buffer.from('tampered'));
  await assert.rejects(generateAssetImage(p.id,a.id,'','turnaround',{project:q,candidateId:'changed-'+p.id},{sourceImageId:image.id,references:preview.summary.references}),/变化|指纹/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n,count);
});
test('state generation skips newer independent historical references and retains whole earlier identity and state sheets',async()=>{
  const {p,a}=fixture();await generateAssetImage(p.id,a.id,'','turnaround');const sheet=getProject(p.id).assets[0].images[0];review(p,a,sheet);
  const q=getProject(p.id),asset=q.assets[0];asset.states=[
    {id:'earlier',label:'先前完整状态',appearance:'旧伤',trigger:'受伤',startEpisode:2,startSegment:1},
    {id:'nearer',label:'较近历史状态',appearance:'雨湿',trigger:'下雨',startEpisode:3,startSegment:1},
    {id:'current',label:'本次状态',appearance:'雨停仍有旧伤',trigger:'雨停',startEpisode:4,startSegment:1},
  ];
  const previous={...structuredClone(asset.images[0]),id:'earlier-whole',stateId:'earlier',inputHash:assetInputHash(q,asset.id,'earlier')};
  const historical={...structuredClone(previous),id:'nearer-body',role:'main',layout:undefined,stateId:'nearer',inputHash:assetInputHash(q,asset.id,'nearer')};
  asset.images.push(previous,historical,{...structuredClone(asset.images[0]),id:'latest-portrait',role:'portrait',layout:undefined});
  assert.deepEqual(assetImageReferences(q,asset.id,'current','turnaround').map(i=>i.imageId),['earlier-whole',sheet.id]);
  assert.equal(asset.images.some(i=>i.id==='nearer-body'),true);
  const repair={...structuredClone(historical),id:'current-body',stateId:'current',inputHash:assetInputHash(q,asset.id,'current')};asset.images.push(repair);
  assert.throws(()=>assetImageReferences(q,asset.id,'current','turnaround',repair.id),/返修原图须使用完整四视图/);
  const before=db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n;
  updateProject(p.id,saved=>saved.assets=structuredClone(q.assets));
  assert.throws(()=>candidatePreview(p.id,{kind:'image',assetId:a.id,stateId:'current',role:'turnaround',sourceImageId:repair.id,count:1}),/返修原图须使用完整四视图/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n,before);
});
test('historical standalone identity cannot authorize state generation before a complete identity sheet is reviewed',async()=>{
  const {p,a}=fixture();await generateAssetImage(p.id,a.id,'','turnaround');const q=getProject(p.id),asset=q.assets[0];
  asset.images[0]={...asset.images[0],role:'main',layout:undefined,review:{status:'approved',checks}};
  asset.states=[{id:'wet',label:'雨湿',appearance:'湿衣',trigger:'下雨',startEpisode:2,startSegment:1}];
  assert.throws(()=>assetImageReferences(q,a.id,'wet','turnaround'),/完整四视图.*视觉审核/);
});
test('workflow and canvas use a single whole-sheet character node with zero automatic crops or independent images',async()=>{
  const {p,a}=fixture();await generateAssetImage(p.id,a.id,'','turnaround');const image=getProject(p.id).assets[0].images[0];review(p,a,image);const e=lockedEpisode(p,a,image);
  const flow=startWorkflow(p.id,{episodeId:e.id,limits:{text:0,image:0,video:0},delivery:'package'});assert.equal(flow.status,'waiting_review');assert.equal(flow.step.key,'visual:'+e.segments[0].id);assert.deepEqual(flow.used,{text:0,image:0,video:0});
  const q=getProject(p.id),nodes=studioCanvas(q,q.episodes[0],e.segments[0].id).nodes.filter(n=>n.type==='asset');assert.equal(nodes.length,1);assert.equal(nodes[0].role,'turnaround');assert.equal(nodes[0].imageId,image.id);assert.equal(q.assets[0].images.length,1);
});
test('scene, prop and hidden-face POV retain their actual reference purposes',async()=>{
  for(const kind of ['scene','prop']){const {p,a}=fixture(kind);await generateAssetImage(p.id,a.id,'','main');assert.equal(getProject(p.id).assets[0].images[0].role,'main');}
  const {p,a}=fixture('character','全程第一人称，不展示正脸，仅手与衣袖');assert.doesNotThrow(()=>assertAssetImageRole(a,'main'));await generateAssetImage(p.id,a.id,'','main');let q=getProject(p.id);applyAction(q,{type:'asset.imageReview',assetId:a.id,imageId:q.assets[0].images[0].id,status:'approved',checks});
  const e={number:1},s={number:1,assetBindings:[{assetId:a.id,imageId:q.assets[0].images[0].id}]};assert.equal(videoReferences(q,e,s).length,1);
  const input={kind:'image',assetId:a.id,role:'main',sourceImageId:q.assets[0].images[0].id,count:1},preview=candidatePreview(p.id,input);
  await sharp({create:{width:64,height:64,channels:3,background:'#333'}}).png().toFile(mediaPath(q.assets[0].images[0].mediaPath));
  assert.throws(()=>createCandidates(p.id,{...preview.input,hash:preview.hash,requestId:'changed-'+p.id,confirmed:true}),/变化/);
});
test('HTTP removes crop and portrait endpoints, rejects separate uploads and preserves a nonuniform whole sheet',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-whole-sheet-')),listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base='http://127.0.0.1:'+port,server=spawn(process.execPath,['dist-server/server/index.js'],{cwd:path.resolve('.'),windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,MANJU_PORT:String(port),MANJU_DATA_DIR:path.join(folder,'data'),MANJU_BACKUP_DIR:path.join(folder,'backups'),MANJU_MUMU_BASE_URL:'http://127.0.0.1:1'}});
  let errors='';server.stderr.on('data',b=>errors+=b);
  const call=async(route,input)=>{const r=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,value:await r.json()};};
  try{
    let ready=false;for(let i=0;i<100;i++){try{ready=(await call('/api/health')).value.ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,60));}assert.ok(ready,errors);
    const p=(await call('/api/projects',{name:'whole-sheet HTTP fixture',mode:'standard'})).value,route='/api/projects/'+p.id;
    const q=(await call(route+'/actions',{type:'asset.add',kind:'character',name:'人物',identity:'健康青年'})).value,a=q.assets.find(a=>a.name==='人物'),imageRoute=route+'/assets/'+a.id+'/images';
    for(const endpoint of ['crop','character-references','portrait'])assert.equal((await call(imageRoute+'/old/'+endpoint,{confirmed:true})).status,404);
    const bytes=await sharp({create:{width:1700,height:800,channels:3,background:'#ccc'}}).png().toBuffer();
    for(const role of ['main','portrait']){const r=await fetch(base+imageRoute+'?role='+role,{method:'POST',headers:{'Content-Type':'image/png'},body:bytes});assert.equal(r.status,400);assert.match((await r.json()).error,/完整四视图/);}
    const r=await fetch(base+imageRoute+'?role=turnaround',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes});assert.equal(r.status,201);
    const saved=(await call(route)).value.assets.find(i=>i.id===a.id).images;assert.equal(saved.length,1);assert.equal(saved[0].layout,'three-view-portrait');
    const media=await fetch(base+'/media/'+saved[0].mediaPath);assert.equal(hash(Buffer.from(await media.arrayBuffer())),hash(bytes));
  }finally{if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});}
});
