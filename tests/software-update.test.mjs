import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {sign} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {publishUpdate} from '../scripts/publish-update.mjs';
import {agentSkillZip,bundledTutorial,bundledVersion} from '../dist-server/server/agent-package.js';
import {canonical,hash,appPath,checkForUpdate,currentVersion,prepareStartupUpdate,rollbackStartupUpdate,commitStartupUpdate,launchWithUpdate,updateStatus,saveUpdateSettings} from '../scripts/auto-update.mjs';

function put(root,file,value){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);return target;}
function fixture(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'manju update 中文 '));
  const source=path.join(base,'source'),install=path.join(base,'installed'),channel=path.join(base,'channel');
  for(const root of [source,install]){
    fs.mkdirSync(root,{recursive:true});put(root,'package.json',JSON.stringify({version:'0.4.10',type:'module'}));
    put(root,'node_modules/sharp/package.json','{"version":"0.35.5"}');put(root,'dist/index.html','old-ui');put(root,'dist-server/server/index.js','old-server');put(root,'release.json','{"version":"0.4.10","updateProtocol":1}');
    fs.mkdirSync(path.join(root,'adapters'));fs.mkdirSync(path.join(root,'scripts'));
  }
  put(source,'dist/index.html','new-ui');put(source,'dist-server/server/index.js','new-server');put(source,'dist/new-asset.css','new-css');
  put(source,'dist-server/server/unknown-retry.js','export const producerSecret="Sentinel_1234567890abcdef12345678";');
  put(install,'runtime/data/private-key.json','keep-private-key');put(install,'runtime/data/media/user.mp4','keep-media');
  const keyFile=path.join(base,'private/key.pem');
  const release=publishUpdate({source,channelDirectory:channel,keyFile,version:'0.4.11'});
  put(install,'update-channel.json',JSON.stringify(release.client));
  return {base,source,install,channel,keyFile,release};
}
const bytes=root=>['runtime/data/private-key.json','runtime/data/media/user.mp4'].map(f=>fs.readFileSync(path.join(root,f),'utf8'));

test('签名更新携带正式特效资源，旧目录不干扰新版，回退后仍可读取旧目录',async()=>{
  const f=fixture(),privateData=bytes(f.install),oldDescription='旧目录固定四条锁链',newDescription='正式原句锁定材质、数量与接触部位';
  const catalogs=description=>({
    'effect-library-source.json':{effects:[{id:'bundled-test',name:'隔离特效',category:'test',prompt:'正式动作'}]},
    'effect-library-frame-local.json':{version:'test',effects:[]},
    'effect-library-adaptations.json':{version:'test',effects:[{id:'bundled-test',visual_details:description}]}
  });
  for(const root of [f.source,f.install]){
    fs.mkdirSync(path.join(root,'dist-server/server'),{recursive:true});
    fs.copyFileSync(path.resolve('dist-server/server/effects.js'),path.join(root,'dist-server/server/effects.js'));
    fs.cpSync(path.resolve('dist-server/shared'),path.join(root,'dist-server/shared'),{recursive:true});
  }
  for(const [name,data]of Object.entries(catalogs(oldDescription)))put(f.install,'catalog/'+name,JSON.stringify(data));
  for(const [name,data]of Object.entries(catalogs(newDescription)))put(f.source,'dist-server/bundled/catalog/'+name,JSON.stringify(data));
  const readDescription=()=>execFileSync(process.execPath,['--input-type=module','-e',"const e=await import('./dist-server/server/effects.js');process.stdout.write(e.visualDescription('bundled-test'))"],{cwd:f.install,windowsHide:true,encoding:'utf8'});
  assert.equal(readDescription(),oldDescription);
  const release=publishUpdate({source:f.source,channelDirectory:f.channel,keyFile:f.keyFile,version:'0.4.12'});
  const signed=JSON.parse(fs.readFileSync(release.feed,'utf8'));
  for(const name of Object.keys(catalogs(newDescription)))assert.ok(signed.manifest.files.some(f=>f.path==='dist-server/bundled/catalog/'+name));
  put(f.install,'update-channel.json',JSON.stringify(release.client));
  assert.equal((await checkForUpdate(f.install)).status,'ready');assert.equal((await prepareStartupUpdate(f.install)).applied,true);
  assert.equal(readDescription(),newDescription);assert.deepEqual(bytes(f.install),privateData);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'catalog/effect-library-adaptations.json'),'utf8')).effects[0].visual_details,oldDescription);
  await rollbackStartupUpdate(f.install);assert.equal(readDescription(),oldDescription);assert.deepEqual(bytes(f.install),privateData);
});

test('更新状态原子写入可承受 Windows 临时 EPERM/EBUSY 锁定',async()=>{
  const f=fixture(),target=path.join(f.install,'runtime/updates/status.json'),rename=fs.renameSync;
  let faults=0;
  fs.renameSync=(from,to)=>{if(to===target&&faults<3){const error=Object.assign(new Error('模拟短暂文件占用'),{code:faults++%2?'EBUSY':'EPERM'});throw error;}return rename(from,to);};
  try{
    assert.equal((await checkForUpdate(f.install)).status,'ready');assert.equal(faults,3);
    assert.equal(fs.readdirSync(path.dirname(target)).some(name=>name.endsWith('.tmp')),false);
    assert.equal(currentVersion(f.install),'0.4.10');assert.deepEqual(bytes(f.install),['keep-private-key','keep-media']);
  }finally{fs.renameSync=rename;}
});
test('持续占用时保留旧记录并清理临时文件，解除占用后可继续',()=>{
  const f=fixture(),target=put(f.install,'runtime/updates/status.json',JSON.stringify({status:'idle',message:'原记录'})),before=fs.readFileSync(target),rename=fs.renameSync;
  let attempts=0;
  fs.renameSync=(from,to)=>{if(to===target){attempts++;throw Object.assign(new Error('持续占用'),{code:'EPERM'});}return rename(from,to);};
  try{
    assert.throws(()=>saveUpdateSettings(f.install,{enabled:false}),/持续占用/);
    assert.equal(attempts,6);assert.deepEqual(fs.readFileSync(target),before);
    assert.equal(fs.readdirSync(path.dirname(target)).some(name=>name.endsWith('.tmp')),false);
    assert.deepEqual(bytes(f.install),['keep-private-key','keep-media']);
  }finally{fs.renameSync=rename;}
  assert.equal(saveUpdateSettings(f.install,{enabled:true}).status,'idle');
});
test('不可重试的写入错误立即返回，旧文件不被删除',()=>{
  const f=fixture(),target=put(f.install,'runtime/updates/status.json',JSON.stringify({status:'idle'})),before=fs.readFileSync(target),rename=fs.renameSync;
  let attempts=0;
  fs.renameSync=(from,to)=>{if(to===target){attempts++;throw Object.assign(new Error('磁盘错误'),{code:'EIO'});}return rename(from,to);};
  try{
    assert.throws(()=>saveUpdateSettings(f.install,{enabled:false}),/磁盘错误/);assert.equal(attempts,1);
    assert.deepEqual(fs.readFileSync(target),before);assert.equal(fs.readdirSync(path.dirname(target)).some(name=>name.endsWith('.tmp')),false);
  }finally{fs.renameSync=rename;}
});

test('签名更新同步官方技能与教程，启动失败可还原，旧目录与用户数据保留',async()=>{
  const f=fixture(),privateData=bytes(f.install);
  put(f.install,'agent/wanling-manju/SKILL.md','legacy-copy');
  for(const [root,version] of [[f.source,'0.4.12'],[f.install,'0.4.10']]){
    put(root,'dist-server/bundled/version.json',JSON.stringify({version}));
    put(root,'dist-server/bundled/wanling-manju/SKILL.md','skill-'+version);
    put(root,'dist-server/bundled/wanling-manju/scripts/run.mjs','entry-'+version);
    put(root,'dist-server/bundled/wanling-manju/references/workflow-guide.md','guide-'+version);
    put(root,'dist-server/bundled/tutorials/getting-started.md','guide-'+version);
  }
  const release=publishUpdate({source:f.source,channelDirectory:f.channel,keyFile:f.keyFile,version:'0.4.12'});
  put(f.install,'update-channel.json',JSON.stringify(release.client));
  assert.equal((await checkForUpdate(f.install)).status,'ready');
  assert.equal((await prepareStartupUpdate(f.install)).applied,true);
  assert.equal(bundledVersion(f.install),'0.4.12');assert.equal(bundledTutorial(f.install).toString(),'guide-0.4.12');
  const zip=agentSkillZip('codex',f.install);assert.ok(zip.includes(Buffer.from('skill-0.4.12')));assert.ok(zip.includes(Buffer.from('guide-0.4.12')));
  await rollbackStartupUpdate(f.install,'模拟启动失败');assert.equal(bundledVersion(f.install),'0.4.10');assert.equal(bundledTutorial(f.install).toString(),'guide-0.4.10');
  await checkForUpdate(f.install,{force:true});assert.equal((await prepareStartupUpdate(f.install)).applied,true);await commitStartupUpdate(f.install);
  assert.equal(bundledVersion(f.install),'0.4.12');assert.deepEqual(bytes(f.install),privateData);
  assert.equal(fs.readFileSync(path.join(f.install,'agent/wanling-manju/SKILL.md'),'utf8'),'legacy-copy');
});

test('签名本机发布包自动下载、启动前安装并确认，保留账户和素材',async()=>{
  const f=fixture(),privateData=bytes(f.install);
  const checked=await checkForUpdate(f.install);assert.equal(checked.status,'ready');assert.equal(currentVersion(f.install),'0.4.10');
  const prepared=await prepareStartupUpdate(f.install);assert.equal(prepared.applied,true);assert.equal(currentVersion(f.install),'0.4.11');
  assert.equal(fs.readFileSync(path.join(f.install,'dist/index.html'),'utf8'),'new-ui');
  assert.match(fs.readFileSync(path.join(f.install,'dist-server/server/unknown-retry.js'),'utf8'),/return false/);
  assert.deepEqual(bytes(f.install),privateData);
  // A newly booted server must not steal the updater lock before health is committed.
  await checkForUpdate(f.install,{force:true,fetcher:()=>{throw Error('不得在健康确认前下载');}});
  await commitStartupUpdate(f.install);assert.equal(updateStatus(f.install).status,'updated');
  assert.equal(fs.existsSync(path.join(f.install,'runtime/updates/transaction.json')),false);
});

test('有服务实例或待执行生成任务时只准备更新，不替换程序',async()=>{
  const f=fixture();await checkForUpdate(f.install);
  const file=path.join(f.install,'runtime/data/studio.db'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE worker_lease(id INTEGER,pid INTEGER);CREATE TABLE jobs(status TEXT);');
    db.prepare('INSERT INTO worker_lease VALUES(1,?)').run(process.pid);
    assert.equal((await prepareStartupUpdate(f.install)).deferred,true);assert.equal(currentVersion(f.install),'0.4.10');
    db.exec("DELETE FROM worker_lease;INSERT INTO jobs VALUES('queued');");
    assert.equal((await prepareStartupUpdate(f.install)).deferred,true);
    db.exec("UPDATE jobs SET status='completed';");assert.equal((await prepareStartupUpdate(f.install)).applied,true);
  }finally{db.close();}
  await rollbackStartupUpdate(f.install);
});

test('新版启动失败会恢复完整旧程序，停止自动重试同一失败版本',async()=>{
  const f=fixture();await checkForUpdate(f.install);let starts=0;
  const result=await launchWithUpdate(f.install,async expected=>{
    starts++;
    if(expected){assert.equal(currentVersion(f.install),'0.4.11');throw Error('模拟新版启动失败');}
    assert.equal(currentVersion(f.install),'0.4.10');return 'old-healthy';
  });
  assert.equal(result,'old-healthy');assert.equal(starts,2);
  assert.equal(fs.readFileSync(path.join(f.install,'dist/index.html'),'utf8'),'old-ui');
  assert.equal(fs.existsSync(path.join(f.install,'dist/new-asset.css')),false);
  assert.equal(updateStatus(f.install).status,'rolled_back');
  const status=path.join(f.install,'runtime/updates/status.json'),s=JSON.parse(fs.readFileSync(status,'utf8'));delete s.lastCheckedAt;fs.writeFileSync(status,JSON.stringify(s));
  assert.equal((await checkForUpdate(f.install)).status,'rolled_back');assert.deepEqual(bytes(f.install),['keep-private-key','keep-media']);
});

test('安装过程或健康确认前中断，下次启动先回退',async()=>{
  const f=fixture();await checkForUpdate(f.install);await prepareStartupUpdate(f.install);
  assert.equal(currentVersion(f.install),'0.4.11');assert.equal((await prepareStartupUpdate(f.install)).recovered,true);
  assert.equal(currentVersion(f.install),'0.4.10');
});

test('签名错误、文件篡改、错误依赖、数据库版本变化与版本降级不安装',async()=>{
  for(const mode of ['signature','payload','dependency','schema','downgrade']){
    const f=fixture();
    if(mode==='signature'){const feed=JSON.parse(fs.readFileSync(f.release.feed,'utf8'));feed.manifest.version='0.4.12';fs.writeFileSync(f.release.feed,JSON.stringify(feed));}
    if(mode==='payload')put(f.channel,'releases/0.4.11/files/dist/index.html','corrupted');
    if(mode==='dependency')put(f.install,'node_modules/sharp/package.json','{"version":"0.99.0"}');
    if(mode==='schema'){const envelope=JSON.parse(fs.readFileSync(f.release.feed,'utf8'));envelope.manifest.storageSchema=7;envelope.signature=sign(null,Buffer.from(canonical(envelope.manifest)),fs.readFileSync(f.keyFile)).toString('base64');fs.writeFileSync(f.release.feed,JSON.stringify(envelope));}
    if(mode==='downgrade')put(f.install,'release.json','{"version":"0.5.0","updateProtocol":1}');
    const status=await checkForUpdate(f.install);
    assert.equal(status.status,mode==='downgrade'?'current':'error',mode);
    assert.equal((await prepareStartupUpdate(f.install)).applied,false,mode);
    assert.equal(fs.readFileSync(path.join(f.install,'dist/index.html'),'utf8'),'old-ui');
  }
});

test('下载后文件被替换、关闭自动更新或收到越界清单时不能安装',async()=>{
  const f=fixture();await checkForUpdate(f.install);
  put(f.install,'runtime/updates/packages/0.4.11/dist/index.html','tampered');
  assert.equal((await prepareStartupUpdate(f.install)).applied,false);
  await checkForUpdate(f.install,{force:true});saveUpdateSettings(f.install,{enabled:false});
  assert.match((await checkForUpdate(f.install,{force:true})).message,/开启自动更新后/);
  assert.equal((await prepareStartupUpdate(f.install)).applied,false);assert.equal(currentVersion(f.install),'0.4.10');
  const envelope=JSON.parse(fs.readFileSync(f.release.feed,'utf8'));
  for(const bad of ['../escape.js','runtime/data/private-key.json','scripts/not-an-updater.mjs','dist/CON.txt','dist/a\\b.js','dist/a/../b.js']){
    assert.throws(()=>appPath(f.install,bad));
  }
  envelope.manifest.files.push({path:'runtime/data/private-key.json',size:1,sha256:hash('x')});
  envelope.signature=sign(null,Buffer.from(canonical(envelope.manifest)),fs.readFileSync(f.keyFile)).toString('base64');
  put(f.channel,'update.json',JSON.stringify(envelope));saveUpdateSettings(f.install,{enabled:true});
  assert.equal((await checkForUpdate(f.install,{force:true})).status,'error');
});

test('HTTPS清单及文件可通过同一更新协议下载；断线不改变旧程序',async()=>{
  const f=fixture();
  put(f.install,'update-channel.json',JSON.stringify({...f.release.client,manifestUrl:'https://updates.example/update.json'}));
  const fetcher=async input=>{
    const u=new URL(input);assert.equal(u.protocol,'https:');
    const local=path.join(f.channel,decodeURIComponent(u.pathname).slice(1));
    return new Response(fs.readFileSync(local),{status:200});
  };
  assert.equal((await checkForUpdate(f.install,{fetcher})).status,'ready');
  const g=fixture();put(g.install,'update-channel.json',JSON.stringify({...g.release.client,manifestUrl:'https://updates.example/update.json'}));
  let calls=0;
  const broken=async input=>{calls++;if(new URL(input).pathname==='/update.json')return new Response(fs.readFileSync(g.release.feed));throw Error('模拟断线');};
  assert.equal((await checkForUpdate(g.install,{fetcher:broken})).status,'error');assert.equal(currentVersion(g.install),'0.4.10');assert.ok(calls>1);
});

test('同目录同时检查只允许一个下载者，失败后等待全部下载退出再释放锁',async()=>{
  const f=fixture();put(f.install,'update-channel.json',JSON.stringify({...f.release.client,manifestUrl:'https://updates.example/update.json'}));
  let release,started;const firstStarted=new Promise(r=>{started=r;}),gate=new Promise(r=>{release=r;});
  const fetcher=async input=>{if(new URL(input).pathname==='/update.json'){started();await gate;return new Response(fs.readFileSync(f.release.feed));}throw Error('模拟下载失败');};
  const first=checkForUpdate(f.install,{fetcher});await firstStarted;
  assert.equal((await checkForUpdate(f.install,{force:true,fetcher})).busy,true);
  release();assert.equal((await first).status,'error');assert.equal(fs.existsSync(path.join(f.install,'runtime/updates/lock.json')),false);
});

test('安装目录的联接及失效符号链接不能使更新写入外部目录',{skip:process.platform==='win32'&&process.env.MANJU_TEST_SKIP_SYMLINK==='1'},()=>{
  const f=fixture(),outside=path.join(f.base,'external');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(f.install,'dist/link'),'junction');
  assert.throws(()=>appPath(f.install,'dist/link/escaped.js'),/符号链接|联接/);
  const missing=path.join(f.base,'does-not-exist');fs.symlinkSync(missing,path.join(f.install,'dist/broken'),'junction');
  assert.throws(()=>appPath(f.install,'dist/broken/escaped.js'),/符号链接|联接/);
});

test('真实新版进程启动失败后旧服务能重新启动，用户文件未变',async()=>{
  const f=fixture();
  const oldServer="import http from 'node:http';const s=http.createServer((q,r)=>r.end('old-healthy'));s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port})));";
  put(f.install,'dist-server/server/index.js',oldServer);
  const failed="throw Error('simulated update boot failure');";
  // Sign a distinct next release after changing its entry point.
  put(f.source,'dist-server/server/index.js',failed);
  const next=publishUpdate({source:f.source,channelDirectory:f.channel,keyFile:f.keyFile,version:'0.4.12'});
  put(f.install,'update-channel.json',JSON.stringify(next.client));await checkForUpdate(f.install);
  const children=[];
  try{
    const result=await launchWithUpdate(f.install,async()=>{
      const child=spawn(process.execPath,[path.join(f.install,'dist-server/server/index.js')],{cwd:f.install,windowsHide:true,stdio:['ignore','pipe','ignore']});children.push(child);
      const port=await new Promise((resolve,reject)=>{
        let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n'))resolve(JSON.parse(buffer.trim()).port);});
        child.once('error',reject);child.once('exit',()=>reject(Error('服务未启动就退出')));
      });
      return fetch('http://127.0.0.1:'+port).then(r=>r.text());
    });
    assert.equal(result,'old-healthy');assert.equal(children.length,2);assert.equal(currentVersion(f.install),'0.4.10');assert.deepEqual(bytes(f.install),['keep-private-key','keep-media']);
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  }
});
