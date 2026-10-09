import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-project-models-'));
const requests=[];
const imageBytes=await sharp({create:{width:32,height:32,channels:3,background:'#243c52'}}).png().toBuffer();
const mock=http.createServer(async(req,res)=>{
  if(req.url==='/offline-model-video.mp4'){res.setHeader('content-type','video/mp4');res.end('offline model-request fixture');return;}
  let bytes='';for await(const chunk of req)bytes+=chunk;
  if(!['/v1/chat/completions','/v1/images/generations','/v1/videos'].includes(req.url)){res.writeHead(404).end('{}');return;}
  const body=JSON.parse(bytes);requests.push({route:req.url,...body});
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/images/generations'){res.end(JSON.stringify({data:[{b64_json:imageBytes.toString('base64')}]}));return;}
  if(req.url==='/v1/videos'){res.end(JSON.stringify({video_url:`http://127.0.0.1:${mock.address().port}/offline-model-video.mp4`}));return;}
  res.end(JSON.stringify({id:'offline-model-selection',model:body.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({highlightReport:'隔离测试：角色在门口停步，回头确认同伴，保留原文动作顺序。'})}}]}));
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
Object.assign(process.env,{MANJU_DATA_DIR:path.join(folder,'data'),MANJU_BACKUP_DIR:path.join(folder,'backups'),
  MANJU_JIANYING_DRAFTS_DIR:path.join(folder,'drafts'),MANJU_DIRECT_API_BASE_URL:`http://127.0.0.1:${mock.address().port}/v1`});
delete process.env.MANJU_BATCH_BUDGET_PROFILE;
await import('./network-guard.mjs');
const model=await import('../dist-server/shared/model.js');
const store=await import('../dist-server/server/store.js');
const provider=await import('../dist-server/server/direct-provider.js');
const {agentReadiness}=await import('../dist-server/server/agent-dashboard.js');
const {useProjectDefaultModel,assertProjectModelIdle}=await import('../dist-server/server/project-models.js');
const tasks=await import('../dist-server/server/agent-tasks.js');
after(async()=>{store.db.close();await new Promise(resolve=>mock.close(resolve));});

function project(name='模型选择隔离项目'){
  fs.writeFileSync(provider.configPath,JSON.stringify({protectedKey:'offline-placeholder'}));
  const value=provider.applyGlobalModels(model.makeProject(name,'standard'));
  value.textModel={...value.textModel,name:'claude-fable-5',modelId:'claude-fable-5'};
  value.episodes=[model.makeEpisode(1,'隔离测试')];
  return store.insertProject(value);
}
const hashes=(projectId,kind)=>({expectedModelHash:model.digest(store.getProject(projectId)[`${kind}Model`]??null),expectedDefaultModelHash:model.digest(provider.globalModels()[kind])});

test('默认 Opus 与旧项目 Fable 分别显示真实作用范围，保存返回完整三类默认模型',()=>{
  const old=project();
  const defaults=provider.saveGlobalModel({kind:'text',modelId:'claude-opus-5-5'});
  assert.equal(defaults.text.modelId,'claude-opus-5-5');
  assert.equal(defaults.image.modelId,'gpt-image-2.5-sunburst');assert.ok(defaults.video.modelId);
  assert.equal(store.getProject(old.id).textModel.modelId,'claude-fable-5');
  const global=agentReadiness().checks.find(check=>check.key==='text');
  assert.equal(global.modelId,'claude-opus-5-5');assert.match(global.message,/新项目默认/);assert.equal(global.canUseDefault,false);
  const readiness=agentReadiness(old.id),local=readiness.checks.find(check=>check.key==='text');
  assert.equal(readiness.projectId,old.id);assert.equal(local.modelId,'claude-fable-5');assert.equal(local.defaultModelId,'claude-opus-5-5');
  assert.match(local.message,/本项目实际使用：claude-fable-5/);assert.match(local.message,/本项目尚未切换/);assert.equal(local.canUseDefault,true);
  const fresh=provider.applyGlobalModels(model.makeProject('新项目','standard'));assert.equal(fresh.textModel.modelId,'claude-opus-5-5');
});

test('逐项切换现有项目，不更改其它项目、图片视频、正式内容和原有授权',()=>{
  const old=project(),other=store.insertProject(provider.applyGlobalModels(model.makeProject('另一个项目','standard')));
  store.updateProject(old.id,p=>{p.modelChecks={text:{checkedAt:model.now(),adapterPath:p.textModel.adapterPath,modelId:p.textModel.modelId}};});
  const before=store.getProject(old.id),otherBefore=store.getProject(other.id);
  const task=tasks.createAgentTask(old.id,{requestId:'model-task-before-001',agent:'offline',confirmed:true,statement:'隔离测试仅准备生产包草稿。',episodeIds:[before.episodes[0].id],limits:{text:1}});
  provider.saveGlobalModel({kind:'text',modelId:'claude-opus-5-5'});provider.saveGlobalModel({kind:'image',modelId:'gpt-image-2'});
  const updated=useProjectDefaultModel(old.id,'text',hashes(old.id,'text'));
  assert.equal(updated.textModel.modelId,'claude-opus-5-5');assert.deepEqual(updated.imageModel,before.imageModel);assert.deepEqual(updated.videoModel,before.videoModel);
  assert.deepEqual(updated.episodes,before.episodes);assert.deepEqual(updated.assets,before.assets);assert.deepEqual(store.getProject(other.id),otherBefore);
  assert.equal(updated.modelChecks.text,undefined);assert.equal(tasks.agentTaskStatus(task,updated),'configuration_changed');assert.deepEqual(tasks.findAgentTask(old.id,task.id).used,task.used);
  assert.equal(agentReadiness(old.id).checks.find(check=>check.key==='text').canUseDefault,false);
  useProjectDefaultModel(old.id,'image',hashes(old.id,'image'));
  assert.equal(store.getProject(old.id).imageModel.modelId,'gpt-image-2');assert.equal(agentReadiness(old.id).checks.find(check=>check.key==='image').modelId,'gpt-image-2');
});

test('默认模型或项目模型在点击前已变化时，不覆盖另一处的新选择',()=>{
  const old=project();provider.saveGlobalModel({kind:'text',modelId:'claude-opus-5-5'});
  const staleDefault=hashes(old.id,'text');provider.saveGlobalModel({kind:'text',modelId:'offline-next-selection'});
  assert.throws(()=>useProjectDefaultModel(old.id,'text',staleDefault),/默认模型已变化/);
  assert.equal(store.getProject(old.id).textModel.modelId,'claude-fable-5');
  const staleProject=hashes(old.id,'text');store.updateProject(old.id,p=>{p.textModel.modelId='offline-project-selection';});
  assert.throws(()=>useProjectDefaultModel(old.id,'text',staleProject),/本项目模型已变化/);assert.equal(store.getProject(old.id).textModel.modelId,'offline-project-selection');
  assert.throws(()=>useProjectDefaultModel(old.id,'text',{}),/默认模型已变化/);
});

for(const status of ['queued','running','paused'])test(`项目有 ${status} 生成任务时拒绝切换默认模型`,()=>{
  const old=project();provider.saveGlobalModel({kind:'text',modelId:'claude-opus-5-5'});
  const job=model.id();store.db.prepare('INSERT INTO jobs(id,project_id,episode_id,segment_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(job,old.id,old.episodes[0].id,'test','video',status,model.now(),model.now());
  try{assert.throws(()=>useProjectDefaultModel(old.id,'text',hashes(old.id,'text')),/正在生成的任务/);assert.equal(store.getProject(old.id).textModel.modelId,'claude-fable-5');}
  finally{store.db.prepare('DELETE FROM jobs WHERE id=?').run(job);}
});

test('文本适配器排队或运行时，默认切换与手动修改共用阻断检查',()=>{
  const old=project();provider.saveGlobalModel({kind:'text',modelId:'claude-opus-5-5'});
  for(const status of ['queued','running']){
    const id=model.id();store.db.prepare('INSERT INTO adapter_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,old.id,'highlight-report',id,'{}',status,'offline',null,model.now(),model.now());
    try{assert.throws(()=>assertProjectModelIdle(old.id),/正在生成的任务/);assert.throws(()=>useProjectDefaultModel(old.id,'text',hashes(old.id,'text')),/正在生成的任务/);}
    finally{store.db.prepare('DELETE FROM adapter_tasks WHERE id=?').run(id);}
  }
});

test('切换视频模型保留默认能力证据，不伪造新的人工确认时间',()=>{
  const old=project();provider.saveGlobalModel({kind:'video',modelId:'offline-video-default'});
  const config=provider.readConfig();config.models.video.capabilities={fixedDurationSec:30,maxDurationSec:30,confirmedAt:'2026-10-01T00:00:00.000Z',nativeAudio:true};
  fs.writeFileSync(provider.configPath,JSON.stringify(config));
  const defaults=provider.globalModels().video;
  const updated=useProjectDefaultModel(old.id,'video',hashes(old.id,'video'));
  assert.deepEqual(updated.videoModel,defaults);
});

test('原始请求确实走 Fable，项目切换后真实直连适配器请求体使用 Opus；全部请求仅到本地模拟接口',async t=>{
  if(process.platform!=='win32'){t.skip('Windows 本地密钥保护');return;}
  const old=project();
  const config=provider.readConfig();config.protectedKey=provider.protectLocalSecret('offline-model-selection-key');fs.writeFileSync(provider.configPath,JSON.stringify(config));
  store.updateProject(old.id,p=>{p.episodes[0].sourceText='测试人物走到门边停下，回头确认同伴点头。'.repeat(5);p.episodes[0].sourceReviewedHash=model.sourceHash(p.episodes[0]);});
  provider.saveGlobalModel({kind:'text',modelId:'claude-opus-5-5'});
  const {suggestHighlight}=await import('../dist-server/server/assist.js');
  await suggestHighlight(old.id,old.episodes[0].id);assert.equal(requests.at(-1).model,'claude-fable-5');
  useProjectDefaultModel(old.id,'text',hashes(old.id,'text'));
  await suggestHighlight(old.id,old.episodes[0].id);assert.equal(requests.at(-1).model,'claude-opus-5-5');
  assert.equal(requests.length,2);assert.ok(requests.every(request=>request.messages.length===2));
  assert.equal(agentReadiness(old.id).checks.find(check=>check.key==='text').modelId,'claude-opus-5-5');
});

test('图片默认修改后原项目请求仍用旧模型，明确切换后真实资产图片请求使用 gpt-image-2',async t=>{
  if(process.platform!=='win32'){t.skip('Windows 本地密钥保护');return;}
  const old=project();
  const config=provider.readConfig();config.protectedKey=provider.protectLocalSecret('offline-model-selection-key');fs.writeFileSync(provider.configPath,JSON.stringify(config));
  const assetId=model.id();store.updateProject(old.id,p=>{p.assets=[{id:assetId,kind:'scene',name:'离线测试空房间',identity:'空房间与门框，无角色或文字',voice:'',states:[],images:[]}];});
  provider.saveGlobalModel({kind:'image',modelId:'gpt-image-2'});
  const {generateAssetImage}=await import('../dist-server/server/assist.js');
  await generateAssetImage(old.id,assetId,'');assert.equal(requests.at(-1).model,'gpt-image-2.5-sunburst');assert.equal(requests.at(-1).route,'/v1/images/generations');
  useProjectDefaultModel(old.id,'image',hashes(old.id,'image'));
  await generateAssetImage(old.id,assetId,'');assert.equal(requests.at(-1).model,'gpt-image-2');assert.equal(requests.at(-1).route,'/v1/images/generations');
  assert.equal(store.getProject(old.id).assets[0].images.length,2);assert.equal(agentReadiness(old.id).checks.find(check=>check.key==='image').modelId,'gpt-image-2');
});

test('视频默认修改后原项目使用旧模型，明确切换后直连视频请求体使用新模型 ID 并保留30秒',async t=>{
  if(process.platform!=='win32'){t.skip('Windows 本地密钥保护');return;}
  const old=project();
  const config=provider.readConfig();config.protectedKey=provider.protectLocalSecret('offline-model-selection-key');fs.writeFileSync(provider.configPath,JSON.stringify(config));
  provider.saveGlobalModel({kind:'video',modelId:'全能sd2.5'});
  const {runFileAdapter}=await import('../dist-server/server/adapter-runner.js');
  const submit=async()=>{
    const p=store.getProject(old.id),video=p.videoModel;
    await runFileAdapter(video.adapterPath,{projectId:p.id,task:'video',model:{id:video.modelId,capabilities:video.capabilities},prompt:'离线测试：空房间固定机位，门框与空间保持一致。',durationSec:30,aspectRatio:'16:9'},'.mp4');
  };
  await submit();assert.equal(requests.at(-1).model,'专享sd2.5(30图10音/4-30秒/720p)');assert.equal(requests.at(-1).route,'/v1/videos');
  useProjectDefaultModel(old.id,'video',hashes(old.id,'video'));await submit();
  assert.equal(requests.at(-1).model,'全能sd2.5');assert.equal(requests.at(-1).route,'/v1/videos');assert.equal(requests.at(-1).duration,30);
  assert.equal(agentReadiness(old.id).checks.find(check=>check.key==='video').modelId,'全能sd2.5');
});
