import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-home-'));
Object.assign(process.env,{MANJU_DATA_DIR:path.join(folder,'data'),MANJU_BACKUP_DIR:path.join(folder,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(folder,'drafts'),MANJU_DIRECT_API_BASE_URL:'http://127.0.0.1:1'});
await import('./network-guard.mjs');
const home=await import('../dist-server/server/studio-home.js');
const {getProject,updateProject,insertProject,db}=await import('../dist-server/server/store.js');
const {makeProject,makeEpisode,sourceHash}=await import('../dist-server/shared/model.js');
const {applyAction}=await import('../dist-server/server/actions.js');
const {agentContext}=await import('../dist-server/server/agent-api.js');
const {agentTask,reserveAgentSubmission,pauseAgentTask}=await import('../dist-server/server/agent-tasks.js');
const source='第一章 初遇\n'+ '这是完整的章节原文，人物行动、对白和反应都要保留。'.repeat(6)+'\n第二章 追踪\n'+ '接下来发生有依据的故事，原文与声音不能删减。'.repeat(6);
let serial=0;
const requestId=()=>`home-regression-${++serial}`;
const tick=()=>new Promise(r=>setTimeout(r,10));
async function wait(predicate){for(let i=0;i<200;i++){if(predicate())return;await tick();}throw Error('mock checkpoint timeout');}
class Peer{
 calls=[];responses=[];threads=new Map();onMessage=()=>{};onDisconnect=()=>{};delay='';release=undefined;
 async connect(){}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='account/read')return {account:{type:'chatgpt'}};
  if(this.delay===method){this.delay='';await new Promise(resolve=>{this.release=resolve;});}
  if(method==='thread/start'){const thread={id:'thread-'+requestId(),turns:[]};this.threads.set(thread.id,thread);return {thread};}
  if(method==='thread/resume'||method==='thread/read')return {thread:this.threads.get(params.threadId)};
  if(method==='turn/start'){const turn={id:'turn-'+requestId(),status:'inProgress'};this.threads.get(params.threadId).turns.push(turn);return {turn};}
  if(method==='turn/interrupt'){const turn=this.threads.get(params.threadId)?.turns.find(t=>t.id===params.turnId);if(turn)turn.status='interrupted';return {};}
  if(method==='turn/steer')return {};
  throw Error('Unexpected mock method '+method);
 }
 respond(id,result){this.responses.push({id,result});}
 close(){}
 completed(run,status='completed'){this.threads.get(run.threadId).turns.find(t=>t.id===run.turnId).status=status;this.onMessage({method:'turn/completed',params:{threadId:run.threadId,turn:{id:run.turnId,status}}});}
}
const peer=new Peer();home.setStudioRpcFactory(()=>peer);
after(()=>{home.closeStudioCodex();db.close();});
const input=()=>({requestId:requestId(),name:'会话回归作品',sourceText:source,client:'codex',confirmed:true,targetEpisodes:1,delivery:'package',limits:{text:3,image:2,video:0}});
async function start(){const body=input(),run=await home.startStudioRun(body);await wait(()=>Boolean(home.getStudioRun(run.id).turnId));return {body,run:home.getStudioRun(run.id)};}
const control=(run,operation,text)=>home.controlStudioRun(run.id,{requestId:requestId(),operation,...(text?{text}:{})});

test('仅保存原文不启动Agent；重复保存保留同一作品，改原文拒绝',async()=>{
 const body={requestId:requestId(),name:'稍后制作',sourceText:source};const a=home.saveStudioDraft(body),count=peer.calls.length;
 assert.deepEqual(home.saveStudioDraft(body),a);assert.equal(getProject(a.projectId).sourceCorpus,source);assert.equal(peer.calls.length,count);
 assert.throws(()=>home.saveStudioDraft({...body,sourceText:source+'改变'}),/原文不能改变/);
 await assert.rejects(home.startStudioRun({...input(),confirmed:false}),/确认/);
 await assert.rejects(home.startStudioRun({...input(),limits:{text:3,image:2,video:1}}),/生产包/);
});
test('启动响应重放只运行一次；项目改名保留集、授权、原会话且首页同步',async()=>{
 const {body,run}=await start();const starts=peer.calls.filter(c=>c.method==='turn/start').length;
 assert.equal((await home.startStudioRun(body)).id,run.id);assert.equal(peer.calls.filter(c=>c.method==='turn/start').length,starts);
 updateProject(run.projectId,p=>{applyAction(p,{type:'project.planChapterGroups',chapterEnds:[1,2]});applyAction(p,{type:'project.createEpisodes'});});
 const original=getProject(run.projectId),task=await home.studioTool(run.id,'manju_task',{});reserveAgentSubmission(run.projectId,task.id,original.episodes[0].id,'text',1,{known:true,maximum:0,currency:'CNY'});
 updateProject(run.projectId,p=>applyAction(p,{type:'project.rename',name:'新名称 😀'}));const current=getProject(run.projectId);
 assert.equal(current.id,original.id);assert.deepEqual(current.episodes,original.episodes);assert.deepEqual(current.assets,original.assets);assert.equal(current.sourceCorpus,original.sourceCorpus);
 assert.equal(home.getStudioRun(run.id).threadId,run.threadId);assert.equal(agentTask(run.projectId,task.id).used.text,1);
 const summary=await home.studioHome();assert.equal(summary.runs.find(r=>r.id===run.id).projectName,'新名称 😀');assert.equal(summary.projects.find(p=>p.id===run.projectId).name,'新名称 😀');
 assert.throws(()=>updateProject(run.projectId,p=>applyAction(p,{type:'project.rename',name:'   '})),/1–100/);assert.equal(getProject(run.projectId).name,'新名称 😀');
 await control(run,'cancel');
});
test('暂停立刻封住工具；恢复沿用原线程和已使用额度',async()=>{
 const {run}=await start();updateProject(run.projectId,p=>{applyAction(p,{type:'project.planChapterGroups',chapterEnds:[1,2]});applyAction(p,{type:'project.createEpisodes'});});
 const task=await home.studioTool(run.id,'manju_task',{});reserveAgentSubmission(run.projectId,task.id,getProject(run.projectId).episodes[0].id,'text',1,{known:true,maximum:0,currency:'CNY'});
 await control(run,'pause');await assert.rejects(home.studioTool(run.id,'manju_task',{}),/会话已停止/);
 await assert.rejects(control(run,'message','增加要求'),/暂停/);
 await control(run,'resume');await wait(()=>home.getStudioRun(run.id).status==='running'&&home.getStudioRun(run.id).turnId!==run.turnId);
 const resumed=home.getStudioRun(run.id);assert.equal(resumed.threadId,run.threadId);assert.equal(resumed.taskId,task.id);assert.equal(agentTask(run.projectId,task.id).used.text,1);
 await control(run,'cancel');
});
test('启动线程返回较晚不会覆盖暂停；turn/start较晚仍中断对应轮次',async()=>{
 for(const delayed of ['thread/start','turn/start']){
  peer.delay=delayed;const run=await home.startStudioRun(input());await wait(()=>Boolean(peer.release));
  await control(run,'pause');const release=peer.release;peer.release=undefined;release();await tick();await tick();
  assert.equal(home.getStudioRun(run.id).status,'paused');
  if(delayed==='thread/start')assert.equal(home.getStudioRun(run.id).turnId,undefined);
  else {await wait(()=>Boolean(home.getStudioRun(run.id).turnId));const latest=home.getStudioRun(run.id);assert.ok(peer.calls.some(c=>c.method==='turn/interrupt'&&c.params.turnId===latest.turnId));}
  await control(run,'cancel');
 }
});
test('聊天重放只发送一次；Codex结束一轮不能冒充成品已交付',async()=>{
 const {run}=await start(),message={requestId:requestId(),operation:'message',text:'保留对白并说明下一步'};
 const before=peer.calls.filter(c=>c.method==='turn/steer').length;await home.controlStudioRun(run.id,message);await home.controlStudioRun(run.id,message);
 assert.equal(peer.calls.filter(c=>c.method==='turn/steer').length,before+1);assert.equal(home.getStudioRun(run.id).logs.filter(l=>l.text==='你：'+message.text).length,1);
 peer.completed(run);await wait(()=>home.getStudioRun(run.id).status==='waiting_input');assert.notEqual(home.getStudioRun(run.id).status,'completed');
 await control(run,'cancel');
});
test('跨集和扩大授权被拒绝；完整原文未读取不能确认',async()=>{
 const {run}=await start();updateProject(run.projectId,p=>{applyAction(p,{type:'project.planChapterGroups',chapterEnds:[1,2]});applyAction(p,{type:'project.createEpisodes'});});
 const p=getProject(run.projectId);await home.studioTool(run.id,'manju_task',{});
 await assert.rejects(home.studioTool(run.id,'manju_context',{episodeId:p.episodes[1].id}),/范围/);
 await assert.rejects(home.studioTool(run.id,'manju_command',{command:'action',action:{type:'project.productionRules'}}),/不能改写/);
 const command={command:'action',requestId:requestId(),expectedHash:agentContext(p.id).stateHash,action:{type:'episode.confirmSource',episodeId:p.episodes[0].id}};
 await assert.rejects(home.studioTool(run.id,'manju_command',command),/完整读取/);
 await control(run,'cancel');
});

test('原文修改后必须重新完整读取，不能混用不同版本的阅读区间',async()=>{
 const project=makeProject('手工原文版本核验','douyin-story'),episode=makeEpisode(1,'原文核验');
 episode.sourceText=source;project.episodes=[episode];insertProject(project);
 const run=await home.startStudioRun({...input(),projectId:project.id});await wait(()=>Boolean(home.getStudioRun(run.id).turnId));
 await home.studioTool(run.id,'manju_task',{});
 const read=(start,end)=>home.studioTool(run.id,'manju_source',{episodeId:episode.id,start,end});
 const confirm=()=>{
  const context=agentContext(project.id),current=getProject(project.id).episodes[0];
  return home.studioTool(run.id,'manju_command',{requestId:requestId(),expectedHash:context.stateHash,command:'action',action:{type:'episode.confirmSource',episodeId:episode.id},review:{notes:'隔离核验：完整读取当前原文，记录范围与当前原文版本。',stateHash:context.stateHash,sourceHash:sourceHash(current),readStart:0,readEnd:current.sourceText.length}});
 };
 await read(0,source.length);
 updateProject(project.id,p=>applyAction(p,{type:'episode.update',episodeId:episode.id,sourceText:source.replaceAll('人物','角色')}));
 await assert.rejects(confirm(),/完整读取/);
 assert.equal(getProject(project.id).episodes[0].sourceReviewedHash,undefined);
 const middle=Math.floor(source.length/2);await read(middle,source.length);
 await assert.rejects(confirm(),/完整读取/);
 await read(0,middle);await confirm();
 assert.equal(getProject(project.id).episodes[0].sourceReviewedHash,sourceHash(getProject(project.id).episodes[0]));
 updateProject(project.id,p=>applyAction(p,{type:'episode.update',episodeId:episode.id,sourceText:source.slice(0,middle)}));
 await assert.rejects(confirm(),/完整读取/);
 await home.studioTool(run.id,'manju_context',{episodeId:episode.id});await confirm();
 assert.equal(getProject(project.id).episodes[0].sourceReviewedHash,sourceHash(getProject(project.id).episodes[0]));
 await control(run,'cancel');
});
test('重启标记中断且不自动启动；新建超过16个项目仍能找到旧会话',async()=>{
 const {run}=await start();const count=peer.calls.length;home.recoverStudioRuns();assert.equal(home.getStudioRun(run.id).status,'interrupted');assert.equal(peer.calls.length,count);
 for(let i=0;i<18;i++)home.saveStudioDraft({requestId:requestId(),name:'最近作品'+i,sourceText:source});
 assert.ok((await home.studioHome()).runs.some(r=>r.id===run.id));await control(run,'cancel');
});
test('结果未知时先中断原轮次，核对完成前不重复启动',async()=>{
 const {run}=await start();home.recoverStudioRuns();const count=peer.calls.filter(c=>c.method==='turn/start').length;
 await control(run,'resume');await wait(()=>home.getStudioRun(run.id).status==='failed');
 assert.equal(peer.calls.filter(c=>c.method==='turn/start').length,count);assert.match(home.getStudioRun(run.id).error,/不会重复启动/);
 await control(run,'resume');await wait(()=>home.getStudioRun(run.id).turnId!==run.turnId);
 assert.equal(peer.calls.filter(c=>c.method==='turn/start').length,count+1);await control(run,'cancel');
});
test('项目任务面板的暂停同步锁住会话',async()=>{
 const {run}=await start();updateProject(run.projectId,p=>{applyAction(p,{type:'project.planChapterGroups',chapterEnds:[1,2]});applyAction(p,{type:'project.createEpisodes'});});
 const task=await home.studioTool(run.id,'manju_task',{});pauseAgentTask(run.projectId,task.id);
 await assert.rejects(home.studioTool(run.id,'manju_context',{}),/会话已停止/);assert.equal(home.getStudioRun(run.id).status,'paused');
 assert.ok(peer.calls.some(c=>c.method==='turn/interrupt'&&c.params.turnId===run.turnId));await control(run,'cancel');
});
