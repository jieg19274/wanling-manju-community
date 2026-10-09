import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync,statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../dist-server/shared/hash.js';
import * as model from '../dist-server/shared/model.js';
import { currentVideo, generationSignature, assetInputHash, invalidateAsset } from '../dist-server/shared/generation.js';
import { storyUnits, applySegmentation, segmentationIssues, automaticSegmentGroups, orderedSpeech } from '../dist-server/shared/segmentation.js';
import { validateGeneratedMedia } from '../dist-server/shared/media-contract.js';
import { speechChecklist, validateSpeechEvidence } from '../dist-server/shared/speech-contract.js';
import { storyBatches } from '../dist-server/shared/episode-plan.js';
import {fitSummaryBudget} from '../dist-server/shared/summary-budget.js';
import {highlightItems,storyReviewHash,recordStoryReview,recordContinuityReview,boundaryHash} from '../dist-server/shared/story-review.js';
import {declaredCapabilities} from '../dist-server/shared/provider-capabilities.js';
import {analysisBudget} from '../dist-server/shared/analysis-budget.js';
import {storyIndex} from '../dist-server/shared/story-index.js';
import {validateSegmentPlan} from '../dist-server/shared/segmentation.js';

test('model planning budgets never delete source units, overrun speech or conceal underfilled segments',()=>{
  const episode=model.makeEpisode(1,'规划');episode.scriptBeats=[{...model.makeBeat(),event:'原有事件',reaction:'原有人物反应',dialogue:['甲：完整台词']}];
  const groups=[storyUnits(episode).map(unit=>unit.id)];
  const full={spokenSec:10,actionSec:12,reactionSec:6,notes:'严格依据原有事件动作和人物反应安排'};
  assert.equal(validateSegmentPlan(episode,groups,[full]).warnings.length,0);
  assert.equal(validateSegmentPlan(episode,groups,[{...full,actionSec:1,reactionSec:1}]).warnings.length,1);
  assert.throws(()=>validateSegmentPlan(episode,groups,[{...full,spokenSec:0}]),/声音预算/);
  assert.throws(()=>validateSegmentPlan(episode,groups,[{...full,actionSec:30}]),/30秒/);
  assert.throws(()=>validateSegmentPlan(episode,[groups[0].slice(1)],[full]),/完整覆盖/);
});
test('book event index keeps original source anchors and rejects invented characters and evidence',()=>{
  const source='原文里甲走进房间，乙在门边回应。';
  const raw=[{sourceStart:0,sourceEnd:source.length,sourceQuote:'甲走进房间',summary:'甲进入房间后乙在门边回应因果',characters:['甲','乙']}];
  const result=storyIndex(source,0,source.length,raw);
  assert.equal(result[0].sourceStart,0);assert.equal(result[0].id,storyIndex(source,0,source.length,raw)[0].id);
  assert.throws(()=>storyIndex(source,0,source.length,[{...raw[0],characters:['不存在人物']}]),/人物/);
  assert.throws(()=>storyIndex(source,0,source.length,[{...raw[0],sourceQuote:'假事件'}]),/逐字/);
});

test('stable highlight identities require explicit coverage and invalidate reviewed semantics on changes',()=>{
  const episode=model.makeEpisode(1,'高光');episode.sourceText='原文事件依据'.repeat(20);episode.scriptBeats=[{...model.makeBeat(),sourceQuote:'原文事件依据',event:'事件发生',reaction:'人物回应'}];
  episode.highlightItems=highlightItems('关键行动\n人物反应');
  assert.deepEqual(highlightItems('人物反应\n关键行动').map(item=>item.id).sort(),episode.highlightItems.map(item=>item.id).sort());
  const entry={beatId:episode.scriptBeats[0].id,sourceStart:0,sourceEnd:episode.sourceText.length,notes:'逐项原文因果与人物反应对应记录',checks:{highlight:true,event:true,reaction:true,speech:true,labels:true}};
  assert.throws(()=>recordStoryReview(episode,[entry]),/逐条/);
  recordStoryReview(episode,[{...entry,highlightIds:episode.highlightItems.map(item=>item.id)}]);
  const hash=episode.storyReview.hash;
  episode.highlightItems[0].text='改过的高光';assert.notEqual(storyReviewHash(episode),hash);
});
test('each adjacency needs its own checked evidence and changed terminal frames invalidate it',()=>{
  const episode=model.makeEpisode(1,'边界'),beat={...model.makeBeat(),event:'事件发生',reaction:'人物回应'};
  const left=model.makeSegment(beat,1);left.subshots=model.defaultSubshots(beat,30);const right={...structuredClone(left),id:model.id(),number:2};episode.segments=[left,right];
  const entry={left:left.id,right:right.id,notes:'空间人物状态与前后末帧已逐项核对',checks:{space:true,state:true,frame:true}};
  assert.throws(()=>recordContinuityReview(episode,[]),/每对/);
  assert.throws(()=>recordContinuityReview(episode,[{...entry,right:left.id}]),/边界证据/);
  recordContinuityReview(episode,[entry]);const hash=episode.continuityReview.hash;
  left.subshots.at(-1).endFrame='新末帧状态';assert.notEqual(boundaryHash(episode),hash);
});
test('declared capabilities preserve explicit false, reject contradictions and never infer native speech from model names',()=>{
  const caps=declaredCapabilities({capabilities:{duration:{min_seconds:5,max_seconds:30,fixed_seconds:30},references:{max_image_urls:8,supports_audio:false,supports_video:true},native_audio:false,resolutions:['1920x1080','bad'],aspect_ratio:{allowed:['9:16','invalid']}}});
  assert.equal(caps.nativeAudio,false);assert.equal(caps.referenceAudio,false);assert.equal(caps.referenceVideo,true);assert.equal(caps.fixedDurationSec,30);
  assert.deepEqual(caps.resolutions,['1920x1080']);assert.deepEqual(caps.aspectRatios,['9:16']);
  assert.equal(declaredCapabilities({id:'native-audio-model'}),undefined);
  assert.throws(()=>declaredCapabilities({minDurationSec:60,maxDurationSec:30}),/矛盾/);
  assert.throws(()=>model.modelSegmentDuration({}, {capabilities:{minDurationSec:60,maxDurationSec:120}}),/30秒/);
});
test('budget preview covers all source and confirmation changes with source or model',()=>{
  const source='第1章 原文\n'+'连续剧情'.repeat(10000),budget=analysisBudget(source,'adapter','model');
  assert.equal(budget.batches.map(batch=>source.slice(batch.start,batch.end)).join(''),source);
  assert.notEqual(analysisBudget(source+'新','adapter','model').hash,budget.hash);
  assert.notEqual(analysisBudget(source,'adapter','other').hash,budget.hash);
  assert.equal(budget.priceKnown,false);
});

test('recursive global summaries preserve contiguous original range anchors and fail closed on invalid compression',async()=>{
  const summaries=Array.from({length:100},(_,i)=>({start:i*100,end:(i+1)*100,summary:'完整事件因果'.repeat(250)}));
  const result=await fitSummaryBudget(summaries,1000,async items=>items.map(item=>`${item.start}-${item.end}:关键事件`).join(';'));
  assert.equal(result[0].start,0);assert.equal(result.at(-1).end,10000);
  assert.ok(result.every((item,i)=>i===0 || item.start===result[i-1].end));
  assert.ok(JSON.stringify(result).length<19000);
  await assert.rejects(fitSummaryBudget(summaries,1000,async()=>''),/无效/);
});

const folder = mkdtempSync(path.join(os.tmpdir(),'manju-architecture-'));

test('automatic planning reserves visual budget, preserves every unit and rejects an indivisible long line', () => {
  const episode = model.makeEpisode(1, '预算');
  episode.scriptBeats = Array.from({length: 6}, () => ({...model.makeBeat(), event:'走进房间', reaction:'停下回望', dialogue:['角色：这是必须完整保留的原始对白。']}));
  const expected = storyUnits(episode).map(unit => unit.id);
  const groups = automaticSegmentGroups(episode);
  assert.deepEqual(groups.flat(), expected);
  applySegmentation(episode, groups);
  assert.ok(episode.segments.every(segment => segment.durationSec === 30));
  assert.deepEqual(segmentationIssues(episode), []);
  episode.scriptBeats[0].dialogue = ['角色：' + '长'.repeat(100)];
  assert.throws(() => automaticSegmentGroups(episode), /拆句/);
});
process.env.MANJU_DATA_DIR = folder;
const store = await import('../dist-server/server/store.js');
const jobs = await import('../dist-server/server/jobs.js');
const { applyAction } = await import('../dist-server/server/actions.js');
const { runFileAdapter } = await import('../dist-server/server/adapter-runner.js');
test('watchdog terminates a stuck custom adapter and retains unknown billing protection',async()=>{
  const adapter=path.join(folder,'stuck-adapter.mjs');writeFileSync(adapter,"setInterval(()=>{},1000);");
  const request={task:'asset-image',projectId:'timeout-test',model:'mock'};
  await assert.rejects(runFileAdapter(adapter,request,'.png',100),/超时/);
  const task=store.db.prepare('SELECT status FROM adapter_tasks WHERE project_id=?').get('timeout-test');assert.equal(task.status,'remote_unknown');
  await assert.rejects(runFileAdapter(adapter,request,'.png',100),/上次相同模型请求的状态尚未确认/);
});
test('recovery request authority is immutable spec even if current-side JSON is rewritten',()=>{
  const {project,episode,segment,prompt}=fixture();const [job]=jobs.enqueue(project.id,episode.id,[segment.id],['video']);jobs.pauseProject(project.id);
  const spec=store.generationSpec(project.id,job.id);
  const original={generationHash:spec.hash,referenceHashes:spec.references,prompt:spec.preparedPrompt.content,promptHash:spec.preparedPrompt.hash,promptFormat:spec.preparedPrompt.format,durationSec:30,episodeId:episode.id,segmentId:segment.id,aspectRatio:project.aspectRatio || '16:9',model:{id:project.videoModel.modelId,capabilities:project.videoModel.capabilities}};
  jobs.validateRecoveryRequest(job,original);
  assert.throws(()=>jobs.validateRecoveryRequest(job,{...original,prompt:'改写请求'}),/不可变/);
  assert.throws(()=>jobs.validateRecoveryRequest(job,{...original,model:{id:'different-model'}}),/不可变/);
});
test('download recovery restores frozen candidate identity idempotently without changing selection or resubmitting',async()=>{
  const {project,episode,segment,prompt}=fixture(),candidate={batchId:model.id(),candidateId:model.id(),keepSelection:true};
  const [job]=jobs.enqueue(project.id,episode.id,[segment.id],['video'],{candidate});jobs.pauseProject(project.id);
  store.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
  const spec=store.generationSpec(project.id,job.id),dir=path.join(folder,'media','generated',episode.id,segment.id);mkdirSync(dir,{recursive:true});
  const output=path.join(dir,job.id+'.mp4');
  const made=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=navy:s=320x180:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','30','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',output],{windowsHide:true});assert.equal(made.status,0);
  writeFileSync(path.join(dir,job.id+'.json'),JSON.stringify({generationHash:spec.hash,referenceHashes:spec.references,prompt:spec.preparedPrompt.content,promptHash:spec.preparedPrompt.hash,promptFormat:spec.preparedPrompt.format,durationSec:30,episodeId:episode.id,segmentId:segment.id,aspectRatio:project.aspectRatio||'16:9',model:{id:project.videoModel.modelId}}));
  const first=await jobs.recoverDownloadedVideo(project.id,job.id),again=await jobs.recoverDownloadedVideo(project.id,job.id);
  assert.equal(first.candidateId,candidate.candidateId);assert.equal(first.batchId,candidate.batchId);assert.equal(first.id,again.id);
  const current=store.getProject(project.id).episodes[0].segments[0];assert.equal(current.artifacts.filter(a=>a.kind==='video').length,1);assert.equal(current.selected.video,undefined);assert.equal(store.jobById(job.id).status,'completed');
});
test('explicit user acceptance selects the exact video while retaining rejected review and unverified sound',()=>{
  const {project,episode,segment}=fixture(),media='user-accepted-mock.mp4';mkdirSync(path.join(folder,'media'),{recursive:true});writeFileSync(path.join(folder,'media',media),'mock video bytes');const stat=statSync(path.join(folder,'media',media));
  const video={id:model.id(),kind:'video',createdAt:model.now(),sourceHash:model.contentHash(episode,segment),generationHash:generationSignature(project,episode,segment),referenceHashes:[],mediaPath:media,technical:{duration:30,width:320,height:180,hasAudio:true,warnings:[],size:stat.size,modifiedAt:stat.mtimeMs},review:{status:'rejected',notes:'Original findings; speech unverified',reviewedAt:model.now(),checks:{story:false,voice:false,assets:false,labels:false,pacing:false,continuity:false}}};segment.artifacts.push(video);
  const action={type:'segment.userAccept',episodeId:episode.id,segmentId:segment.id,artifactId:video.id,confirmed:true,statement:'第一段过了',sourceMessageId:'user-evidence'};
  assert.throws(()=>applyAction(project,{...action,confirmed:false}));applyAction(project,action);assert.equal(segment.selected.video,video.id);assert.equal(video.userAcceptance.status,'accepted');assert.equal(video.review.status,'rejected');assert.equal(video.review.speech,undefined);assert.equal(video.review.checks.voice,false);
  assert.throws(()=>applyAction(project,{...action,artifactId:'wrong-video'}));assert.throws(()=>applyAction(project,{type:'segment.videoReview',episodeId:episode.id,segmentId:segment.id,artifactId:video.id,status:'approved',checks:{story:true,voice:true,assets:true,labels:true,pacing:true,continuity:true}}));
  applyAction(project,{type:'segment.select',episodeId:episode.id,segmentId:segment.id,artifactId:video.id,kind:'video'});
  const withdraw={type:'segment.userWithdraw',episodeId:episode.id,segmentId:segment.id,artifactId:video.id,confirmed:true,statement:'台词不对，听不清',sourceMessageId:'user-withdraw-evidence'};
  applyAction(project,withdraw);assert.equal(video.userAcceptance.status,'withdrawn');assert.equal(video.userAcceptanceHistory[0].status,'accepted');assert.equal(video.reviewHistory[0].notes,'Original findings; speech unverified');assert.equal(video.review.speech,undefined);assert.equal(segment.selected.video,undefined);
  applyAction(project,withdraw);assert.equal(video.userAcceptanceHistory.length,1);assert.throws(()=>applyAction(project,{type:'segment.select',episodeId:episode.id,segmentId:segment.id,artifactId:video.id,kind:'video'}));
});
test('POV prompt binds actual attachment order and per-segment voices without assigning visible lips to the camera owner',()=>{
 const{episode,segment}=fixture();const refs=[{assetId:'pov',kind:'character',name:'靖安王',identity:'全程第一人称POV，不展示正脸，仅手与衣袖',voice:'old shared voice'},{assetId:'opponent',kind:'character',name:'王公子',identity:'镜头正前方的对手',voice:'old shared voice'}];
 const before=model.contentHash(episode,segment);segment.voiceOverrides={pov:'摄影机位置成年男声，OS与本人对白同声线',opponent:'王公子本人年轻男声'};assert.notEqual(model.contentHash(episode,segment),before);
 const prompt=model.composePrompt(episode,segment,[],refs,[{...refs[0],role:'main'},{...refs[1],role:'main',referenceLayout:'three-view-portrait'}]);
 assert.match(prompt,/附件图2】王公子｜完整四视图＋大头照/);assert.doesNotMatch(prompt,/附件图3】/);assert.match(prompt,/只有可见说话角色才同步其自身口型/);assert.match(prompt,/王公子本人年轻男声/);assert.doesNotMatch(prompt,/old shared voice/);assert.match(prompt,/先不生成背景音乐/);
});
test('200-episode lightweight views preserve review counts and selected versions without prompt bodies',()=>{
  const project=model.makeProject('轻量视图统计','standard');
  project.episodes=Array.from({length:200},(_,index)=>{
    const episode=model.makeEpisode(index+1,'分集'),beat={...model.makeBeat(),event:'原文事件',reaction:'人物反应'},segment=model.makeSegment(beat,1);segment.durationSec=30;
    segment.artifacts=['approved',undefined,'rejected'].map(status=>({id:model.id(),kind:'video',sourceHash:'hash',createdAt:model.now(),mediaPath:'fixture.mp4',...(status?{review:{status,notes:'mock',reviewedAt:model.now()}}:{})}));
    segment.selected.video=segment.artifacts[0].id;segment.artifacts.push({id:model.id(),kind:'prompt',sourceHash:'hash',createdAt:model.now(),content:'完整提示词正文'.repeat(2000)});
    episode.scriptLockedHash='locked';episode.sourceReviewedHash='read';episode.segments=[segment];return episode;
  });
  store.insertProject(project);const view=store.getProjectView(project.id,project.episodes[199].id);
  const light=view.episodes[0].segments[0];assert.equal(light.artifacts.filter(item=>item.kind==='video').length,3);
  assert.equal(light.artifacts.find(item=>item.id===light.selected.video).review.status,'approved');
  assert.equal(light.artifacts.filter(item=>item.review?.status==='rejected').length,1);
  assert.equal(light.artifacts.find(item=>item.kind==='prompt').content,undefined);assert.equal(view.episodes[0].scriptLockedHash,'locked');
  assert.ok(JSON.stringify(view).length<JSON.stringify(project).length/4);
});
const {referenceHashes,verifyReferenceProvenance}=await import('../dist-server/server/reference-provenance.js');
test('mixed dialogue and OS keep source order and stable IDs across merged segments',()=>{
  const episode=model.makeEpisode(1,'声音顺序');
  const beat={...model.makeBeat(),event:'进入房间',reaction:'停下回望',dialogue:['甲：第一句','乙：第三句'],os:['甲：第二句'],speechOrder:[{kind:'dialogue',index:0},{kind:'os',index:0},{kind:'dialogue',index:1}]};
  episode.scriptBeats=[beat];
  applySegmentation(episode,[storyUnits(episode).map(unit=>unit.id)]);
  const list=speechChecklist(episode,episode.segments[0]);
  assert.deepEqual(list.map(line=>line.text),['甲：第一句','甲：第二句','乙：第三句']);
  assert.deepEqual(list.map(line=>line.id),[`${beat.id}:dialogue:0`,`${beat.id}:os:0`,`${beat.id}:dialogue:1`]);
  assert.ok(list.every((line,i)=>i===0 || line.startSec>=list[i-1].startSec));
  assert.throws(()=>orderedSpeech({...beat,speechOrder:[{kind:'os',index:0}]}),/遗漏/);
});
test('video provenance detects replaced reference bytes independently of filenames',()=>{
  const {project,episode,segment}=fixture();
  project.assets=[];segment.assetBindings=[];
  const artifact={referenceHashes:referenceHashes(project,episode,segment)};
  verifyReferenceProvenance(project,episode,segment,artifact);
  assert.throws(()=>verifyReferenceProvenance(project,episode,segment,{}),/追溯/);
  artifact.referenceHashes=[{imageId:'forged',hash:'wrong'}];
  assert.throws(()=>verifyReferenceProvenance(project,episode,segment,artifact),/追溯/);
  const image={id:'provenance-main',mediaPath:'provenance.png',role:'main',source:'upload',createdAt:model.now()};
  project.assets=[{id:'provenance-scene',kind:'scene',name:'房间',identity:'固定房间',voice:'',states:[],images:[image]}];
  image.inputHash=assetInputHash(project,'provenance-scene');
  image.review={status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:model.now()};
  segment.assetBindings=[{assetId:'provenance-scene',imageId:image.id}];
  const file=path.join(folder,'media','provenance.png');writeFileSync(file,'original bytes');
  assert.throws(()=>referenceHashes(project,episode,segment),/旧审图/);
  image.fileHash=createHash('sha256').update('original bytes').digest('hex');
  artifact.referenceHashes=referenceHashes(project,episode,segment);
  verifyReferenceProvenance(project,episode,segment,artifact);
  writeFileSync(file,'replaced bytes');
  assert.throws(()=>verifyReferenceProvenance(project,episode,segment,artifact),/内容已变化/);
});
test('200 episodes are stored separately, paginated and unchanged documents retain their rows', () => {
  const project = model.makeProject('长篇存储', 'standard');
  project.episodes = Array.from({length:200}, (_,i)=>model.makeEpisode(i+1, `第${i+1}集`));
  project.sourceCorpus = '完整原文'.repeat(20000);
  store.insertProject(project);
  const metadata = JSON.parse(store.db.prepare('SELECT payload FROM projects WHERE id=?').get(project.id).payload);
  assert.equal(metadata.episodes, undefined);
  assert.equal(metadata.sourceCorpus, undefined);
  assert.equal(store.episodePage(project.id,180,20).length,20);
  const before = store.db.prepare('SELECT rowid,payload FROM project_episodes WHERE project_id=? AND id=?').get(project.id,project.episodes[199].id);
  store.updateProject(project.id,p=>{p.episodes[0].title='只修改第一集';});
  assert.deepEqual(store.db.prepare('SELECT rowid,payload FROM project_episodes WHERE project_id=? AND id=?').get(project.id,project.episodes[199].id),before);
  const loaded = store.getProject(project.id);
  assert.equal(loaded.episodes.length,200);
  assert.equal(loaded.sourceCorpus,project.sourceCorpus);
  const view=store.getProjectView(project.id,project.episodes[199].id);
  assert.equal(view.sourceCorpus,undefined);
  assert.equal(view.episodes.length,200);
  assert.equal(view.episodes[0].sourceText,'');
});
test('video preview catches missing model capabilities before creating candidates or jobs',async()=>{
 const {project,episode,segment}=fixture();
 project.videoModel={name:'undeclared',modelId:'undeclared',adapterPath:path.resolve('adapters/direct-video.mjs')};
 store.updateProject(project.id,p=>Object.assign(p,project));
 const {candidatePreview}=await import('../dist-server/server/candidates.js');
 assert.throws(()=>candidatePreview(project.id,{kind:'video',episodeId:episode.id,segmentId:segment.id,count:1,feedback:''}),/缺少时长/);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?').get(project.id).n,0);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM candidate_batches WHERE project_id=?').get(project.id).n,0);
});
test('new video APIs reject missing shot-scope rules without changing accepted history or enqueuing a paid job',async()=>{
 const {project,episode,segment,prompt}=fixture();
 prompt.content=prompt.content.replace(/^【逐镜参考范围】[^\n]+/mu,'');episode.auditApprovedHash=model.approvalHash(episode);store.updateProject(project.id,p=>Object.assign(p,project));
 const {candidatePreview}=await import('../dist-server/server/candidates.js');
 assert.throws(()=>candidatePreview(project.id,{kind:'video',episodeId:episode.id,segmentId:segment.id,count:1,feedback:''}),/逐镜参考范围/);
 assert.throws(()=>jobs.enqueue(project.id,episode.id,[segment.id],['video']),/逐镜参考范围/);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?').get(project.id).n,0);
 assert.equal(store.getProject(project.id).episodes[0].segments[0].artifacts[0].content,prompt.content);
});

function fixture() {
  const project = model.makeProject('架构专项','standard'), episode = model.makeEpisode(1,'测试');
  project.episodes=[episode]; project.videoModel={ modelId:'fixture',name:'fixture',adapterPath:path.resolve('tests/fixtures/video-adapter.mjs') };
  episode.sourceText='原文连续内容'.repeat(30); episode.sourceReviewedHash=model.sourceHash(episode);
  episode.highlightReport='完整事件、人物目的与反应的原文核对'; episode.highlightReviewedHash=model.highlightHash(episode);
  episode.scriptBeats=[{...model.makeBeat(), sourceQuote:'原文连续内容', event:'人物发现屋外来客，走到门边查看来客的身影。',reaction:'人物确认同伴安全，伸手阻止同伴继续向门外走去。',dialogue:['人物：先不要开门。']}];
  model.lockScript(episode); const segment=episode.segments[0]; segment.durationSec=30;
  segment.subshots=model.defaultSubshots(episode.scriptBeats[0],30);
  const actions=['主角发出噤声手势。','主角走到门边。','主角查看门缝倒影。','主角确认同伴安全。','主角伸手阻止同伴继续向门走去。'];
  for(const [index,shot] of segment.subshots.entries())shot.action=actions[index]||actions.at(-1); segment.subshotsReviewed=true; segment.visualPlan='屋内门边近景与末帧';
  const prompt={id:model.id(),kind:'prompt',createdAt:model.now(),sourceHash:model.contentHash(episode,segment),content:model.composePrompt(episode,segment)};
  segment.artifacts.push(prompt);segment.selected.prompt=prompt.id;episode.auditApprovedHash=model.approvalHash(episode);
  store.insertProject(project); return { project,episode,segment,prompt };
}
test('浏览器与服务端SHA256保持同一签名',()=>{
  for(const text of ['', 'abc','正式剧本🐍OS','长文'.repeat(10000)]) assert.equal(sha256(text),createHash('sha256').update(text).digest('hex'));
});
test('重复ID/类型、暂停后重提只保留一个原子活动任务；取消不提交',()=>{
  const {project,episode,segment}=fixture();
  const created=jobs.enqueue(project.id,episode.id,[segment.id,segment.id],['prompt','prompt']);assert.equal(created.length,1);
  jobs.pauseProject(project.id);assert.equal(jobs.enqueue(project.id,episode.id,[segment.id],['prompt']).length,0);
  const spec=store.generationSpec(project.id,created[0].id);
  assert.equal(spec.project.episodes[0].segments[0].visualPlan,segment.visualPlan);
  assert.throws(()=>store.generationSpec('other-project',created[0].id),/不存在/);
  assert.throws(()=>store.db.prepare('UPDATE generation_specs SET payload=? WHERE id=?').run('{}',created[0].id),/immutable/);
  jobs.cancelQueued(project.id,created[0].id);assert.equal(store.jobById(created[0].id).status,'cancelled');
});
test('队列冻结输入，编辑后的排队视频不会调用适配器并留下未提交对账',async()=>{
  const {project,episode,segment}=fixture();const [job]=jobs.enqueue(project.id,episode.id,[segment.id],['video']);
  const snapshot=JSON.parse(store.jobById(job.id).snapshot);assert.equal(snapshot.project.episodes[0].segments[0].visualPlan,segment.visualPlan);
  store.updateProject(project.id,p=>{p.episodes[0].segments[0].visualPlan='编辑后的镜头';});
  for(let i=0;i<30 && store.jobById(job.id).status==='queued';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(store.jobById(job.id).status,'failed');assert.match(store.jobById(job.id).error,/未提交生成/);
  const sidecar=path.join(folder,'media','generated',episode.id,segment.id,`${job.id}.mp4.remote.json`);
  assert.equal(JSON.parse(readFileSync(sidecar,'utf8')).status,'not_submitted');
});
test('切换提示词或直接编辑内容使视频生成签名失效',()=>{
  const {project,episode,segment,prompt}=fixture();const video={sourceHash:model.contentHash(episode,segment),generationHash:generationSignature(project,episode,segment)};
  assert.equal(currentVideo(project,episode,segment,video),true);prompt.content+='新约束';assert.equal(currentVideo(project,episode,segment,video),false);
  assert.notEqual(model.approvalHash(episode),episode.auditApprovedHash);
});
test('失败任务缺记录/未知终态拦截重付费；明确终态经人工凭据释放',()=>{
  const {project,episode,segment}=fixture();const old={id:model.id(),project_id:project.id,episode_id:episode.id,segment_id:segment.id,kind:'video',status:'failed',error:'超时',created_at:model.now(),updated_at:model.now()};
  store.insertJobs([old]);assert.throws(()=>jobs.enqueue(project.id,episode.id,[segment.id],['video'],{regenerate:true}),/缺少远端对账记录/);
  assert.throws(()=>jobs.reconcileTask(project.id,old.id,{status:'failed',confirmed:true,receipt:'猜测'}),/供应商核对凭据/);
  jobs.reconcileTask(project.id,old.id,{status:'failed',confirmed:true,receipt:'mock-provider-confirmed-failure'});
  const created=jobs.enqueue(project.id,episode.id,[segment.id],['video'],{regenerate:true});assert.equal(created.length,1);jobs.cancelQueued(project.id,created[0].id);
});
test('数据库领取原子化；第二实例不抢占恢复',()=>{
  store.acquireWorker();const result=spawnSync(process.execPath,['--input-type=module','-e',"import {acquireWorker} from './dist-server/server/store.js'; acquireWorker();"],{cwd:process.cwd(),env:{...process.env,MANJU_DATA_DIR:folder},windowsHide:true,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/已有活动工作实例/);
  const f=fixture(),job={id:model.id(),project_id:f.project.id,episode_id:f.episode.id,segment_id:f.segment.id,kind:'anchor',status:'queued',error:null,created_at:model.now(),updated_at:model.now()};store.insertJobs([job]);
  assert.equal(store.nextJob().id,job.id);assert.equal(store.nextJob(),undefined);store.setJob(job.id,'completed');
});
test('重启保留已提交视频的对账需求，不自动重新生成',()=>{
  const f=fixture(), job={id:model.id(),project_id:f.project.id,episode_id:f.episode.id,segment_id:f.segment.id,kind:'video',status:'running',error:null,created_at:model.now(),updated_at:model.now()};store.insertJobs([job]);jobs.recoverJobs();assert.equal(store.jobById(job.id).status,'failed');assert.match(store.jobById(job.id).error,/不能自动重复付费/);
});
test('30秒、画幅、音轨为硬门禁，逐句漏听/偏移不能通过声音验收',()=>{
  const media={duration:30,width:1920,height:1080,hasAudio:true};validateGeneratedMedia(media,30,'16:9',true);
  assert.throws(()=>validateGeneratedMedia({...media,duration:29},30,'16:9',true),/时长/);assert.throws(()=>validateGeneratedMedia({...media,width:1080,height:1920},30,'16:9',true),/画幅/);
  const {episode,segment}=fixture(), expected=speechChecklist(episode,segment);assert.throws(()=>validateSpeechEvidence(expected,[],30),/逐句/);
  const evidence=expected.map(line=>({id:line.id,heard:true,speaker:true,startSec:line.startSec,endSec:line.startSec+3}));assert.equal(validateSpeechEvidence(expected,evidence,30).length,1);
  assert.throws(()=>validateSpeechEvidence(expected,evidence.map(item=>({...item,startSec:10,endSec:13})),30),/时间偏移/);
});
test('无关资产/未选候选图不使片段失效，已选图被废弃必须失效',()=>{
  const {project,episode,segment}=fixture();project.assets=[{id:'used',kind:'scene',name:'屋内',identity:'屋内门边',voice:'',states:[],images:[]}];
  const image={id:'main',mediaPath:'main.png',source:'upload',createdAt:model.now(),role:'main',inputHash:assetInputHash(project,'used')};project.assets[0].images=[image];segment.assetBindings=[{assetId:'used',imageId:'main'}];
  const before=model.contentHash(episode,segment);invalidateAsset(project,'unrelated');invalidateAsset(project,'used','candidate');assert.equal(model.contentHash(episode,segment),before);
  applyAction(project,{type:'asset.imageReview',assetId:'used',imageId:'main',status:'rejected'});assert.notEqual(model.contentHash(episode,segment),before);
  assert.throws(()=>model.videoReferences(project,episode,segment),/审图通过/);
});
test('分段允许多节点合段与单节点拆段，重复/遗漏/倒序全部阻断',()=>{
  const {episode}=fixture();episode.scriptBeats.push({...model.makeBeat(),event:'第二事件',reaction:'第二反应'});const units=storyUnits(episode).map(unit=>unit.id);
  applySegmentation(episode,[units]);assert.equal(episode.segments.length,1);assert.deepEqual(segmentationIssues(episode),[]);assert.match(model.beatFor(episode,episode.segments[0]).event,/第二事件/);
  applySegmentation(episode,[units.slice(0,2),units.slice(2)]);assert.equal(episode.segments.length,2);
  assert.throws(()=>applySegmentation(episode,[[...units,units[0]]]),/无重复/);assert.throws(()=>applySegmentation(episode,[units.slice(1)]),/完整覆盖/);assert.throws(()=>applySegmentation(episode,[[...units].reverse()]),/顺序不变/);
});
test('超长章与无标题长文分块完整覆盖且不切断代理对',()=>{
  for(const source of ['第1章 长章\n'+'原文🐍'.repeat(12000),'无标题原文\n'.repeat(10000)]){
    const batches=storyBatches(source);assert.ok(batches.length>1);assert.equal(batches.map(batch=>source.slice(batch.start,batch.end)).join(''),source);
    assert.ok(batches.every(batch=>batch.end-batch.start<=20000));assert.ok(batches.every(batch=>!/^[\uDC00-\uDFFF]/u.test(source.slice(batch.start,batch.end))));
  }
});
test('文本/图片任务入统一台账；未知付费状态阻断重复请求',async()=>{
  const adapter=path.join(folder,'failed-adapter.mjs');writeFileSync(adapter,"process.stderr.write('mock unknown'); process.exitCode=1;");
  const request={task:'asset-image',projectId:'ledger-test',model:'fixture'};
  await assert.rejects(runFileAdapter(adapter,request,'.png'),/mock unknown/);
  const record=store.db.prepare('SELECT * FROM adapter_tasks WHERE project_id=?').get('ledger-test');assert.equal(record.status,'remote_unknown');assert.ok(JSON.parse(record.snapshot).request);
  await assert.rejects(runFileAdapter(adapter,request,'.png'),/上次相同模型请求的状态尚未确认/);
  jobs.reconcileTask('ledger-test',record.id,{confirmed:true,receipt:'mock-confirmed-not-submitted',status:'not_submitted'});
  assert.equal(store.db.prepare('SELECT status FROM adapter_tasks WHERE id=?').get(record.id).status,'failed');
});

test('explicit whole-sheet selection changes generation identity and invalidates only dependent segments',()=>{
  const {project,episode,segment}=fixture();
  const other={...structuredClone(segment),id:model.id(),number:2,assetBindings:[]};episode.segments.push(other);
  const asset={id:'portrait-role',kind:'character',name:'人物',identity:'固定身份',voice:'固定声线',states:[],images:[]};project.assets=[asset];
  for(const imageId of ['sheet-a','sheet-b'])asset.images.push({id:imageId,role:'turnaround',layout:'three-view-portrait',source:'upload',createdAt:model.now(),mediaPath:imageId+'.png',fileHash:imageId,inputHash:assetInputHash(project,asset.id),review:{status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:model.now()}});
  segment.assetBindings=[{assetId:asset.id,imageId:'sheet-a'}];
  const before=generationSignature(project,episode,segment),otherBefore=model.contentHash(episode,other);
  applyAction(project,{type:'segment.assets',episodeId:episode.id,segmentId:segment.id,bindings:[{assetId:asset.id,imageId:'sheet-b'}]});
  assert.notEqual(generationSignature(project,episode,segment),before);
  const selectedHash=model.contentHash(episode,segment);invalidateAsset(project,asset.id,'sheet-a');assert.equal(model.contentHash(episode,segment),selectedHash);
  invalidateAsset(project,asset.id,'sheet-b');assert.notEqual(model.contentHash(episode,segment),selectedHash);assert.equal(model.contentHash(episode,other),otherBefore);
});
