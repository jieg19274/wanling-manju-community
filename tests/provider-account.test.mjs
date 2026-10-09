import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

test('网页登录回调同步真实钱包；单次授权、账户对应、加密持久化与撤销',async()=>{
 let quota=14000000,deny=false,offline=false,revokeCount=0,exchangeCount=0,challenge='',connected=false;
 const wallet='w'.repeat(43),code='c'.repeat(43),requests=[];
 const supplier=http.createServer(async(req,res)=>{
  requests.push({path:req.url,auth:req.headers.authorization});res.setHeader('Content-Type','application/json');
  const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.url==='/api/studio-wallet/config')return send({success:true,data:{scope:'wallet:read'}});
  if(req.url==='/api/studio-wallet/token'){
   exchangeCount++;let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
   assert.equal(createHash('sha256').update(input.code_verifier).digest('base64url'),challenge);
   assert.equal(input.code,code);assert.equal(input.client_id,'wanling-manju');connected=true;
   return send({success:true,data:{wallet_token:wallet,expires_at:Math.floor(Date.now()/1000)+3600,display_name:'测试账户'}});
  }
  if(req.url==='/api/studio-wallet/balance'){
   assert.equal(req.headers.authorization,'Bearer '+wallet);
   if(deny)return send({success:false},401);if(offline)return send({success:false},503);
   return send({success:true,data:{quota,matches_model_key:req.headers['x-api-key']==='mock-wallet-model-key'}});
  }
  if(req.url==='/api/studio-wallet/revoke'){assert.equal(req.headers.authorization,'Bearer '+wallet);revokeCount++;return send({success:true});}
  if(req.url==='/api/status')return send({success:true,data:{quota_display_type:'CUSTOM',quota_per_unit:500000,custom_currency_symbol:'积分',custom_currency_exchange_rate:730}});
  if(req.url==='/api/pricing')return send({success:true,data:[]});
  if(req.url==='/api/usage/token/')return send({success:true,data:{total_available:-100,total_used:100,unlimited_quota:true}});
  return send({},404);
 });
 await new Promise(r=>supplier.listen(0,'127.0.0.1',r));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manju-wallet-')),base='http://127.0.0.1:'+port;
 const env={...process.env,MANJU_PORT:String(port),MANJU_DATA_DIR:path.join(root,'data'),MANJU_BACKUP_DIR:path.join(root,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(root,'drafts'),MANJU_CATALOG_API_BASE_URL:'http://127.0.0.1:'+supplier.address().port+'/v1',MANJU_DIRECT_API_BASE_URL:'http://127.0.0.1:1'};delete env.NODE_OPTIONS;
 let app;
 async function start(){app=spawn(process.execPath,['dist-server/server/index.js'],{env,windowsHide:true,stdio:'ignore'});let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready);}
 async function stop(){await new Promise(r=>{app.once('exit',r);app.kill();});}
 const get=route=>fetch(base+route).then(r=>r.json());
 const post=(route,body={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
 async function begin(){const response=await post('/api/provider-account/connect');assert.ok(response.ok);const result=await response.json(),url=new URL(result.url);challenge=url.searchParams.get('code_challenge');assert.equal(url.origin,'http://127.0.0.1:'+supplier.address().port);assert.equal(url.pathname,'/studio-connect');assert.equal(url.searchParams.get('redirect_uri'),base+'/api/provider-account/callback');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal((await get('/api/provider-account')).pending,true);return url.searchParams.get('state');}
 async function callback(state){return fetch(base+'/api/provider-account/callback?'+new URLSearchParams({state,code}),{redirect:'manual'});}
 try{
  await start();assert.equal((await get('/api/provider-account')).connected,false);
  assert.equal((await fetch(base+'/api/provider-account/connect',{method:'POST',body:'{}'})).status,400);
  let state=await begin();assert.equal((await callback('x'.repeat(43))).status,400);assert.equal(exchangeCount,0);
  assert.equal((await callback('中'.repeat(43))).status,400);assert.equal(exchangeCount,0);
  let result=await callback(state);assert.equal(result.status,303);assert.equal(result.headers.get('Location'),'/?account_connected=1');assert.ok(connected);
  assert.equal((await get('/api/provider-account')).name,'测试账户');
  const file=path.join(root,'data','provider-account.json');assert.ok(!fs.readFileSync(file,'utf8').includes(wallet));
  assert.equal((await callback(state)).status,400);assert.equal(exchangeCount,1);
  let billing=await get('/api/direct-provider/billing?refresh=1');assert.equal(billing.accountBalance.available,20440);assert.equal(billing.accountBalance.source,'wallet');assert.equal(billing.accountBalance.matchesModelKey,undefined);assert.equal(billing.account.connected,true);
  await post('/api/direct-provider',{apiKey:'mock-wallet-model-key'});quota=13000000;
  billing=await get('/api/direct-provider/billing?refresh=1');assert.equal(billing.accountBalance.available,18980);assert.equal(billing.accountBalance.matchesModelKey,true);
  assert.ok(!JSON.stringify(billing).includes(wallet));
  const lastRead=billing.accountBalanceUpdatedAt;offline=true;billing=await get('/api/direct-provider/billing?refresh=1');assert.equal(billing.accountBalance.available,18980);assert.equal(billing.accountBalanceStale,true);assert.equal(billing.accountBalanceUpdatedAt,lastRead);offline=false;
  await stop();await start();assert.equal((await get('/api/provider-account')).connected,true);assert.equal((await get('/api/direct-provider/billing')).accountBalance.available,18980);
  state=await begin();assert.equal((await post('/api/provider-account/logout')).status,200);assert.equal(revokeCount,1);assert.equal((await callback(state)).status,400);assert.equal(exchangeCount,1);assert.ok(!fs.existsSync(file));
  state=await begin();assert.equal((await callback(state)).status,303);deny=true;
  billing=await get('/api/direct-provider/billing?refresh=1');assert.equal(billing.accountBalanceAvailable,false);assert.equal(billing.accountBalance,undefined);assert.equal(billing.account.connected,false);assert.match(billing.accountBalanceError,/失效/);
  assert.ok(!requests.some(r=>r.path==='/api/user/auth/logout'||r.path==='/api/user/login'));
 }finally{if(app?.exitCode===null)await stop();await new Promise(r=>supplier.close(r));}
});
