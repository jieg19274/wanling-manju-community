import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createPublicKey,verify,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const LIMIT=256*1024*1024, FILE_LIMIT=32*1024*1024;
export const UPDATE_SCRIPTS=['trial-start.mjs','trial-env.mjs','network-env.mjs','agent-service.mjs','agent-cli.mjs','agent-mcp.mjs','install-agent.mjs','trial-mcp.mjs','make-trial-shortcut.ps1','storage-maintenance.mjs','prepare-upscale.mjs','extract-upscale.ps1','diagnose-login-version.ps1','auto-update.mjs','update-cli.mjs','check-studio-active.cjs'];
export const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function compareVersions(a,b){
  if(!/^\d+\.\d+\.\d+$/.test(a)||!/^\d+\.\d+\.\d+$/.test(b))throw Error('软件版本号无效');
  const x=a.split('.').map(Number),y=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;
  return 0;
}
export function appPath(root,relative){
  if(typeof relative!=='string'||relative.length>240||!relative.split('/').every(p=>/^[A-Za-z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(p)))throw Error('更新文件路径不安全');
  const allowed=relative==='release.json'||['dist/','dist-server/','adapters/'].some(prefix=>relative.startsWith(prefix))||relative.startsWith('scripts/')&&UPDATE_SCRIPTS.includes(relative.slice(8));
  if(!allowed)throw Error('更新不能替换用户数据、运行工具或更新源配置');
  return safePath(root,relative);
}
function safePath(root,relative){
  root=fs.realpathSync(root);const target=path.resolve(root,relative);
  if(!target.startsWith(root+path.sep))throw Error('更新路径越界');
  let current=root;
  for(const part of path.relative(root,target).split(path.sep)){
    current=path.join(current,part);
    try{if(fs.lstatSync(current).isSymbolicLink())throw Error('更新路径不能包含符号链接或目录联接');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return target;
}
const store=root=>safePath(root,'runtime/updates');
function json(file,fallback){try{if(fs.statSync(file).size>1024*1024)throw Error('更新记录超过限制');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
function write(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp',delays=[20,40,80,160,320];
  let committed=false;
  try{
    fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'});
    for(let attempt=0;;attempt++){
      try{fs.renameSync(temp,file);committed=true;break;}
      catch(error){
        if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=delays.length)throw error;
        // Windows readers/antivirus may briefly hold the destination open.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delays[attempt]);
      }
    }
  }finally{if(!committed)fs.rmSync(temp,{force:true});}
}
function channel(root){const c=json(safePath(root,'update-channel.json'),{}),s=json(path.join(store(root),'settings.json'),{});return {...c,...s};}
export function currentVersion(root){return json(appPath(root,'release.json'),json(safePath(root,'package.json'),{version:'0.0.0'})).version;}
export function updateStatus(root){
  const c=channel(root),state=json(path.join(store(root),'status.json'),{});
  return {currentVersion:currentVersion(root),configured:Boolean(c.manifestUrl&&c.publicKey),enabled:c.enabled!==false,status:'idle',message:c.manifestUrl&&c.publicKey?'启动后自动检查更新；新版本将在下次启动前安装':'尚未配置更新源',...state};
}
function state(root,value){write(path.join(store(root),'status.json'),{...json(path.join(store(root),'status.json'),{}),...value});return updateStatus(root);}
export function saveUpdateSettings(root,input){if(typeof input.enabled!=='boolean')throw Error('自动更新设置无效');write(path.join(store(root),'settings.json'),{...json(path.join(store(root),'settings.json'),{}),enabled:input.enabled});return state(root,{message:input.enabled?'已开启自动更新；生成任务不会被中断':'已关闭自动更新',status:json(path.join(store(root),'pending.json'),null)?'ready':'idle'});}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
async function locked(root,operation){
  const lock=path.join(store(root),'lock.json');fs.mkdirSync(path.dirname(lock),{recursive:true});
  for(let i=0;i<2;i++){
    try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});break;}
    catch(error){if(error.code!=='EEXIST')throw error;const owner=json(lock,{});if(alive(owner.pid))return {busy:true};fs.unlinkSync(lock);if(i===1)throw Error('更新锁无法取得');}
  }
  try{return await operation();}finally{if(json(lock,{}).pid===process.pid)fs.unlinkSync(lock);}
}
function safeUrl(input){
  const u=new URL(input);
  if(u.username||u.password||u.hash||!(u.protocol==='file:'||u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error('更新源必须使用 HTTPS 或本机目录');
  if(u.protocol==='file:'&&u.host)throw Error('本机更新源不能指向网络共享');
  return u;
}
async function bytes(url,maxBytes,fetcher){
  let u=safeUrl(url);
  if(u.protocol==='file:'){
    const f=fileURLToPath(u);if(fs.statSync(f).size>maxBytes)throw Error('更新文件超过大小限制');return fs.readFileSync(f);
  }
  for(let i=0;i<4;i++){
    const r=await fetcher(u,{redirect:'manual',signal:AbortSignal.timeout(20000)});
    if([301,302,303,307,308].includes(r.status)){
      const next=safeUrl(new URL(r.headers.get('location'),u));await r.body?.cancel();
      if(next.protocol!=='https:'&&!(u.protocol==='http:'&&next.origin===u.origin))throw Error('更新下载不能降级连接');u=next;continue;
    }
    if(!r.ok){await r.body?.cancel();throw Error('更新下载失败（HTTP '+r.status+'）');}
    if(Number(r.headers.get('content-length'))>maxBytes){await r.body?.cancel();throw Error('更新文件超过大小限制');}
    const chunks=[];let length=0;
    for await(const chunk of r.body){length+=chunk.length;if(length>maxBytes){throw Error('更新文件超过大小限制');}chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  throw Error('更新下载重定向过多');
}
export function verifiedManifest(root,envelope,c=channel(root)){
  const m=envelope?.manifest;
  let valid=false;
  try{const key=createPublicKey(c.publicKey);valid=key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(m)),key,Buffer.from(envelope.signature,'base64'));}catch{}
  if(!valid)throw Error('更新包发布签名校验失败');
  compareVersions(m.version,currentVersion(root));
  if(m.product!=='wanling-manju'||m.protocol!==1||m.platform!==process.platform||m.arch!==process.arch||m.minNodeMajor>Number(process.versions.node.split('.')[0]))throw Error('更新包与当前软件或运行环境不兼容');
  if(!Array.isArray(m.files)||!m.files.length||m.files.length>1000||m.basePath!==`releases/${m.version}/files/`)throw Error('更新包清单无效');
  const names=new Set();let total=0;
  for(const f of m.files){
    appPath(root,f.path);
    if(names.has(f.path.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<0||f.size>FILE_LIMIT||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('更新文件清单无效');
    names.add(f.path.toLowerCase());total+=f.size;
  }
  if(total>LIMIT||!['release.json','dist/index.html','dist-server/server/index.js'].every(f=>names.has(f)))throw Error('更新包不完整或超过大小限制');
  if(m.sharpVersion){const installed=json(safePath(root,'node_modules/sharp/package.json'),{}).version;if(installed!==m.sharpVersion)throw Error('新版本需要不同的运行依赖，请使用完整安装包');}
  const database=safePath(root,'runtime/data/studio.db');
  let schema=json(appPath(root,'release.json'),{storageSchema:6}).storageSchema??6;
  if(fs.existsSync(database)){const db=new DatabaseSync(database,{readOnly:true,timeout:5000});try{if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'").get())schema=Number(db.prepare('SELECT max(version) AS v FROM schema_versions').get().v);}finally{db.close();}}
  if(m.storageSchema!==schema)throw Error('新版本需要升级项目数据库，请使用完整安装包');
  return m;
}
export async function checkForUpdate(root,{force=false,fetcher=fetch}={}){
  if(fs.existsSync(path.join(store(root),'transaction.json')))return updateStatus(root);
  return locked(root,async()=>{
    const c=channel(root),old=updateStatus(root);
    if(c.enabled===false&&!force)return old;
    if(!c.manifestUrl||!c.publicKey)return old;
    if(!force&&old.lastCheckedAt&&Date.now()-Date.parse(old.lastCheckedAt)<6*60*60*1000)return old;
    state(root,{status:'checking',message:'正在检查软件更新…',progress:0});
    try{
      const feed=safeUrl(c.manifestUrl),envelope=JSON.parse((await bytes(feed,1024*1024,fetcher)).toString('utf8'));
      const m=verifiedManifest(root,envelope,c);
      if(compareVersions(m.version,currentVersion(root))<=0)return state(root,{status:'current',message:'当前已是最新版本',lastCheckedAt:new Date().toISOString(),availableVersion:undefined});
      if(!force&&c.failedVersion===m.version)return state(root,{status:'rolled_back',message:'该版本启动失败，已保留旧版；等待下一版更新',lastCheckedAt:new Date().toISOString()});
      const stage=safePath(root,`runtime/updates/packages/${m.version}`);fs.mkdirSync(stage,{recursive:true});
      state(root,{status:'downloading',message:'正在下载更新；可以继续制作',availableVersion:m.version,progress:0});
      let cursor=0,done=0;
      const downloads=await Promise.allSettled(Array.from({length:3},async()=>{
        while(cursor<m.files.length){
          const f=m.files[cursor++],target=safePath(stage,f.path);
          if(!fs.existsSync(target)||hash(fs.readFileSync(target))!==f.sha256){
            const installed=appPath(root,f.path);
            const reusable=fs.existsSync(installed)&&fs.statSync(installed).size===f.size&&hash(fs.readFileSync(installed))===f.sha256;
            const relative=m.basePath+f.path.split('/').map(encodeURIComponent).join('/');
            const payload=reusable?fs.readFileSync(installed):await bytes(new URL(relative,feed),f.size,fetcher);
            if(payload.length!==f.size||hash(payload)!==f.sha256)throw Error('更新文件完整性校验失败');
            fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target+'.part',payload);fs.renameSync(target+'.part',target);
          }
          done++;state(root,{progress:Math.round(done/m.files.length*100)});
        }
      }));
      const failure=downloads.find(r=>r.status==='rejected');if(failure)throw failure.reason;
      const release=json(path.join(stage,'release.json'),{});if(release.version!==m.version||release.updateProtocol!==1)throw Error('更新版本记录与清单不一致');
      write(path.join(store(root),'pending.json'),envelope);
      return state(root,{status:'ready',message:c.enabled===false?`${m.version} 已下载；开启自动更新后，下次启动安装`:`${m.version} 已下载，下次启动时自动安装`,availableVersion:m.version,progress:100,lastCheckedAt:new Date().toISOString()});
    }catch(error){return state(root,{status:'error',message:'更新未完成，当前版本可继续使用：'+String(error.message).slice(0,160)});}
  });
}
export function installationBusy(root){
  const file=safePath(root,'runtime/data/studio.db');if(!fs.existsSync(file))return false;
  const db=new DatabaseSync(file,{readOnly:true,timeout:5000});
  try{
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    if(tables.has('worker_lease')&&alive(db.prepare('SELECT pid FROM worker_lease WHERE id=1').get()?.pid))return true;
    for(const [t,condition]of [['jobs',"status IN ('queued','running')"],['adapter_tasks',"status='running'"],['studio_runs',"json_extract(payload,'$.status') IN ('starting','running')"],['agent_workflows',"json_extract(payload,'$.status')='running'"]])if(tables.has(t)&&db.prepare(`SELECT 1 FROM ${t} WHERE ${condition} LIMIT 1`).get())return true;
    return false;
  }finally{db.close();}
}
function rollbackFiles(root,journal){
  if(!/^backup-[A-Za-z0-9-]+$/.test(journal.backupName)||!Array.isArray(journal.files))throw Error('更新回退记录无效');
  const backup=safePath(root,'runtime/updates/'+journal.backupName);
  for(const f of journal.files){
    const target=appPath(root,f.path),saved=safePath(backup,f.path);
    if(f.existed){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(saved,target);}
    else if(fs.existsSync(target))fs.unlinkSync(target);
  }
  const settings=json(path.join(store(root),'settings.json'),{});write(path.join(store(root),'settings.json'),{...settings,failedVersion:journal.version});
  fs.unlinkSync(path.join(store(root),'transaction.json'));
  const pending=path.join(store(root),'pending.json');if(fs.existsSync(pending))fs.unlinkSync(pending);
  state(root,{status:'rolled_back',message:'新版启动失败，已自动恢复旧版；项目和密钥保留',availableVersion:journal.version});
}
export async function prepareStartupUpdate(root){
  return locked(root,async()=>{
    if(installationBusy(root))return {applied:false,deferred:true};
    const transaction=path.join(store(root),'transaction.json'),interrupted=json(transaction,null);
    if(interrupted){rollbackFiles(root,interrupted);return {applied:false,recovered:true};}
    if(channel(root).enabled===false)return {applied:false};
    const pending=json(path.join(store(root),'pending.json'),null);if(!pending)return {applied:false};
    try{
      const m=verifiedManifest(root,pending);if(compareVersions(m.version,currentVersion(root))<=0)return {applied:false};
      const stage=safePath(root,`runtime/updates/packages/${m.version}`);
      for(const f of m.files){const file=safePath(stage,f.path);if(!fs.existsSync(file)||fs.statSync(file).size!==f.size||hash(fs.readFileSync(file))!==f.sha256)throw Error('已下载更新的完整性校验失败');}
      const backupName='backup-'+randomUUID(),backup=safePath(root,'runtime/updates/'+backupName);fs.mkdirSync(backup,{recursive:true});
      const files=m.files.map(f=>({path:f.path,existed:fs.existsSync(appPath(root,f.path))}));
      for(const f of files)if(f.existed){const saved=safePath(backup,f.path);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(appPath(root,f.path),saved);}
      const database=safePath(root,'runtime/data/studio.db');
      if(fs.existsSync(database)){const db=new DatabaseSync(database,{readOnly:true,timeout:5000});try{db.exec(`VACUUM INTO '${safePath(backup,'studio.db').replaceAll("'","''")}'`);}finally{db.close();}}
      const journal={version:m.version,backupName,files,phase:'applying'};write(transaction,journal);
      try{
        for(const f of m.files){const target=appPath(root,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(safePath(stage,f.path),target+'.update-new');fs.renameSync(target+'.update-new',target);}
        write(transaction,{...journal,phase:'awaiting-health'});
        return {applied:true,version:m.version,backupName};
      }catch(error){rollbackFiles(root,journal);throw error;}
    }catch(error){state(root,{status:'error',message:'未安装更新，继续使用旧版：'+String(error.message).slice(0,160)});return {applied:false};}
  });
}
export async function rollbackStartupUpdate(root){return locked(root,async()=>{if(installationBusy(root))throw Error('软件仍在运行，不能回退');const j=json(path.join(store(root),'transaction.json'),null);if(j)rollbackFiles(root,j);});}
export async function commitStartupUpdate(root){return locked(root,async()=>{const j=json(path.join(store(root),'transaction.json'),null);if(!j)return;fs.unlinkSync(path.join(store(root),'transaction.json'));const p=path.join(store(root),'pending.json');if(fs.existsSync(p))fs.unlinkSync(p);state(root,{status:'updated',message:'已自动更新至 '+currentVersion(root),availableVersion:undefined});});}
export async function launchWithUpdate(root,startAndVerify){
  const prepared=await prepareStartupUpdate(root);
  try{const value=await startAndVerify(prepared.applied?prepared.version:undefined);if(prepared.applied)await commitStartupUpdate(root);return value;}
  catch(error){if(!prepared.applied)throw error;await rollbackStartupUpdate(root);return startAndVerify();}
}
