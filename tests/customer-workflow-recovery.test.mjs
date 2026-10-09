import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root=path.resolve(import.meta.dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-customer-recovery-'));
Object.assign(process.env,{MANJU_DATA_DIR:path.join(folder,'data'),MANJU_BACKUP_DIR:path.join(folder,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(folder,'drafts'),MANJU_DIRECT_API_BASE_URL:'http://127.0.0.1:1'});
delete process.env.MANJU_BATCH_BUDGET_PROFILE;
await import('./network-guard.mjs');
const m=await import('../dist-server/shared/model.js');
const {db,insertProject,getProject,updateProject,insertJobs}=await import('../dist-server/server/store.js');
const {applyAction}=await import('../dist-server/server/actions.js');
const {agentContext,agentCommand}=await import('../dist-server/server/agent-api.js');
const {createAgentTask,agentTaskStatus,findAgentTask,pauseAgentTask}=await import('../dist-server/server/agent-tasks.js');
const {getWorkflow,bindWorkflowTask}=await import('../dist-server/server/agent-workflow.js');
const {useProjectDefaultModel}=await import('../dist-server/server/project-models.js');
const {agentDashboard}=await import('../dist-server/server/agent-dashboard.js');
const {agentModelRequests}=await import('../dist-server/server/agent-model-requests.js');
const {scriptReadiness}=await import('../dist-server/shared/script-readiness.js');
const provider=await import('../dist-server/server/direct-provider.js');
const {renderAgentDashboard}=await tsImport('../web/agent-dashboard.ts',import.meta.url);
after(()=>db.close());
let serial=0;
const requestId=()=>`customer-regression-${++serial}`;
const wait=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('本地模拟工作流超时');};
const command=(p,fields)=>agentCommand(p.id,{requestId:requestId(),expectedHash:agentContext(p.id).stateHash,...fields});
const grant=(p,limits={text:2})=>createAgentTask(p.id,{requestId:requestId(),agent:'offline-customer-regression',confirmed:true,statement:'仅在隔离目录以本地模拟验证模型与旧剧本续跑，不调用收费模型。',episodeIds:p.episodes.map(e=>e.id),delivery:'package',allowGeneration:!!limits.text,acceptUnknownCost:true,limits});
function fixture(){
  const p=m.makeProject('客户问题隔离回归','standard');p.episodes=[m.makeEpisode(1,'第一集')];
  const adapter=path.join(folder,`${p.id}.mjs`),record=path.join(folder,`${p.id}.jsonl`);
  fs.writeFileSync(adapter,`import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({model:input.model,task:input.task})+'\\n');if(input.model==='claude-fable-5'){process.stderr.write('模型接口 HTTP 503：No available channel for model claude-fable-5 under offline-test-group');process.exit(1);}await import(${JSON.stringify(pathToFileURL(path.join(root,'tests/fixtures/text-adapter.mjs')).href)});`);
  p.textModel={name:'Fable offline',modelId:'claude-fable-5',adapterPath:adapter};
  p.episodes[0].sourceText='隔离测试人物在门前停步，回头确认同伴回应，再把门打开并请对方进入。'.repeat(4);
  p.episodes[0].sourceReviewedHash=m.sourceHash(p.episodes[0]);insertProject(p);
  const change=()=>{
    fs.writeFileSync(provider.configPath,JSON.stringify({protectedKey:'offline-placeholder',models:{text:{name:'Opus offline',modelId:'claude-opus-5-5',adapterPath:adapter}}}));
    return useProjectDefaultModel(p.id,'text',{expectedModelHash:m.digest(getProject(p.id).textModel),expectedDefaultModelHash:m.digest(provider.globalModels().text)});
  };
  const requests=()=>fs.existsSync(record)?fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse):[];
  return {p,change,requests};
}

test('旧 Fable 失败后切换 Opus，新任务复用工作流时预览更新，历史失败和原额度保留，未自动重提',async()=>{
  const {p,change,requests}=fixture(),a=grant(p);
  const flow=(await command(p,{command:'start',episodeId:p.episodes[0].id,taskId:a.id})).result;
  await command(p,{command:'continue',workflowId:flow.id,taskId:a.id});await wait(()=>getWorkflow(p.id,flow.id).status==='failed');
  const old=getWorkflow(p.id,flow.id);change();const b=grant(p);
  const current=(await command(p,{command:'start',episodeId:p.episodes[0].id,taskId:b.id})).result;
  assert.equal(current.id,flow.id);assert.equal(current.step.model,'claude-opus-5-5');assert.equal(current.status,'failed');
  assert.equal(current.error,old.error);assert.deepEqual(current.history,old.history);assert.equal(current.history[0].model,'claude-fable-5');
  assert.deepEqual(requests().map(r=>r.model),['claude-fable-5']);assert.equal(findAgentTask(p.id,b.id).used.text,0);assert.equal(findAgentTask(p.id,a.id).used.text,1);
  assert.equal(agentTaskStatus(findAgentTask(p.id,a.id),getProject(p.id)),'configuration_changed');
  const html=renderAgentDashboard(agentDashboard(p.id));assert.match(html,/当前步骤模型：claude-opus-5-5/);assert.match(html,/上次执行失败 · claude-fable-5/);
  const pending=(await command(p,{command:'continue',workflowId:flow.id,taskId:b.id})).result;assert.equal(pending.status,'waiting_budget');
  await command(p,{command:'continue',workflowId:flow.id,taskId:b.id});await wait(()=>getWorkflow(p.id,flow.id).history.at(-1).status==='completed');
  assert.deepEqual(requests().map(r=>r.model),['claude-fable-5','claude-opus-5-5']);assert.equal(findAgentTask(p.id,b.id).used.text,1);
  assert.equal(getWorkflow(p.id,flow.id).history[0].model,'claude-fable-5');
});

test('未提交的旧预算步骤切换模型后立即显示当前预览，第一条 continue 使用 Opus',async()=>{
  const {p,change,requests}=fixture(),a=grant(p);
  const flow=(await command(p,{command:'start',episodeId:p.episodes[0].id,taskId:a.id})).result;change();const b=grant(p);
  const current=(await command(p,{command:'start',episodeId:p.episodes[0].id,taskId:b.id})).result;
  assert.equal(current.step.model,'claude-opus-5-5');assert.equal(current.step.preview.model,'claude-opus-5-5');assert.equal(current.status,'waiting_budget');assert.deepEqual(requests(),[]);
  await command(p,{command:'continue',workflowId:flow.id,taskId:b.id});await wait(()=>getWorkflow(p.id,flow.id).history.at(-1)?.status==='completed');
  assert.deepEqual(requests().map(r=>r.model),['claude-opus-5-5']);assert.equal(findAgentTask(p.id,a.id).used.text,0);
});

test('模型切换的新授权不能绕过旧任务的暂停',async()=>{
  const {p,change,requests}=fixture(),a=grant(p);
  const flow=(await command(p,{command:'start',episodeId:p.episodes[0].id,taskId:a.id})).result;pauseAgentTask(p.id,a.id);change();const b=grant(p);
  assert.throws(()=>bindWorkflowTask(p.id,flow.id,b.id),/不能用新额度绕过暂停/);assert.deepEqual(requests(),[]);
});

test('40 集旧稿补阅读/高光核对后沿用原稿锁定；节点 ID、剧情、对白、OS、浮签和系统信息不变，无模型请求',async()=>{
  const p=m.makeProject('40集旧版剧本恢复','standard');p.episodes=Array.from({length:40},(_,i)=>{
    const e=m.makeEpisode(i+1,`旧稿 ${i+1}`),event=`角色打开第${i+1}间书房门，确认同伴在身后。`,reaction='同伴点头，随后进门。';
    e.sourceText=(event+reaction).repeat(4);e.scriptBeats=[{...m.makeBeat(),event,reaction,sourceQuote:event,dialogue:['角色：请进。'],os:['角色：同伴已经平安。'],floatLabels:['书房'],systemPanels:['状态：安全']}];return e;
  });insertProject(p);const original=p.episodes.map(e=>structuredClone(e.scriptBeats)),task=grant(p,{text:0,image:0,video:0});
  assert.equal(agentContext(p.id).scriptReadiness.length,40);assert.equal(agentDashboard(p.id).scriptRecovery.length,40);
  assert.match(renderAgentDashboard(agentDashboard(p.id)),/已有剧本待核对 · 40 集/);
  for(const e of p.episodes){
    await assert.rejects(command(p,{command:'action',taskId:task.id,action:{type:'script.lock',episodeId:e.id},review:{stateHash:agentContext(p.id).stateHash,notes:'隔离回归：验证缺少原文阅读确认时不锁稿。'}}),/完整阅读/);
    let c=agentContext(p.id,e.id);const review=()=>({stateHash:agentContext(p.id).stateHash,notes:'隔离回归：逐项比对完整原文、起因反应结果及每句声音和可见信息；保存已有旧稿，不重写。'});
    await command(p,{command:'action',taskId:task.id,action:{type:'episode.confirmSource',episodeId:e.id},review:{...review(),sourceHash:c.sourceHashes[e.id],readStart:0,readEnd:e.sourceText.length}});
    assert.equal(agentContext(p.id,e.id).scriptReadiness[0].state,'highlight');
    await command(p,{command:'action',taskId:task.id,action:{type:'episode.update',episodeId:e.id,highlightReport:'隔离核对：先开门确认同伴，后进门；保留人物反应、对白、OS与安全状态；原文范围完整，无新增剧情。'}});
    await command(p,{command:'action',taskId:task.id,action:{type:'episode.confirmHighlight',episodeId:e.id},review:review()});
    assert.equal(agentContext(p.id,e.id).scriptReadiness[0].state,'ready');
    await command(p,{command:'action',taskId:task.id,action:{type:'script.lock',episodeId:e.id},review:review()});
  }
  const saved=getProject(p.id);assert.deepEqual(saved.episodes.map(e=>e.scriptBeats),original);assert.ok(saved.episodes.every(e=>e.scriptLockedHash===m.scriptHash(e)));
  assert.equal(agentDashboard(p.id).scriptRecovery.length,0);assert.equal(db.prepare('SELECT count(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n,0);assert.deepEqual(findAgentTask(p.id,task.id).used,{text:0,image:0,video:0});
});

test('旧稿原文或节点逐字依据缺失时显示具体缺项，已有稿和虚构引文都不能代替原文核对',()=>{
  const {p}=fixture();updateProject(p.id,current=>{
    const e=current.episodes[0];e.scriptBeats=[{...m.makeBeat(),event:'角色开门。',reaction:'同伴回应。',sourceQuote:'原文没有这句话。'}];e.highlightReport='已核对高光';e.highlightReviewedHash=m.highlightHash(e);
  });const e=getProject(p.id).episodes[0];assert.equal(scriptReadiness(e).state,'script');assert.match(scriptReadiness(e).message,/逐字依据/);
  assert.throws(()=>applyAction(getProject(p.id),{type:'script.lock',episodeId:e.id}),/逐字依据/);
  assert.equal(scriptReadiness({...e,sourceText:''}).state,'source');assert.match(scriptReadiness({...e,sourceText:''}).missing.join('、'),/完整原文/);
});

test('旧稿补高光后继续核对已有稿，过期剧本候选不会抢占现稿或强制重生成',async()=>{
  const {p,requests}=fixture();updateProject(p.id,current=>{
    const e=current.episodes[0],quote=e.sourceText.slice(0,28);
    e.highlightReport='门边停步与同伴反应已对照完整原文核对';e.highlightReviewedHash=m.highlightHash(e);
    e.scriptBeats=[{...m.makeBeat(),event:quote,reaction:'同伴点头回应。',sourceQuote:quote}];
    e.scriptCandidate={sourceHash:m.sourceHash(e),highlightHash:'stale-highlight',beats:[{...m.makeBeat(),event:'过期候选，不可替换现稿。',reaction:'过期候选。'}]};
  });const before=structuredClone(getProject(p.id).episodes[0].scriptBeats),task=grant(p,{text:0});
  const flow=(await command(p,{command:'start',episodeId:p.episodes[0].id,taskId:task.id})).result;
  assert.equal(flow.step.key,'script-lock');assert.equal(flow.step.kind,'gate');assert.deepEqual(getProject(p.id).episodes[0].scriptBeats,before);assert.deepEqual(requests(),[]);
});

test('模型诊断按本项目历史快照与 HTTP 回执读取，含视频，屏蔽密钥/提示词/素材 URL 与其他项目',()=>{
  const {p}=fixture(),other=fixture().p,adapterFolder=path.join(process.env.MANJU_DATA_DIR,'adapter-jobs');fs.mkdirSync(adapterFolder,{recursive:true});
  const add=(projectId,task,model,status=503)=>{
    const id=m.id(),output=path.join(adapterFolder,`${id}.json`);db.prepare('INSERT INTO adapter_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,projectId,task,id,JSON.stringify({request:{model,prompt:'PRIVATE_PROMPT',key:'PRIVATE_KEY'}}),'remote_unknown',output,null,m.now(),m.now());
    fs.writeFileSync(output+'.provider-http-receipt.json',JSON.stringify({status,model,requestId:'offline-provider-id',receivedAt:m.now(),Authorization:'PRIVATE_KEY',url:'PRIVATE_URL'}));return id;
  };
  const text=add(p.id,'highlight-report','claude-opus-5-5'),image=add(p.id,'asset-image','gpt-image-2',200);add(other.id,'highlight-report','FOREIGN_MODEL');
  const video=m.id(),e=p.episodes[0],seg='offline-segment',videoFolder=path.join(process.env.MANJU_DATA_DIR,'media/generated',e.id,seg);fs.mkdirSync(videoFolder,{recursive:true});
  insertJobs([{id:video,project_id:p.id,episode_id:e.id,segment_id:seg,kind:'video',status:'failed',error:'offline',created_at:m.now(),updated_at:m.now(),snapshot:JSON.stringify({project:{videoModel:{modelId:'OLD_VIDEO_MODEL'}},prompt:'PRIVATE_PROMPT'})}]);
  fs.writeFileSync(path.join(videoFolder,`${video}.json`),'{}');fs.writeFileSync(path.join(videoFolder,`${video}.mp4.provider-http-receipt.json`),JSON.stringify({status:503,model:'OLD_VIDEO_MODEL',requestId:'offline-video-id'}));
  const rows=agentModelRequests(p.id);assert.equal(rows.length,3);assert.equal(rows.find(r=>r.id===text).http.model,'claude-opus-5-5');assert.equal(rows.find(r=>r.id===image).model,'gpt-image-2');assert.equal(rows.find(r=>r.id===video).http.model,'OLD_VIDEO_MODEL');
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_|FOREIGN_MODEL/);assert.deepEqual(agentContext(p.id).modelRequests,rows);
  assert.equal(agentContext(p.id).connection.installationRoot,root);assert.equal(agentContext(p.id).connection.dataDirectory,process.env.MANJU_DATA_DIR);
  const saved=path.join(adapterFolder,`${text}.json.provider-http-receipt.json`);fs.writeFileSync(saved,'{');assert.equal(agentModelRequests(p.id).find(r=>r.id===text).http,undefined);
});

test('官方接管技能元数据只包含名称描述，模型与旧稿说明位于正文，签名随包技能结构相同',()=>{
  for(const file of ['agent/wanling-manju/SKILL.md','dist-server/bundled/wanling-manju/SKILL.md']){
    const source=fs.readFileSync(path.join(root,file),'utf8'),match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);assert.ok(match,file);
    const metadata=match[1].split(/\r?\n/);assert.equal(metadata.length,2);assert.match(metadata[0],/^name: wanling-manju$/);assert.match(metadata[1],/^description: .+/);
    const body=source.slice(match[0].length);assert.match(body,/modelRequests/);assert.match(body,/旧版已有剧本的补核对/);
  }
});
