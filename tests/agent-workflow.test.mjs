import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {billingQuote} from '../dist-server/shared/provider-billing.js';

test('API 报价不执行远程表达式；分组范围、按秒费用、文字未知量及密钥额度分别显示',()=>{
 const billing={currency:'积分',conversion:730,quotaPerUnit:500000,prices:[{model:'video',quotaType:1,modelPrice:1,expression:'tier("video", u("seconds") * 0.156 / 7.3)',description:'按秒',groups:[{name:'standard',ratio:2.5}]},{model:'text',quotaType:0,modelRatio:1,completionRatio:2,description:'文字',groups:[{name:'default',ratio:1}]}]};
 const quote=billingQuote(billing,'video',2,30);assert.equal(quote.known,true);assert.ok(Math.abs(quote.maximum-2340)<.001);
 assert.equal(billingQuote(billing,'text').known,false);assert.match(billingQuote(billing,'text').description,/实际 Token 数未知/);
 billing.prices[0].expression='globalThis.process.exit()';assert.equal(billingQuote(billing,'video').known,false);
 billing.prices[0].expression='1 / 0';assert.equal(billingQuote(billing,'video').known,false);
 assert.equal(billingQuote(billing,'unknown').known,false);
});

test('分集流程复用原有核对，预算不能由 MCP 批准，幂等、输入变化、限次与重启均不重复付费',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-agent-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base='http://127.0.0.1:'+port;
 const env={...process.env,MANJU_PORT:String(port),MANJU_DATA_DIR:path.join(folder,'data'),MANJU_BACKUP_DIR:path.join(folder,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(folder,'drafts'),MANJU_MUMU_BASE_URL:'http://127.0.0.1:1'};
 const launch=()=>spawn(process.execPath,['dist-server/server/index.js'],{cwd:path.resolve('.'),env,windowsHide:true,stdio:['ignore','ignore','pipe']});let server=launch();
 let errors='';server.stderr.on('data',b=>{errors+=b;});
 const call=async(route,input,origin=false)=>{const response=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:base}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,value:await response.json()};};
 const ok=async(...args)=>{const result=await call(...args);assert.ok(result.status<300,JSON.stringify(result.value));return result.value;};
 const wait=async(predicate,route)=>{for(let i=0;i<100;i++){try{const v=await ok(route);if(predicate(v))return v;}catch{}await new Promise(r=>setTimeout(r,60));}throw Error('Timed out '+route+' '+errors);};
 try{
  await wait(v=>v.ok,'/api/health');
  let project=await ok('/api/projects',{name:'Agent 独立测试',mode:'douyin-story'});
  if(!project.episodes.length)project=await ok(`/api/projects/${project.id}/actions`,{type:'episode.add'});
  const episode=project.episodes[0],projectRoute=`/api/projects/${project.id}`;
  project=await ok(projectRoute+'/actions',{type:'project.model',kind:'text',name:'mock',modelId:'mock-text',adapterPath:path.resolve('tests/fixtures/text-adapter.mjs')});
  const route=projectRoute+'/workflows';
  const flow=await ok(route,{episodeId:episode.id,limits:{text:1,image:0,video:0}});
  assert.equal(flow.status,'waiting_review');assert.equal(flow.step.key,'source');
  assert.equal((await ok(route,{episodeId:episode.id})).id,flow.id);
  const source='林舟推开房门，看见同伴站在门外。他先问清来意，然后让同伴进屋。'.repeat(4);
  await ok(projectRoute+'/actions',{type:'episode.update',episodeId:episode.id,sourceText:source});
  await ok(projectRoute+'/actions',{type:'episode.confirmSource',episodeId:episode.id});
  let current=await ok(`${route}/${flow.id}/resume`,{});assert.equal(current.status,'waiting_budget');assert.equal(current.used.text,0);assert.equal(current.step.task,'highlight');assert.equal(current.step.preview.sourceText,source);
  assert.equal((await call(`${route}/${flow.id}/authorize`,{hash:current.step.hash,confirmed:true})).status,400);
  assert.equal((await call(`${route}/${flow.id}/authorize`,{hash:'old',confirmed:true},true)).status,400);
  await ok(projectRoute+'/actions',{type:'episode.update',episodeId:episode.id,sourceText:source+'末句。'});
  assert.equal((await call(`${route}/${flow.id}/authorize`,{hash:current.step.hash,confirmed:true},true)).status,400);
  await ok(projectRoute+'/actions',{type:'episode.confirmSource',episodeId:episode.id});
  current=await ok(`${route}/${flow.id}/resume`,{});
  const approval={hash:current.step.hash,confirmed:true};
  const duplicates=await Promise.all([call(`${route}/${flow.id}/authorize`,approval,true),call(`${route}/${flow.id}/authorize`,approval,true)]);
  assert.equal(duplicates.filter(v=>v.status<300).length,1);
  const after=await wait(v=>v[0].status==='waiting_review',route);assert.equal(after[0].used.text,1);assert.equal(after[0].history.length,1);
  project=await ok(projectRoute);assert.ok(project.episodes[0].highlightCandidate);assert.equal(project.episodes[0].highlightReport,'');assert.equal(project.episodes[0].scriptLockedHash,undefined);
  await ok(projectRoute+'/actions',{type:'episode.applyHighlightCandidate',episodeId:episode.id});
  await ok(projectRoute+'/actions',{type:'episode.confirmHighlight',episodeId:episode.id});
  current=await ok(`${route}/${flow.id}/resume`,{});assert.equal(current.step.task,'script');
  const cap=await call(`${route}/${flow.id}/authorize`,{hash:current.step.hash,confirmed:true},true);assert.equal(cap.status,400);assert.match(cap.value.error,/上限/);
  await ok(`${route}/${flow.id}/pause`,{});assert.equal((await ok(route))[0].status,'paused');
  await new Promise(r=>{server.once('exit',r);server.kill();});server=launch();server.stderr.on('data',b=>{errors+=b;});await wait(v=>v.ok,'/api/health');
  const persisted=(await ok(route))[0];assert.equal(persisted.status,'paused');assert.equal(persisted.used.text,1);assert.equal(persisted.history.length,1);
  const mcp=spawn(process.execPath,['dist-server/server/mcp.js'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';mcp.stdout.on('data',b=>{output+=b;});
  mcp.stdin.end([JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'start_workflow',arguments:{projectId:project.id,episodeId:episode.id}}}),JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'authorize_workflow',arguments:{projectId:project.id}}})].join('\n')+'\n');await new Promise(r=>mcp.once('exit',r));
  const messages=output.trim().split('\n').map(JSON.parse);assert.ok(messages[0].result.tools.some(t=>t.name==='start_workflow'));assert.ok(!messages[0].result.tools.some(t=>/authoriz|approv|lock/.test(t.name)));assert.equal(JSON.parse(messages[1].result.content[0].text).id,flow.id);assert.ok(messages[2].error);
  await ok(`${route}/${flow.id}/cancel`,{});assert.equal((await ok(route))[0].status,'cancelled');
 }finally{if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});}
});
