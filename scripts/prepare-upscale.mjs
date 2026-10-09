// Runs only after the user clicks Download. Startup detection never invokes this script.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const root=path.resolve(option('--root')||path.join(import.meta.dirname,'..'));
let target,work,part,release;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const progress=(value,message)=>emit({type:'progress',progress:value,message});
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fail(message){throw Error(message);}
function copyAtomic(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});if(fs.existsSync(to)&&hash(from)===hash(to))return;const temp=to+'.'+randomUUID()+'.tmp';fs.copyFileSync(from,temp);fs.renameSync(temp,to);}
function lock(file){
  if(fs.existsSync(file))try{const text=fs.readFileSync(file,'utf8'),owner=JSON.parse(text);let gone=false;if(Number.isInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(e){gone=e.code==='ESRCH';}if(gone&&fs.readFileSync(file,'utf8')===text)fs.unlinkSync(file);}catch{}
  const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);return ()=>fs.unlinkSync(file);
}
try {
  if(process.platform!=='win32')fail('当前自动准备只支持 Windows x64');
  if(!args.includes('--target')||!path.isAbsolute(option('--target')||''))fail('缺少完整组件目录');
  target=path.resolve(option('--target'));
  if(target===root||root.startsWith(target+path.sep))fail('组件目录不能覆盖软件目录');
  fs.mkdirSync(target,{recursive:true});target=fs.realpathSync(target);
  release=lock(path.join(target,'.setup.lock'));
  const engineLock=path.join(target,'runtime/engine.lock');
  if(fs.existsSync(engineLock)){
    const owner=JSON.parse(fs.readFileSync(engineLock,'utf8'));let alive=true;
    if(!Number.isInteger(owner.pid)||owner.pid<=0)fail('超分运行锁异常，请完成任务后再准备组件');
    try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive)fail('超分任务正在运行，请完成后再准备组件');
  }
  const source=path.join(root,'extensions/universal-upscaler');
  const identity=JSON.parse(fs.readFileSync(path.join(source,'upscale-tool.json'),'utf8'));
  if(identity.id!=='wanling-universal-upscaler'||identity.protocolVersion!==1)fail('内置超分入口不兼容');
  if(fs.existsSync(path.join(target,'upscale-tool.json'))){const saved=JSON.parse(fs.readFileSync(path.join(target,'upscale-tool.json'),'utf8'));if(saved.id!==identity.id||saved.protocolVersion!==1)fail('已有组件接口不兼容，请使用高级设置连接其他目录');}
  progress(2,'正在准备本机运行环境…');
  // The component owns its copy. Later software updates do not replace these files.
  for(const file of ['core.mjs','cli.mjs','upscale-tool.json','dependencies.lock.json'])if(!fs.existsSync(path.join(target,file)))copyAtomic(path.join(source,file),path.join(target,file));
  const runtimeRoot=[path.join(root,'tools'),path.join(root,'portable-tools')].find(p=>fs.existsSync(path.join(p,'node/node.exe'))&&fs.existsSync(path.join(p,'ffmpeg/bin/ffmpeg.exe')));
  if(!runtimeRoot)fail('缺少软件内置运行环境，请使用完整免安装包');
  for(const file of ['node/node.exe','node/LICENSE','ffmpeg/bin/ffmpeg.exe','ffmpeg/bin/ffprobe.exe','ffmpeg/LICENSE','ffmpeg/README.txt']){
    const from=path.join(runtimeRoot,file),to=path.join(target,'tools',file);if(fs.existsSync(from)&&!fs.existsSync(to))copyAtomic(from,to);
  }
  const dependency=JSON.parse(fs.readFileSync(path.join(source,'dependencies.lock.json'),'utf8')).realesrgan;
  if(dependency.url!=='https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip'||dependency.sha256!=='abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d')fail('超分组件下载来源或校验值不匹配');
  const downloads=path.join(target,'downloads');fs.mkdirSync(downloads,{recursive:true});
  const archive=path.join(downloads,'realesrgan-'+dependency.sha256+'.zip');
  if(!fs.existsSync(archive)||hash(archive)!==dependency.sha256){
    if(args.includes('--archive')){const local=path.resolve(option('--archive'));if(hash(local)!==dependency.sha256)fail('超分组件校验失败，未安装');copyAtomic(local,archive);}
    else {
      progress(12,'正在下载超分组件（约 45 MB）…');
      const response=await fetch(dependency.url,{signal:AbortSignal.timeout(12*60_000)});
      if(!response.ok)fail('超分组件下载失败（HTTP '+response.status+'），请检查网络后重试');
      part=archive+'.'+randomUUID()+'.part';let received=0,last=12;const digest=createHash('sha256');
      const meter=new Transform({transform(chunk,encoding,done){received+=chunk.length;if(received>60*1024*1024){done(Error('下载大小异常，已停止'));return;}digest.update(chunk);const percent=Math.min(79,12+Math.floor(received/45474481*67));if(percent>last){last=percent;progress(percent,'正在下载超分组件… '+Math.round(received/1048576)+' MB / 44 MB');}done(null,chunk);}});
      await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(part));
      if(digest.digest('hex')!==dependency.sha256)fail('超分组件校验失败，未安装；请重试');
      fs.renameSync(part,archive);part=undefined;
    }
  }
  progress(82,'正在校验并安装超分模型…');
  work=fs.mkdtempSync(path.join(target,'.extract-'));
  const extracted=spawnSync(path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/extract-upscale.ps1'),'-ArchivePath',archive,'-DestinationDirectory',work],
    {windowsHide:true,encoding:'utf8',timeout:120_000,maxBuffer:20000});
  if(extracted.status!==0)fail('超分组件解压失败：'+(extracted.error?.message||extracted.stderr).slice(-500));
  for(const file of ['realesrgan-ncnn-vulkan.exe','vcomp140.dll','vcomp140d.dll','models/realesr-animevideov3-x2.bin','models/realesr-animevideov3-x2.param'])copyAtomic(path.join(work,file),path.join(target,'tools/realesrgan',file));
  progress(96,'正在检查超分组件…');
  const checked=spawnSync(path.join(target,'tools/node/node.exe'),[path.join(target,'cli.mjs'),'doctor'],{cwd:target,windowsHide:true,encoding:'utf8',timeout:20000});
  if(checked.status!==0||!JSON.parse(checked.stdout.trim()).ready)fail('超分组件检查未通过，请完整重试下载');
  const marker=path.join(target,'setup-complete.json'),pending=marker+'.tmp';fs.writeFileSync(pending,JSON.stringify({protocolVersion:1,preparedAt:new Date().toISOString(),engineArchiveSha256:dependency.sha256}));fs.renameSync(pending,marker);
  progress(100,'超分已就绪，后续启动会自动识别');emit({type:'result',toolDirectory:target});
}catch(e){emit({type:'error',message:e.code==='EEXIST'?'超分组件正在准备，请稍候':e.message==='fetch failed'?'超分组件下载连接失败，请检查网络后重试':e.message});process.exitCode=1;}
finally{
  if(part&&fs.existsSync(part))fs.unlinkSync(part);
  if(work&&fs.existsSync(work)&&path.dirname(fs.realpathSync(work))===target&&path.basename(work).startsWith('.extract-'))fs.rmSync(work,{recursive:true,force:true});
  release?.();
}
