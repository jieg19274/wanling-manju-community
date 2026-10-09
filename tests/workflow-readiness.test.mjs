import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';
import {makeProject,makeEpisode,makeBeat,lockScript,sourceHash,highlightHash} from '../dist-server/shared/model.js';
import {storyReviewHash,recordStoryReview} from '../dist-server/shared/story-review.js';
import {summarizeProjectProgress} from '../dist-server/shared/project-progress.js';
process.env.MANJU_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'manju-readiness-'));
const {db,insertProject,getProject,updateProject}=await import('../dist-server/server/store.js');
const {startWorkflow,controlWorkflow}=await import('../dist-server/server/agent-workflow.js');
const {createAgentTask}=await import('../dist-server/server/agent-tasks.js');
const {agentPanel}=await tsImport('../web/agent-panel.ts',import.meta.url);
after(()=>db.close());
function empty(){const p=makeProject('交付目标回归','standard');p.episodes=[makeEpisode(1,'第一集')];return p;}
function traced(){
  const p=empty(),e=p.episodes[0];
  e.sourceText='林舟走到门前，检查信件封印，确认没有破损，随后请同伴进入书房。'.repeat(4);
  e.sourceReviewedHash=sourceHash(e);e.highlightReport='核对封印后请同伴进入书房。';e.highlightReviewedHash=highlightHash(e);
  e.sourceTraceRequired=true;e.scriptBeats=[{...makeBeat(),event:'林舟核对信件封印后请同伴进入书房。',reaction:'同伴点头，随林舟进入。',sourceQuote:'林舟走到门前，检查信件封印，确认没有破损'}];lockScript(e);
  const scene={id:'study',kind:'scene',name:'书房',identity:'回归测试书房',voice:'',states:[],images:[]};p.assets=[scene];
  p.imageModel={name:'禁止执行的测试适配器',modelId:'audit-image',adapterPath:path.resolve('tests/fixtures/image-adapter.mjs')};
  e.segments[0].assetBindings=[{assetId:scene.id}];return p;
}
const input=p=>({episodeId:p.episodes[0].id,limits:{text:0,image:0,video:0}});
test('新流程默认继承项目交付目标，生产包不保留视频额度',()=>{
  const p=empty();insertProject(p);const flow=startWorkflow(p.id,{episodeId:p.episodes[0].id});
  assert.equal(flow.delivery,'package');assert.equal(flow.limits.video,0);
  const video=empty();video.productionRules.delivery='video';insertProject(video);
  const videoFlow=startWorkflow(video.id,{episodeId:video.episodes[0].id});assert.equal(videoFlow.delivery,'video');assert.equal(videoFlow.limits.video,10);
  const invalid=empty();insertProject(invalid);
  assert.throws(()=>startWorkflow(invalid.id,{...input(invalid),limits:{video:1}}),/不包含视频/);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_workflows WHERE project_id=?').get(invalid.id).n,0);
});
test('新流程从任务继承交付范围，目标冲突在创建前拒绝',()=>{
  const p=empty();insertProject(p);
  const task=createAgentTask(p.id,{requestId:'delivery-grant-001',agent:'回归测试',confirmed:true,statement:'仅核验第一集成片，不生成',episodeIds:[p.episodes[0].id],delivery:'video'});
  assert.throws(()=>startWorkflow(p.id,{...input(p),taskId:task.id,delivery:'package'}),/授权不一致/);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_workflows WHERE project_id=?').get(p.id).n,0);
  assert.equal(startWorkflow(p.id,{...input(p),taskId:task.id}).delivery,'video');
});
test('未记录交付目标的历史流程保留原成片语义，不被新默认更改',()=>{
  const p=empty();insertProject(p);const flow=startWorkflow(p.id,{...input(p),delivery:'video'});delete flow.delivery;
  db.prepare('UPDATE agent_workflows SET payload=? WHERE id=?').run(JSON.stringify(flow),flow.id);
  assert.equal(startWorkflow(p.id,input(p)).id,flow.id);
  assert.throws(()=>startWorkflow(p.id,{...input(p),delivery:'package'}),/先取消旧流程/);
});
test('原文覆盖核对先于资产提取及付费出图；当前候选仍须确认',async()=>{
  for(const bound of [false,true]){
    const p=traced(),e=p.episodes[0];if(!bound)e.segments[0].assetBindings=[];insertProject(p);
    const flow=startWorkflow(p.id,input(p));assert.equal(flow.step.task,'semantic');assert.equal(flow.step.kind,'text');
    assert.equal(summarizeProjectProgress(p).episodes[0].next.package.label,'核对原文覆盖');
    updateProject(p.id,current=>{const ep=current.episodes[0];ep.semanticCandidate={hash:storyReviewHash(ep),entries:[],warnings:[],createdAt:''};});
    assert.equal((await controlWorkflow(p.id,flow.id,'resume')).step.key,'semantic-review');
    updateProject(p.id,current=>{current.episodes[0].semanticCandidate.hash='过期候选';});
    assert.equal((await controlWorkflow(p.id,flow.id,'resume')).step.task,'semantic');
  }
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_batches').get().n,0);
});
test('实际原文覆盖记录确认后才进入参考图步骤，原文变化后重新阻断',async()=>{
  const p=traced();insertProject(p);const flow=startWorkflow(p.id,input(p));
  updateProject(p.id,current=>{const e=current.episodes[0];recordStoryReview(e,e.scriptBeats.map(b=>({beatId:b.id,sourceStart:0,sourceEnd:e.sourceText.length,highlightIds:[],notes:'逐节点核对封印完好与进入书房的原文依据。',checks:{highlight:true,event:true,reaction:true,speech:true,labels:true}})));});
  const current=await controlWorkflow(p.id,flow.id,'resume');assert.equal(current.step.kind,'image');assert.equal(current.used.image,0);
  updateProject(p.id,current=>{const e=current.episodes[0];e.highlightReport+='已重新核对';e.highlightReviewedHash=highlightHash(e);});
  assert.equal((await controlWorkflow(p.id,flow.id,'resume')).step.task,'semantic');
  assert.equal(getProject(p.id).episodes[0].scriptBeats[0].event,p.episodes[0].scriptBeats[0].event);
});
test('手动流程入口明示交付目标和次数含义，并继承项目选择',()=>{
  const panel=agentPanel([],'ep');assert.match(panel,/value="package" selected/);assert.match(panel,/data-workflow-video-limit hidden/);assert.match(panel,/费用按实际用量/);
  const video=agentPanel([],'ep',undefined,'video');assert.match(video,/value="video" selected/);assert.doesNotMatch(video,/data-workflow-video-limit hidden/);
});
