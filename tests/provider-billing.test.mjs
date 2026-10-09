import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
test('公开价格可独立读取；令牌不限额和查询失败均不伪造账户钱包余额',async()=>{
 const requests=[];let denyQuota=false,accountMode='off',unlimited=true;
 const supplier=http.createServer((req,res)=>{requests.push({path:req.url,method:req.method,auth:req.headers.authorization});res.setHeader('Content-Type','application/json');
  if(req.url==='/api/usage/token'){res.statusCode=301;res.setHeader('Location','/api/usage/token/');res.end();}
  else if(req.url==='/api/usage/token/'){if(denyQuota){res.statusCode=401;res.end(JSON.stringify({success:false}));}else res.end(JSON.stringify({success:true,data:{total_available:unlimited?-100:100000,total_used:100,unlimited_quota:unlimited,expires_at:0}}));}
  else if(req.url==='/api/user/self'&&accountMode==='user')res.end(JSON.stringify({success:true,data:{quota:200000,group:'standard',username:'must-not-be-returned'}}));
  else if(req.url==='/dashboard/billing/subscription'&&accountMode!=='off')res.end(JSON.stringify({object:'billing_subscription',has_payment_method:true,hard_limit_usd:accountMode==='token'?100000000:2,access_until:0}));
  else if(req.url==='/dashboard/billing/usage'&&accountMode!=='off')res.end(JSON.stringify({object:'list',total_usage:50}));
  else if(req.url==='/api/pricing')res.end(JSON.stringify({success:true,pricing_version:'v1',group_ratio:{standard:2},data:[{model_name:'video',quota_type:1,model_price:1,description:'不得展示的供应商成本和涨价说明',enable_groups:['standard']}]}));
  else if(req.url==='/api/status')res.end(JSON.stringify({success:true,data:{quota_display_type:'CUSTOM',quota_per_unit:500000,custom_currency_symbol:'积分',custom_currency_exchange_rate:730}}));
  else{res.statusCode=404;res.end('{}');}});
 await new Promise(r=>supplier.listen(0,'127.0.0.1',r));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manju-billing-')),base='http://127.0.0.1:'+port;
 const env={...process.env,MANJU_PORT:String(port),MANJU_DATA_DIR:path.join(root,'data'),MANJU_BACKUP_DIR:path.join(root,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(root,'drafts'),MANJU_CATALOG_API_BASE_URL:'http://127.0.0.1:'+supplier.address().port+'/v1',MANJU_DIRECT_API_BASE_URL:'http://127.0.0.1:1',MANJU_MUMU_BASE_URL:'http://127.0.0.1:1'};delete env.NODE_OPTIONS;
 const app=spawn(process.execPath,['dist-server/server/index.js'],{env,windowsHide:true,stdio:'ignore'});
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready);
  let b=await fetch(base+'/api/direct-provider/billing').then(r=>r.json());assert.equal(b.prices.length,1);assert.ok(b.credentialError);assert.equal(b.quota,undefined);assert.equal(b.accountBalanceAvailable,false);assert.ok(!requests.some(r=>r.path==='/api/usage/token'));
  const saved=await fetch(base+'/api/direct-provider',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:'mock-billing-key-local-only'})});assert.ok(saved.ok);
  b=await fetch(base+'/api/direct-provider/billing?refresh=1').then(r=>r.json());assert.equal(b.quota.unlimited,true);assert.equal(b.accountBalanceAvailable,false);assert.equal(b.currency,'积分');assert.equal(b.pricingVersion,'v1');assert.equal(b.credentialError,undefined);
  assert.ok(requests.filter(r=>['/api/pricing','/api/status'].includes(r.path)).every(r=>!r.auth));assert.ok(requests.every(r=>r.method==='GET'));
  assert.ok(requests.some(r=>r.path==='/api/usage/token/'&&r.auth));assert.ok(!requests.some(r=>r.path==='/api/usage/token'));
  assert.match(b.accountBalanceError,/网页登录.*授权同步/);
  assert.ok(!JSON.stringify(b).includes('成本'));assert.ok(!JSON.stringify(b).includes('涨价'));
  accountMode='user';b=await fetch(base+'/api/direct-provider/billing?refresh=1').then(r=>r.json());assert.equal(b.accountBalanceAvailable,true);assert.equal(b.accountBalance.available,292);assert.equal(b.group,'standard');assert.ok(!JSON.stringify(b).includes('must-not-be-returned'));
  accountMode='billing';b=await fetch(base+'/api/direct-provider/billing?refresh=1').then(r=>r.json());assert.equal(b.accountBalance.available,1095);assert.equal(b.accountBalance.source,'billing');
  accountMode='token';b=await fetch(base+'/api/direct-provider/billing?refresh=1').then(r=>r.json());assert.equal(b.accountBalanceAvailable,false);assert.equal(b.accountBalance,undefined);
  accountMode='billing';unlimited=false;b=await fetch(base+'/api/direct-provider/billing?refresh=1').then(r=>r.json());assert.equal(b.accountBalanceAvailable,false);assert.equal(b.quota.unlimited,false);
  accountMode='off';
  denyQuota=true;b=await fetch(base+'/api/direct-provider/billing?refresh=1').then(r=>r.json());assert.equal(b.quota,undefined);assert.match(b.quotaError,/HTTP 401/);assert.equal(b.prices.length,1);assert.equal(b.accountBalanceAvailable,false);
 }finally{await new Promise(r=>{app.once('exit',r);app.kill();});await new Promise(r=>supplier.close(r));}
});

test('价格标签只含单价和单位，不包含服务商描述或定价倍率',async()=>{
 const {modelPriceLabel,billingQuote}=await import('../dist-server/shared/provider-billing.js');
 const billing={currency:'积分',conversion:730,quotaPerUnit:500000,group:'standard',prices:[
  {model:'text',quotaType:0,modelRatio:.5,completionRatio:5,description:'成本和涨价说明',groups:[{name:'standard',ratio:1},{name:'other',ratio:2}]},
  {model:'image',quotaType:1,modelPrice:.004,description:'供应商成本',groups:[{name:'standard',ratio:1.25}]},
  {model:'video',quotaType:2,modelPrice:0,expression:'tier("video", u("seconds") * 0.156 / 7.3)',description:'倍率说明',groups:[{name:'standard',ratio:2.5}]}]};
 assert.equal(modelPriceLabel(billing,'text','text'),'输入 730 积分 / 百万 Token · 输出 3,650 积分 / 百万 Token');
 assert.equal(modelPriceLabel(billing,'image','image'),'3.65 积分 / 张');
 assert.equal(modelPriceLabel(billing,'video','video'),'39 积分 / 秒');
 for(const kind of ['text','image','video'])assert.doesNotMatch(modelPriceLabel(billing,kind,kind),/成本|涨价|倍率|1\.25|730–730/);
 assert.equal(billingQuote(billing,'text').known,false);
 assert.equal(modelPriceLabel(undefined,'image','image'),'暂无价格');
});
