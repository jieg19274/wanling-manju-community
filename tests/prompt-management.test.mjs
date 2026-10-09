import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'manju-prompt-management-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');process.env.MANJU_BACKUP_DIR=path.join(root,'backups');
delete process.env.MANJU_BATCH_BUDGET_PROFILE;
const m=await import('../dist-server/shared/model.js');
const store=await import('../dist-server/server/store.js');
const {applyAction}=await import('../dist-server/server/actions.js');
const {generationSignature,assetInputHash,usableVideo}=await import('../dist-server/shared/generation.js');
const {enqueue,validateGeneration}=await import('../dist-server/server/jobs.js');
const {agentCommand,agentManifest}=await import('../dist-server/server/agent-api.js');
const media=path.join(root,'data/media/room.png');fs.mkdirSync(path.dirname(media),{recursive:true});
await sharp({create:{width:64,height:64,channels:3,background:'#445577'}}).png().toFile(media);
const fileHash=createHash('sha256').update(fs.readFileSync(media)).digest('hex');

function fixture(count=1){
  const p=m.makeProject('隔离提示词管理','standard'),e=m.makeEpisode(1,'纯测试样例');p.episodes=[e];
  p.videoModel={name:'offline',modelId:'offline',adapterPath:'offline',capabilities:{maxDurationSec:30,maxReferences:30,maxPromptChars:20000,nativeAudio:true}};
  e.sourceText='人物发现屋外来客，走到门边查看来客的身影。人物确认同伴安全，伸手阻止同伴继续向门外走去。'.repeat(4);
  e.sourceReviewedHash=m.sourceHash(e);e.highlightReport='发现来客，查看身影，确认同伴安全后阻止开门，保留因果与反应。';e.highlightReviewedHash=m.highlightHash(e);
  const b={...m.makeBeat(),sourceQuote:e.sourceText,event:'人物发现屋外来客，走到门边查看来客的身影。',reaction:'人物确认同伴安全，伸手阻止同伴继续向门外走去。',dialogue:['人物：先不要开门。'],os:['人物：先看看。'],floatLabels:['场景：房间'],systemPanels:['提示：门外有人。']};
  e.scriptBeats=[b];m.lockScript(e);const s=e.segments[0];s.visualPlan='房间门边近景到中景，末帧保持伸手阻止的动作。';s.subshotsReviewed=true;s.shotContractVersion=2;
  s.subshots=s.subshots.map((shot,i)=>({...shot,evidence:i<5?b.event:b.reaction,action:(i<5?b.event:b.reaction)+`第${i+1}个执行节拍`,location:'房间',priorState:`前置状态${i+1}`,result:`可见结果${i+1}`,endFrame:`末帧状态${i+1}`,assetIds:['room'],lineRefs:{dialogue:i===0?[0]:[],os:i===2?[0]:[],floatLabels:i===1?[0]:[],systemPanels:i===3?[0]:[]}}));
  const asset={id:'room',kind:'scene',name:'房间',identity:'窗户完整，门边空间清晰的室内。',voice:'',states:[],images:[]};p.assets=[asset];
  asset.images=[{id:m.id(),role:'main',mediaPath:'room.png',fileHash,createdAt:m.now(),source:'upload',inputHash:assetInputHash(p,asset.id),review:{status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:m.now()}}];
  s.assetBindings=[{assetId:asset.id,imageId:asset.images[0].id}];
  e.segments=Array.from({length:count},(_,i)=>({...structuredClone(s),id:i?m.id():s.id,number:i+1,artifacts:[],selected:{}}));
  for(const segment of e.segments){
    const prompt={id:m.id(),kind:'prompt',createdAt:m.now(),sourceHash:m.contentHash(e,segment),content:m.composePrompt(e,segment,[],m.segmentReferences(p,e,segment),m.videoReferences(p,e,segment))};
    segment.artifacts=[prompt];segment.selected.prompt=prompt.id;
    assert.deepEqual(m.selectedPromptContractIssues(e,segment,p),[]);
  }
  e.auditApprovedHash=m.approvalHash(e);
  return{p,e,b,s:e.segments[0],prompt:e.segments[0].artifacts[0]};
}
const act=(f,input)=>applyAction(f.p,{episodeId:f.e.id,segmentId:f.s.id,...input});
const targets=f=>f.e.segments.map(s=>({segmentId:s.id,artifactId:s.selected.prompt,expectedPromptId:s.selected.prompt}));
async function wait(check){const end=Date.now()+12000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('离线编译未完成');}

test('取消选用不删正文，阻止新的视频提交，编译候选不自动选回',async()=>{
  const f=fixture(),source=m.contentHash(f.e,f.s),text=f.prompt.content;
  act(f,{type:'segment.prompt.unselect',artifactId:f.prompt.id,expectedPromptId:f.prompt.id});
  assert.equal(f.s.selected.prompt,undefined);assert.equal(f.s.promptSelectionPaused,true);assert.equal(f.prompt.content,text);
  assert.equal(m.contentHash(f.e,f.s),source);assert.equal(f.e.auditApprovedHash,undefined);
  assert.ok(m.selectedPromptContractIssues(f.e,f.s,f.p).some(issue=>issue.includes('选用提示词缺失')));
  store.insertProject(f.p);assert.throws(()=>validateGeneration(f.p.id,f.e.id,[f.s.id],['video']),/五层无损|提示词/);
  const [job]=enqueue(f.p.id,f.e.id,[f.s.id],['prompt']);await wait(()=>store.jobsFor(f.p.id).find(j=>j.id===job.id)?.status==='completed');
  const saved=store.getProject(f.p.id).episodes[0].segments[0];assert.equal(saved.selected.prompt,undefined);assert.equal(saved.artifacts.filter(a=>a.kind==='prompt').length,2);
  assert.equal(m.promptReadiness(store.getProject(f.p.id).episodes[0],saved,f.p).state,'candidate');
});

test('停用／恢复不篡改正文，已停用版不得直接选用，恢复不自动选用或放行',()=>{
  const f=fixture(),original=structuredClone(f.prompt);
  act(f,{type:'segment.prompt.archive',artifactId:f.prompt.id});const timestamp=f.prompt.promptArchive.archivedAt;
  assert.equal(m.selectedArtifact(f.s,'prompt'),undefined);assert.equal(m.promptReadiness(f.e,f.s,f.p).state,'missing');
  act(f,{type:'segment.prompt.archive',artifactId:f.prompt.id});assert.equal(f.prompt.promptArchive.archivedAt,timestamp);
  assert.throws(()=>act(f,{type:'segment.select',kind:'prompt',artifactId:f.prompt.id}),/已停用/);
  act(f,{type:'segment.prompt.restore',artifactId:f.prompt.id});assert.deepEqual(f.prompt,original);assert.equal(f.s.selected.prompt,undefined);assert.equal(f.e.auditApprovedHash,undefined);
  act(f,{type:'segment.select',kind:'prompt',artifactId:f.prompt.id});assert.equal(f.s.selected.prompt,f.prompt.id);assert.equal(f.s.promptSelectionPaused,undefined);
});

test('停用未选用旧版保留当前选版、来源签名与既有五层放行',()=>{
  const f=fixture(),old={...f.prompt,id:m.id()};f.s.artifacts.push(old);
  const signature=generationSignature(f.p,f.e,f.s),audit=f.e.auditApprovedHash;
  act(f,{type:'segment.prompt.archive',artifactId:old.id});
  assert.equal(f.s.selected.prompt,f.prompt.id);assert.equal(f.e.auditApprovedHash,audit);assert.equal(generationSignature(f.p,f.e,f.s),signature);
});

test('已验收旧片可通过停用的完整旧提示词追溯，改剧情仍失效',()=>{
  const f=fixture(),signature=generationSignature(f.p,f.e,f.s);
  const video={id:m.id(),kind:'video',mediaPath:'synthetic-record.mp4',sourceHash:f.prompt.sourceHash,generationHash:signature,createdAt:m.now(),review:{status:'approved',notes:'隔离追溯测试记录'}};
  f.s.artifacts.push(video);f.s.selected.video=video.id;
  act(f,{type:'segment.prompt.archive',artifactId:f.prompt.id});
  assert.equal(usableVideo(f.p,f.e,f.s,video),true);assert.equal(video.generationHash,signature);assert.equal(video.review.status,'approved');assert.equal(f.s.selected.video,video.id);
  f.s.visualPlan+='正式输入改变';assert.equal(usableVideo(f.p,f.e,f.s,video),false);
});

test('52项旧版可原子停用并恢复历史，实际未改生产项目',()=>{
  const f=fixture(52),entries=targets(f),texts=f.e.segments.map(s=>s.artifacts[0].content);
  act(f,{type:'episode.prompts.manage',operation:'archive',entries});
  assert.equal(f.e.segments.filter(s=>s.artifacts[0].promptArchive).length,52);
  assert.ok(f.e.segments.every(s=>!s.selected.prompt&&s.promptSelectionPaused));
  act(f,{type:'episode.prompts.manage',operation:'restore',entries:entries.map(({segmentId,artifactId})=>({segmentId,artifactId}))});
  assert.equal(f.e.segments.filter(s=>s.artifacts[0].promptArchive).length,0);assert.deepEqual(f.e.segments.map(s=>s.artifacts[0].content),texts);assert.ok(f.e.segments.every(s=>!s.selected.prompt));
});

test('批量目标缺失、跨分集或重复时整批不改',()=>{
  const f=fixture(2),entries=targets(f),snapshot=JSON.stringify(f.p);
  for(const bad of [[entries[0],{segmentId:'foreign',artifactId:'foreign'}],[entries[0],{...entries[1],artifactId:'missing'}],[entries[0],entries[0]]]){
    assert.throws(()=>act(f,{type:'episode.prompts.manage',operation:'archive',entries:bad}));assert.equal(JSON.stringify(f.p),snapshot);
  }
});

test('批量换选后按需停用原选版，仅重置本集核对，全部历史可追溯',()=>{
  const f=fixture(2),originals=f.e.segments.map(s=>s.artifacts[0]);
  const entries=f.e.segments.map(s=>{const next={...s.artifacts[0],id:m.id()};s.artifacts.push(next);return{segmentId:s.id,artifactId:next.id,expectedPromptId:s.selected.prompt};});
  act(f,{type:'episode.prompts.manage',operation:'select',archivePrevious:true,entries});
  assert.ok(originals.every(a=>a.promptArchive));assert.deepEqual(f.e.segments.map(s=>s.selected.prompt),entries.map(e=>e.artifactId));assert.equal(f.e.auditApprovedHash,undefined);
});

test('批量选用中正文不合格或同段勾选两版，整批不改',()=>{
  const f=fixture(2),first=f.e.segments[0],second=f.e.segments[1],good={...first.artifacts[0],id:m.id()},bad={...second.artifacts[0],id:m.id(),content:'删掉正式信息的错误稿'};
  first.artifacts.push(good);second.artifacts.push(bad);const snapshot=JSON.stringify(f.p);
  assert.throws(()=>act(f,{type:'episode.prompts.manage',operation:'select',archivePrevious:true,entries:[{segmentId:first.id,artifactId:good.id},{segmentId:second.id,artifactId:bad.id}]}));assert.equal(JSON.stringify(f.p),snapshot);
  assert.throws(()=>act(f,{type:'episode.prompts.manage',operation:'select',entries:[{segmentId:first.id,artifactId:good.id},{segmentId:first.id,artifactId:first.selected.prompt}]}),/同一片段/);assert.equal(JSON.stringify(f.p),snapshot);
});

test('写入新版可停用原版，正式全文受校验，重试不会重复写入',()=>{
  const f=fixture(),original=f.prompt,content=f.prompt.content;
  act(f,{type:'segment.writePrompt',content,archivePrevious:true,expectedPromptId:original.id});
  const latest=m.selectedArtifact(f.s,'prompt');assert.notEqual(latest.id,original.id);assert.equal(latest.content,content);assert.ok(original.promptArchive);assert.equal(original.content,content);
  const snapshot=JSON.stringify(f.p);assert.throws(()=>act(f,{type:'segment.writePrompt',content,archivePrevious:true,expectedPromptId:original.id}),/已变化/);assert.equal(JSON.stringify(f.p),snapshot);
  assert.throws(()=>act(f,{type:'segment.writePrompt',content:content.replace(f.b.floatLabels[0],''),expectedPromptId:latest.id}),/遗漏/);assert.equal(JSON.stringify(f.p),snapshot);
});

test('批量写入52项新版可一次完成，原选版留作停用来源',()=>{
  const f=fixture(52),oldIds=f.e.segments.map(s=>s.selected.prompt);
  const entries=f.e.segments.map(s=>({segmentId:s.id,content:s.artifacts[0].content,expectedPromptId:s.selected.prompt}));
  act(f,{type:'episode.prompts.manage',operation:'replace',archivePrevious:true,entries});
  assert.ok(f.e.segments.every((s,i)=>s.artifacts.length===2&&s.artifacts[0].promptArchive&&s.selected.prompt!==oldIds[i]));
  assert.deepEqual(f.e.segments.map(s=>m.selectedArtifact(s,'prompt').content),entries.map(e=>e.content));
});

test('批量写入任一项漏OS／浮签或选版快照过期时不落任何新版',()=>{
  const f=fixture(2),entries=f.e.segments.map(s=>({segmentId:s.id,content:s.artifacts[0].content,expectedPromptId:s.selected.prompt})),snapshot=JSON.stringify(f.p);
  assert.throws(()=>act(f,{type:'episode.prompts.manage',operation:'replace',archivePrevious:true,entries:[entries[0],{...entries[1],content:'漏项稿'}]}));assert.equal(JSON.stringify(f.p),snapshot);
  assert.throws(()=>act(f,{type:'episode.prompts.manage',operation:'replace',archivePrevious:true,entries:[entries[0],{...entries[1],expectedPromptId:'wrong'}]}),/已变化/);assert.equal(JSON.stringify(f.p),snapshot);
});

test('存储和分集摘要保留停用状态，历史正文仍可读取',()=>{
  const f=fixture();act(f,{type:'segment.prompt.archive',artifactId:f.prompt.id});const other=m.makeEpisode(2,'摘要');f.p.episodes.push(other);store.insertProject(f.p);
  const full=store.getProject(f.p.id).episodes[0].segments[0];assert.ok(full.artifacts[0].promptArchive);assert.equal(full.artifacts[0].content,f.prompt.content);
  const summary=store.getProjectView(f.p.id,other.id).episodes[0].segments[0];assert.ok(summary.artifacts[0].promptArchive);
});

test('外部Agent可发现管理接口，稳定请求ID重放不重复追加新版',async()=>{
  const f=fixture();store.insertProject(f.p);
  for(const action of ['segment.prompt.archive','segment.prompt.restore','segment.prompt.unselect','episode.prompts.manage'])assert.ok(agentManifest().actions.includes(action));
  const input={command:'action',requestId:m.id(),expectedHash:m.digest(store.getProject(f.p.id)),action:{type:'episode.prompts.manage',episodeId:f.e.id,operation:'replace',archivePrevious:true,entries:[{segmentId:f.s.id,content:f.prompt.content,expectedPromptId:f.prompt.id}]}};
  await agentCommand(f.p.id,input);const saved=store.getProject(f.p.id);assert.equal(saved.episodes[0].segments[0].artifacts.length,2);
  assert.equal((await agentCommand(f.p.id,input)).replayed,true);assert.equal(store.getProject(f.p.id).episodes[0].segments[0].artifacts.length,2);
});
