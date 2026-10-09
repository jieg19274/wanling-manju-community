import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {tsImport} from 'tsx/esm/api';
import {makeProject,makeEpisode,makeBeat,lockScript,sourceHash,highlightHash,scriptHash,composePrompt,contentHash,approvalHash,auditEpisode} from '../dist-server/shared/model.js';
import {assetInputHash,generationSignature} from '../dist-server/shared/generation.js';
import {summarizeProjectProgress} from '../dist-server/shared/project-progress.js';
const {renderHomeProgress}=await tsImport('../web/home-progress.ts',import.meta.url);
const {renderHomeChat}=await tsImport('../web/studio-home.ts',import.meta.url);
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-progress-'));
process.env.MANJU_DATA_DIR=folder;
const {db,insertProject,getProject}=await import('../dist-server/server/store.js');
// The live service owns this table; fixtures intentionally have no Agent runs.
db.exec('CREATE TABLE IF NOT EXISTS agent_workflows(id TEXT PRIMARY KEY,project_id TEXT,episode_id TEXT,payload TEXT,created_at TEXT)');
const {projectProgress}=await import('../dist-server/server/project-progress.js');
after(()=>db.close());
function fixture(){
  const p=makeProject('旧作品 <一>', 'standard'),e=makeEpisode(1,'已做过的第一集');p.episodes=[e];
  e.sourceText='用于进度回归的完整原文。'.repeat(10);e.sourceReviewedHash=sourceHash(e);
  e.highlightReport='已核对的高光报告';e.highlightReviewedHash=highlightHash(e);
  e.scriptBeats=[{...makeBeat(),event:'林舟看向门，门缝透出红光，他向门前迈步，伸手握住门把手，轻轻推开门。',reaction:'林舟停住，确认同伴安全。',dialogue:['林舟：等一下。']}];lockScript(e);
  const a={id:'door',kind:'prop',name:'门',identity:'木门',voice:'',states:[],images:[]};p.assets=[a];
  const image={id:'main',mediaPath:'door.png',source:'upload',createdAt:'',role:'main',inputHash:assetInputHash(p,a.id),review:{status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:''}};a.images=[image];
  const s=e.segments[0];s.visualPlan='门前固定机位，依次完整呈现正式动作';s.subshotsReviewed=true;s.assetBindings=[{assetId:a.id,imageId:image.id}];
  const prompt={id:'prompt',kind:'prompt',sourceHash:contentHash(e,s),content:composePrompt(e,s),createdAt:''};s.artifacts=[prompt];s.selected.prompt=prompt.id;
  e.auditApprovedHash=approvalHash(e);
  return {p,e,s,a};
}
test('结构核对不通过时进度禁止导出，并呈现模型时长冲突原因',()=>{
  const {p,e}=fixture();assert.equal(auditEpisode(e,p).length,0);assert.equal(summarizeProjectProgress(p).episodes[0].ready.package,true);
  p.videoModel={name:'15秒模型',modelId:'audit-fixed-15s',adapterPath:'unexecuted',capabilities:{fixedDurationSec:15,maxDurationSec:15}};
  const progress=summarizeProjectProgress(p).episodes[0];assert.ok(auditEpisode(e,p).some(issue=>issue.includes('固定 15 秒')));
  assert.equal(progress.ready.package,false);assert.equal(progress.ready.video,false);assert.equal(progress.audited,false);assert.match(progress.next.package.message,/固定 15 秒/);
});
test('没有首页会话的旧项目仍显示完整成果；查询不改变项目或任务记录',()=>{
  const {p}=fixture();insertProject(p);const before=JSON.stringify(getProject(p.id));
  const progress=projectProgress(p.id);
  assert.equal(progress.totals.scriptsLocked,1);assert.equal(progress.totals.segments,1);assert.equal(progress.totals.promptsSaved,1);
  assert.equal(progress.totals.referenceImagesCurrent,0);assert.equal(progress.episodes[0].next.package.tab,'assets');
  assert.equal(progress.workflows.length,0);assert.equal(JSON.stringify(getProject(p.id)),before);
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_workflows').get().n,0);
});
test('版本变化保留历史成果数量，阻止提示词、视频和五层放行误显示完成',()=>{
  const {p,e,s}=fixture();
  const video={id:'video',kind:'video',mediaPath:'video.mp4',sourceHash:contentHash(e,s),generationHash:generationSignature(p,e,s),review:{status:'approved',reviewedAt:'',notes:''},createdAt:''};s.artifacts.push(video);s.selected.video=video.id;
  let progress=summarizeProjectProgress(p);
  assert.equal(progress.totals.promptsCurrent,1);assert.equal(progress.totals.videosApproved,1);assert.equal(progress.totals.auditedEpisodes,1);
  s.visualPlan+='新的机位';progress=summarizeProjectProgress(p);
  assert.equal(progress.totals.promptsSaved,1);assert.equal(progress.totals.videosSaved,1);assert.equal(progress.totals.promptsCurrent,0);assert.equal(progress.totals.videosApproved,0);assert.equal(progress.totals.auditedEpisodes,0);
  e.scriptBeats[0].reaction+='剧本修改';assert.notEqual(e.scriptLockedHash,scriptHash(e));
  progress=summarizeProjectProgress(p);assert.equal(progress.totals.scriptsLocked,0);assert.equal(progress.episodes[0].next.package.tab,'script');
});
test('待审或未选用视频、缺失文件与过期原文不会被算成当前通过',()=>{
  const {p,e,s}=fixture();const hash=generationSignature(p,e,s);
  const video={id:'video',kind:'video',mediaPath:'video.mp4',sourceHash:contentHash(e,s),generationHash:hash,createdAt:''};s.artifacts.push(video);
  assert.equal(summarizeProjectProgress(p).totals.videosCurrent,0);
  s.selected.video=video.id;assert.equal(summarizeProjectProgress(p).totals.videosCurrent,1);assert.equal(summarizeProjectProgress(p).totals.videosApproved,0);
  video.userAcceptance={status:'accepted',generationHash:'旧版'};assert.equal(summarizeProjectProgress(p).totals.videosApproved,0);
  video.userAcceptance.generationHash=hash;assert.equal(summarizeProjectProgress(p).totals.videosApproved,1);
  assert.equal(summarizeProjectProgress(p,file=>file!=='video.mp4').totals.videosApproved,0);
  e.sourceText+='原文改变';assert.equal(summarizeProjectProgress(p).episodes[0].next.package.tab,'source');
});
test('接续建议跟随授权范围和交付目标；长项目分集有界且所有集可翻页',()=>{
  const {p}=fixture();p.episodes.push(makeEpisode(2,'待制作 <二>'));for(let n=3;n<=42;n++)p.episodes.push(makeEpisode(n,'后续集'));
  const progress=summarizeProjectProgress(p);
  const first=renderHomeProgress(progress,false,'','package',1);assert.match(first,/EP 1 · 查看或导出生产包/);
  const second=renderHomeProgress(progress,false,'','package',2);assert.match(second,/EP 2 · 确认完整原文/);assert.match(second,/待制作 &lt;二&gt;/);
  const video=renderHomeProgress(progress,false,'','video',1);assert.match(video,/EP 1 · 继续生成与审片/);
  assert.equal((second.match(/class="home-progress-episode"/g)||[]).length,8);
  const tail=renderHomeProgress(progress,false,'','package',1,99);assert.match(tail,/EP 42/);assert.match(tail,/6 \/ 6/);
});
test('选择旧作品时，会话区域不会混入另一作品的聊天',()=>{
  const home={runs:[{id:'other',projectId:'b',projectName:'其他作品',status:'paused',message:'其他消息',logs:[]}]};
  assert.doesNotMatch(renderHomeChat(home,'other','a'),/其他作品|其他消息/);
  assert.match(renderHomeChat(home,'other','b'),/其他作品/);
});
