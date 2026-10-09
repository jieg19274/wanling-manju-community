import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'manju-prompt-compat-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');
process.env.MANJU_BACKUP_DIR=path.join(root,'backups');
delete process.env.MANJU_BATCH_BUDGET_PROFILE;
const m=await import('../dist-server/shared/model.js');
const store=await import('../dist-server/server/store.js');
const {applyAction}=await import('../dist-server/server/actions.js');
const {assetInputHash,generationSignature,currentVideo,usableVideo}=await import('../dist-server/shared/generation.js');
const {screenTextBoundary,speechTextBoundary,characterReferenceBoundary}=await import('../dist-server/shared/prompt-contract.js');
const {validateGeneration}=await import('../dist-server/server/jobs.js');
const {candidatePreview}=await import('../dist-server/server/candidates.js');
const {preparedVideoPrompt}=await import('../dist-server/server/video-prompt.js');
const {exportProductionPackage}=await import('../dist-server/server/production-package.js');
const {startWorkflow,advanceWorkflow,getWorkflow}=await import('../dist-server/server/agent-workflow.js');
const {videoPromptWithAcceptedFallbacks}=await import('../adapters/video-reference-fallback.mjs');
const media=path.join(root,'data/media/room.png');fs.mkdirSync(path.dirname(media),{recursive:true});
await sharp({create:{width:96,height:64,channels:3,background:'#304050'}}).png().toFile(media);
const fileHash=createHash('sha256').update(fs.readFileSync(media)).digest('hex');
function fixture(){
  const p=m.makeProject('本地提示词回归','standard'),e=m.makeEpisode(1,'隔离样例');p.episodes=[e];
  p.videoModel={name:'本地模拟',modelId:'offline-compat',adapterPath:path.resolve('tests/fixtures/video-adapter.mjs'),capabilities:{maxDurationSec:30,maxReferences:30,maxPromptChars:20000,nativeAudio:true}};
  e.sourceText='人物发现屋外来客，走到门边查看来客的身影。人物确认同伴安全，伸手阻止同伴继续向门外走去。'.repeat(4);
  e.sourceReviewedHash=m.sourceHash(e);e.highlightReport='发现来客，查看身影，确认同伴安全后阻止开门，保留因果与反应。';e.highlightReviewedHash=m.highlightHash(e);
  const b={...m.makeBeat(),sourceQuote:e.sourceText,event:'人物发现屋外来客，走到门边查看来客的身影。',reaction:'人物确认同伴安全，伸手阻止同伴继续向门外走去。',dialogue:['人物：先不要开门。'],os:['人物：先看看。'],floatLabels:['场景：房间'],systemPanels:['提示：门外有人。']};
  e.scriptBeats=[b];m.lockScript(e);const s=e.segments[0];s.visualPlan='房间门边近景到中景，末帧保持伸手阻止的动作。';s.subshotsReviewed=true;s.shotContractVersion=2;
  s.subshots=s.subshots.map((shot,i)=>({...shot,evidence:i<5?b.event:b.reaction,action:(i<5?b.event:b.reaction)+`第${i+1}个执行节拍`,location:'房间',priorState:`前置状态${i+1}`,result:`可见结果${i+1}`,endFrame:`末帧状态${i+1}`,assetIds:['room'],lineRefs:{dialogue:i===0?[0]:[],os:i===2?[0]:[],floatLabels:i===1?[0]:[],systemPanels:i===3?[0]:[]}}));
  const asset={id:'room',kind:'scene',name:'房间',identity:'窗户完整，门边空间清晰的室内。',voice:'',states:[],images:[]};p.assets=[asset];
  asset.images=[{id:m.id(),role:'main',mediaPath:'room.png',fileHash,createdAt:m.now(),source:'upload',inputHash:assetInputHash(p,asset.id),review:{status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:m.now()}}];
  s.assetBindings=[{assetId:asset.id,imageId:asset.images[0].id}];
  const content=m.composePrompt(e,s,[],m.segmentReferences(p,e,s),m.videoReferences(p,e,s));
  const prompt={id:m.id(),kind:'prompt',createdAt:m.now(),sourceHash:m.contentHash(e,s),content};s.artifacts=[prompt];s.selected.prompt=prompt.id;
  assert.deepEqual(m.auditEpisode(e,p),[]);e.auditApprovedHash=m.approvalHash(e);
  return{p,e,s,b,prompt,asset};
}
const act=(f,input)=>applyAction(f.p,{episodeId:f.e.id,segmentId:f.s.id,...input});
const promptIssues=f=>m.selectedPromptContractIssues(f.e,f.s,f.p);
function edited(f,content){return {...f.s,artifacts:[...f.s.artifacts,{...f.prompt,id:'edited',content}],selected:{...f.s.selected,prompt:'edited'}};}
async function wait(check){const end=Date.now()+12000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.fail('local workflow timed out');}

test('wording/formatting and historical template versions stay compatible without rewriting',()=>{
  const f=fixture();f.prompt.content=f.prompt.content.replace(screenTextBoundary(),screenTextBoundary().replace('叠加文字仅允许','屏幕叠加文字只能使用')).replace(speechTextBoundary(f.b),speechTextBoundary(f.b).replace('本段仅有','本片段包含')).replace(characterReferenceBoundary(),characterReferenceBoundary().replace('共同锁定','共同确定'));
  f.prompt.content=f.prompt.content.replace('【屏幕文字边界】','【文字执行规则】').replace('【可发声文本边界】','【正式声音规则】').replace('【逐镜参考范围】','【附件作用范围】').replace('【参考图使用】','【完整参考执行规则】');
  f.prompt.promptTemplateVersion='2025-01';const before=JSON.stringify(f.prompt);
  assert.deepEqual(promptIssues(f),[]);assert.deepEqual(m.auditEpisode(f.e,f.p),[]);assert.equal(m.promptReadiness(f.e,f.s,f.p).state,'ready');assert.equal(JSON.stringify(f.prompt),before);
  act(f,{type:'audit.approve'});store.insertProject(f.p);validateGeneration(f.p.id,f.e.id,[f.s.id],['video']);
  assert.ok(fs.existsSync(exportProductionPackage(f.p.id,f.e.id).folder));
});

test('missing required policies fail write, select, audit, export and video preview consistently',()=>{
  const f=fixture(),content=f.prompt.content.replace(screenTextBoundary(),'');
  const missingBan=f.prompt.content.replace(screenTextBoundary(),'【屏幕文字边界】仅允许正式浮签和系统文字。对白字幕、OS字幕正常生成。禁止镜头编号。');
  assert.ok(m.selectedPromptContractIssues(f.e,edited(f,missingBan),f.p).some(x=>x.includes('屏幕文字边界')));
  const narrator=f.prompt.content.replace(speechTextBoundary(f.b),'【可发声文本边界】对白和内心OS正常说出。新增解说、旁白。动作不得朗读。');
  assert.ok(m.selectedPromptContractIssues(f.e,edited(f,narrator),f.p).some(x=>x.includes('可发声文本边界')));
  assert.throws(()=>act(f,{type:'segment.writePrompt',content}),/屏幕文字边界/);
  const old={...f.prompt,id:'old-missing',content};f.s.artifacts.push(old);
  assert.throws(()=>act(f,{type:'segment.select',kind:'prompt',artifactId:old.id}),/屏幕文字边界/);
  f.s.selected.prompt=old.id;f.e.auditApprovedHash=m.approvalHash(f.e);store.insertProject(f.p);
  assert.ok(m.auditEpisode(f.e,f.p).some(x=>x.includes('屏幕文字边界')));
  assert.throws(()=>act(f,{type:'audit.approve'}),/屏幕文字边界/);
  assert.throws(()=>exportProductionPackage(f.p.id,f.e.id),/屏幕文字边界/);
  assert.throws(()=>validateGeneration(f.p.id,f.e.id,[f.s.id],['video']),/屏幕文字边界/);
  assert.throws(()=>candidatePreview(f.p.id,{kind:'video',count:1,episodeId:f.e.id,segmentId:f.s.id}),/屏幕文字边界/);
});

test('text present somewhere cannot conceal reordered shots, altered times, wrong speaker slots or references',()=>{
  const f=fixture(),blocks=[...f.prompt.content.matchAll(/### 子镜\d+｜[^]*?(?=### 子镜\d+｜|【场景锚点】)/gu)].map(x=>x[0]);
  const order=f.prompt.content.replace(blocks[1],'__BLOCK__').replace(blocks[2],blocks[1]).replace('__BLOCK__',blocks[2]);
  const variants=[order,f.prompt.content.replace('子镜1｜0–2秒','子镜1｜20–22秒'),f.prompt.content.replace('【参考资产】房间','【参考资产】无')];
  variants.push(f.prompt.content.replace('【对白】'+f.b.dialogue[0],'【对白】'+f.b.dialogue[0]+'；人物：现在可以开门了。'));
  variants.push(f.prompt.content.replace('【系统信息】'+f.b.systemPanels[0],'【系统信息】'+f.b.systemPanels[0]+'、额外提示：任务完成'));
  variants.push(f.prompt.content.replace('【浮签】无','【浮签】错误身份'));
  const misplaced=f.prompt.content.replace('【对白】'+f.b.dialogue[0],'【对白】无').replace('【对白】无（此窗口没有新台词或跨镜续说）','【对白】'+f.b.dialogue[0]);variants.push(misplaced);
  const wrongLabel=f.prompt.content.replace('【系统信息】'+f.b.systemPanels[0],'【系统信息】无').replace('【系统信息】无','【系统信息】'+f.b.systemPanels[0]);variants.push(wrongLabel);
  for(const content of variants){
    assert.ok(m.selectedPromptContractIssues(f.e,edited(f,content),f.p).length);
    assert.throws(()=>act(f,{type:'segment.writePrompt',content}),/提示词正文/);
    const snapshot=JSON.stringify(f.s.artifacts);assert.equal(f.s.selected.prompt,f.prompt.id);assert.equal(JSON.stringify(f.s.artifacts),snapshot);
  }
});

test('explicit voice table cannot silently change the approved onset/window',()=>{
  const f=fixture();f.s.speechPlan=[{kind:'dialogue',index:0,startSec:.2,endSec:1.95},{kind:'os',index:0,startSec:6.8,endSec:8.5}];
  f.prompt.sourceHash=m.contentHash(f.e,f.s);f.prompt.content=m.composePrompt(f.e,f.s,[],m.segmentReferences(f.p,f.e,f.s),m.videoReferences(f.p,f.e,f.s));
  assert.deepEqual(promptIssues(f),[]);
  const content=f.prompt.content.replace('0.2–1.95秒','1.2–1.95秒');assert.throws(()=>act(f,{type:'segment.writePrompt',content}),/声音时序/);
});

test('compact prompts may reference complete voice/visible tables without copying lines into every shot',()=>{
  const f=fixture();f.s.speechPlan=[{kind:'dialogue',index:0,startSec:.2,endSec:1.95},{kind:'os',index:0,startSec:6.8,endSec:8.5}];
  f.prompt.sourceHash=m.contentHash(f.e,f.s);f.prompt.content=m.composePrompt(f.e,f.s,[],m.segmentReferences(f.p,f.e,f.s),m.videoReferences(f.p,f.e,f.s));
  f.prompt.content=f.prompt.content.replace('【对白】'+f.b.dialogue[0],'对白起句：D1，全文与精确时窗见上表。')
    .replace('【内心OS】'+f.b.os[0],'OS起句：O1，全文与精确时窗见上表。')
    .replace('【浮签】'+f.b.floatLabels[0],'可见信息起点：F1。').replace('【系统信息】'+f.b.systemPanels[0],'可见信息起点：S1。')
    .replace('【禁止】',`F1｜目标全文「${f.b.floatLabels[0]}」｜模型直出｜2–6.667秒\nS1｜目标全文「${f.b.systemPanels[0]}」｜模型直出｜11.333–16秒\n【禁止】`);
  assert.deepEqual(promptIssues(f),[]);assert.deepEqual(m.auditEpisode(f.e,f.p),[]);
  const formatted=f.prompt.content.replaceAll('【参考资产】房间','参考： 房间  ');
  assert.deepEqual(m.selectedPromptContractIssues(f.e,edited(f,formatted),f.p),[]);
  const invalidRef=f.prompt.content.replace('可见信息起点：F1。','可见信息起点：F1、F2。');
  assert.ok(m.selectedPromptContractIssues(f.e,edited(f,invalidRef),f.p).some(x=>x.includes('浮签')));
  const bad=f.prompt.content.replace('F1｜目标全文「'+f.b.floatLabels[0]+'」','F1｜目标全文「错误场景文字」');
  assert.ok(m.selectedPromptContractIssues(f.e,edited(f,bad),f.p).some(x=>x.includes('浮签')));
});

test('an approved film survives prompt-only selection; pending/rejected films and changed production input do not',()=>{
  const f=fixture(),video={id:'approved-film',kind:'video',createdAt:m.now(),sourceHash:m.contentHash(f.e,f.s),generationHash:generationSignature(f.p,f.e,f.s),referenceHashes:[{imageId:f.asset.images[0].id,hash:fileHash}],mediaPath:'reviewed.mp4',review:{status:'approved',notes:'已核对剧情声音与资产',reviewedAt:m.now()}};
  f.s.artifacts.push(video);const original=JSON.stringify(video),generationHash=video.generationHash;
  act(f,{type:'segment.writePrompt',content:f.prompt.content.replace('严格按本段子镜时间顺序生成','完整遵照本段子镜时间顺序生成')});
  assert.equal(currentVideo(f.p,f.e,f.s,video),false);assert.equal(usableVideo(f.p,f.e,f.s,video),true);
  act(f,{type:'segment.select',kind:'video',artifactId:video.id});assert.equal(f.s.selected.video,video.id);assert.equal(video.generationHash,generationHash);assert.equal(JSON.stringify(video),original);
  for(const review of [undefined,{...video.review,status:'rejected'}])assert.equal(usableVideo(f.p,f.e,f.s,{...video,review}),false);
  const changed=structuredClone(f.p);changed.episodes[0].segments[0].subshots[0].result+='新的正式结果';assert.equal(usableVideo(changed,changed.episodes[0],changed.episodes[0].segments[0],video),false);
  const refs=structuredClone(f.p);refs.assets[0].images[0].fileHash='c'.repeat(64);assert.equal(usableVideo(refs,refs.episodes[0],refs.episodes[0].segments[0],video),false);
});

test('a successful local recompile guides selection, preserves old choice and never submits a video',async()=>{
  const f=fixture();f.prompt.sourceHash='stale';f.e.auditApprovedHash=undefined;store.insertProject(f.p);
  const flow=startWorkflow(f.p.id,{episodeId:f.e.id,delivery:'package',limits:{text:0,image:0,video:0}});assert.equal(flow.step.task,'prompts');
  await wait(()=>{const row=getWorkflow(f.p.id,flow.id).history.at(-1);return row?.jobIds?.length&&row.jobIds.every(id=>store.jobById(id)?.status==='completed');});
  const advanced=await advanceWorkflow(f.p.id,flow.id),saved=store.getProject(f.p.id),e=saved.episodes[0],s=e.segments[0];
  assert.equal(advanced.step.label,'核对并选用新提示词');assert.doesNotMatch(advanced.step.message,/失败/);assert.equal(s.selected.prompt,f.prompt.id);assert.equal(m.promptReadiness(e,s,saved).state,'candidate');
  assert.equal(store.db.prepare("SELECT count(*) n FROM jobs WHERE project_id=? AND kind='video'").get(f.p.id).n,0);
});

test('generating an optional new prompt does not clear approval when the selected compatible prompt is unchanged',async()=>{
  const f=fixture();store.insertProject(f.p);const {enqueue}=await import('../dist-server/server/jobs.js');
  const [job]=enqueue(f.p.id,f.e.id,[f.s.id],['prompt'],{regenerate:true});await wait(()=>store.jobById(job.id)?.status==='completed');
  const saved=store.getProject(f.p.id);assert.equal(saved.episodes[0].auditApprovedHash,f.e.auditApprovedHash);assert.equal(saved.episodes[0].segments[0].selected.prompt,f.prompt.id);
});

test('saved progress guides review/selection when a fresh candidate already exists',async()=>{
  const f=fixture(),{summarizeProjectProgress}=await import('../dist-server/shared/project-progress.js');
  const fresh={...structuredClone(f.prompt),id:'fresh-candidate'};f.prompt.sourceHash='stale';f.s.artifacts.push(fresh);f.e.auditApprovedHash=undefined;
  const before=JSON.stringify(f.p),progress=summarizeProjectProgress(f.p,()=>true);
  assert.equal(progress.episodes[0].next.package.label,'核对并选用新提示词');assert.match(progress.episodes[0].next.package.message,/无需重复生成/);assert.equal(JSON.stringify(f.p),before);
});

test('fallback corrections are identical in export, preview and provider input; adapter does not append twice',()=>{
  const f=fixture(),original=f.asset.images[0],correction='本地修正：当前窗户必须完整，不能复制旧图破窗。';
  const accepted={...structuredClone(original),id:'accepted-reference',referenceAcceptance:{status:'accepted',statement:'本地测试确认沿用旧图',acceptedAt:m.now(),sourceImageId:original.id,sourceFileHash:fileHash,acceptedInputHash:assetInputHash(f.p,f.asset.id),knownDifference:'旧图破窗，当前窗户完整。',requiredVideoCorrection:correction}};
  f.asset.images.push(accepted);f.s.assetBindings[0].imageId=accepted.id;f.prompt.sourceHash=m.contentHash(f.e,f.s);f.e.auditApprovedHash=m.approvalHash(f.e);store.insertProject(f.p);
  const prepared=preparedVideoPrompt(f.p,f.e,f.s),preview=candidatePreview(f.p.id,{kind:'video',count:1,episodeId:f.e.id,segmentId:f.s.id});
  const folder=exportProductionPackage(f.p.id,f.e.id).folder,exported=fs.readFileSync(path.join(folder,'片段001/最终视频提示词.txt'),'utf8');
  assert.equal(exported,prepared.content);assert.equal(preview.summary.prompt,exported);assert.equal(preview.summary.promptHash,prepared.hash);
  const references=m.videoReferences(f.p,f.e,f.s);assert.equal(videoPromptWithAcceptedFallbacks({prompt:prepared.content,promptFormat:prepared.format,promptHash:prepared.hash,references}),prepared.content);
  assert.ok(exported.includes(correction));assert.ok(fs.readFileSync(path.join(folder,'片段001/参考图顺序.json'),'utf8').includes(correction));
  assert.ok(exported.slice(0,400).includes('严格按本段子镜时间顺序生成'));
  assert.throws(()=>videoPromptWithAcceptedFallbacks({prompt:prepared.content+'tampered',promptFormat:prepared.format,promptHash:prepared.hash,references}),/哈希/);
  store.updateProject(f.p.id,p=>{p.videoModel.capabilities.maxPromptChars=[...f.prompt.content].length+1;});
  assert.throws(()=>candidatePreview(f.p.id,{kind:'video',count:1,episodeId:f.e.id,segmentId:f.s.id}),/完整提交提示词/);
  assert.equal(store.db.prepare("SELECT count(*) n FROM jobs WHERE project_id=? AND kind='video'").get(f.p.id).n,0);
});

test('visual feedback length is checked before submission, including the final prompt rather than the base',()=>{
  const f=fixture();f.p.videoModel.capabilities.maxPromptChars=[...f.prompt.content].length+10;store.insertProject(f.p);
  assert.throws(()=>candidatePreview(f.p.id,{kind:'video',count:1,episodeId:f.e.id,segmentId:f.s.id,feedback:'镜头光线柔和一些，增加景深。'}),/完整提交提示词/);
});

test('a local mock job freezes the preview text/hash and recovery validates the same complete request',async()=>{
  const f=fixture(),original=f.asset.images[0];
  const accepted={...structuredClone(original),id:'job-fallback',referenceAcceptance:{status:'accepted',statement:'本地模拟任务沿用旧图',acceptedAt:m.now(),sourceImageId:original.id,sourceFileHash:fileHash,acceptedInputHash:assetInputHash(f.p,f.asset.id),knownDifference:'旧图窗户破损。',requiredVideoCorrection:'当前窗户完整，只按正式分镜执行。'}};
  f.asset.images.push(accepted);f.s.assetBindings[0].imageId=accepted.id;f.prompt.sourceHash=m.contentHash(f.e,f.s);f.e.auditApprovedHash=m.approvalHash(f.e);store.insertProject(f.p);
  const feedback='光线柔和一些',prepared=preparedVideoPrompt(f.p,f.e,f.s,feedback),preview=candidatePreview(f.p.id,{kind:'video',count:1,episodeId:f.e.id,segmentId:f.s.id,feedback});
  const {enqueue,validateRecoveryRequest}=await import('../dist-server/server/jobs.js');
  const [job]=enqueue(f.p.id,f.e.id,[f.s.id],['video'],{candidate:{batchId:'local-compat-mock',candidateId:m.id(),keepSelection:true,feedback}});
  await wait(()=>['completed','failed'].includes(store.jobById(job.id)?.status));assert.equal(store.jobById(job.id).status,'completed',store.jobById(job.id).error);
  const request=JSON.parse(fs.readFileSync(path.join(root,'data/media/generated',f.e.id,f.s.id,job.id+'.json'),'utf8'));
  assert.equal(request.prompt,preview.summary.prompt);assert.equal(request.prompt,prepared.content);assert.equal(request.promptHash,prepared.hash);
  assert.equal(store.generationSpec(f.p.id,job.id).preparedPrompt.content,request.prompt);
  assert.doesNotThrow(()=>validateRecoveryRequest(store.jobById(job.id),request));
  assert.throws(()=>validateRecoveryRequest(store.jobById(job.id),{...request,prompt:request.prompt+'改写'}),/不可变生成spec/);
  const video=store.getProject(f.p.id).episodes[0].segments[0].artifacts.find(a=>a.jobId===job.id);assert.equal(video.modelPromptHash,prepared.hash);assert.equal(video.review,undefined);
});

test('recovery honors historical frozen model text across template updates and supports legacy unmarked requests',async()=>{
  const f=fixture(),{sha256}=await import('../dist-server/shared/hash.js'),{validateRecoveryRequest}=await import('../dist-server/server/jobs.js');
  const {referenceHashes}=await import('../dist-server/server/reference-provenance.js');
  const originalText=f.prompt.content+'\n【历史通用说明】按原有正式子镜执行。';
  const historical={content:originalText,hash:sha256(originalText),characters:[...originalText].length,format:'model-ready-v1'};
  const snapshot={project:f.p,hash:generationSignature(f.p,f.e,f.s),references:referenceHashes(f.p,f.e,f.s),preparedPrompt:historical};
  const job={id:m.id(),project_id:f.p.id,episode_id:f.e.id,segment_id:f.s.id,kind:'video',status:'failed'};
  store.registerGenerationSpec(job.id,f.p.id,snapshot);
  const request={generationHash:snapshot.hash,referenceHashes:snapshot.references,prompt:historical.content,promptHash:historical.hash,promptFormat:historical.format,durationSec:30,episodeId:f.e.id,segmentId:f.s.id,aspectRatio:f.p.aspectRatio||'16:9',model:{id:f.p.videoModel.modelId,capabilities:f.p.videoModel.capabilities}};
  assert.notEqual(preparedVideoPrompt(f.p,f.e,f.s).content,request.prompt);
  assert.doesNotThrow(()=>validateRecoveryRequest(job,request));
  const {promptFormat,...stripped}=request;assert.throws(()=>validateRecoveryRequest(job,stripped),/不可变/);
  const legacyJob={...job,id:m.id()},legacySnapshot={...snapshot};delete legacySnapshot.preparedPrompt;store.registerGenerationSpec(legacyJob.id,f.p.id,legacySnapshot);
  const legacy={...request,prompt:f.prompt.content};delete legacy.promptHash;delete legacy.promptFormat;
  assert.doesNotThrow(()=>validateRecoveryRequest(legacyJob,legacy));
});
