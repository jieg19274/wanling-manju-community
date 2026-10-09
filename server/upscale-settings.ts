import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir } from './store.js';
import { terminateChild } from './process-contract.js';

const settingsFile = path.join(dataDir, 'upscale-settings.json');
export const managedUpscaleDirectory = () => path.join(path.dirname(dataDir),'tools','universal-upscaler');
type Setup = {status:'idle'|'preparing'|'ready'|'error';progress:number;message:string};
let setup:Setup={status:'idle',progress:0,message:''};
let setupRunning=false;
export type UpscaleSettings = {toolDirectory:string;ready:boolean;version?:string;mode:'auto'|'custom';message:string;checkedAt?:string;setup:Setup};
function savedSettings():{toolDirectory?:string;mode?:string;checkedAt?:string} {
  try{return JSON.parse(readFileSync(settingsFile,'utf8'));}catch{return {};}
}
function toolAt(directory:string) {
  if(!path.isAbsolute(directory))return undefined;
  try {
    const root=path.resolve(directory),manifest=JSON.parse(readFileSync(path.join(root,'upscale-tool.json'),'utf8'));
    if(manifest.id!=='wanling-universal-upscaler'||manifest.protocolVersion!==1||manifest.entry!=='cli.mjs')return undefined;
    if(root===managedUpscaleDirectory()){
      if(setupRunning||!existsSync(path.join(root,'setup-complete.json')))return undefined;
      if(JSON.parse(readFileSync(path.join(root,'setup-complete.json'),'utf8')).protocolVersion!==1)return undefined;
    }
    const files=['upscale-tool.json','cli.mjs','core.mjs','tools/node/node.exe','tools/ffmpeg/bin/ffmpeg.exe','tools/ffmpeg/bin/ffprobe.exe',
      'tools/realesrgan/realesrgan-ncnn-vulkan.exe','tools/realesrgan/models/realesr-animevideov3-x2.bin','tools/realesrgan/models/realesr-animevideov3-x2.param'];
    if(!files.every(f=>{const file=path.join(root,f);return existsSync(file)&&statSync(file).isFile()&&statSync(file).size>0;}))return undefined;
    return {root,version:String(manifest.version),node:path.join(root,'tools/node/node.exe'),entry:path.join(root,'cli.mjs'),
      resources:files.map(f=>{const file=path.join(root,f),s=statSync(file);return [file,s.size,s.mtimeMs];})};
  }catch{return undefined;}
}
export function configuredUpscaleTool(directory?:string) {
  if(directory!==undefined)return directory?toolAt(directory):undefined;
  const saved=savedSettings();
  if(saved.mode!=='auto'&&saved.toolDirectory){const custom=toolAt(saved.toolDirectory);if(custom)return custom;}
  for(const candidate of [managedUpscaleDirectory(),path.join(process.cwd(),'tools/universal-upscaler'),path.join(process.cwd(),'extensions/universal-upscaler')]){
    const tool=toolAt(candidate);if(tool)return tool;
  }
  return undefined;
}
export function upscaleSettings():UpscaleSettings {
  const saved=savedSettings(),tool=configuredUpscaleTool();
  return {toolDirectory:tool?.root||saved.toolDirectory||'',mode:saved.mode==='auto'||!saved.toolDirectory?'auto':'custom',
    ready:Boolean(tool),version:tool?.version,checkedAt:saved.checkedAt,setup:{...setup},
    message:setupRunning?setup.message:setup.status==='error'?setup.message:tool?'超分已就绪；导出时勾选真实 2 倍超分即可':'未找到超分组件，点一次下载即可自动连接'};
}
async function checkTool(tool:NonNullable<ReturnType<typeof toolAt>>) {
  const result=await new Promise<string>((resolve,reject)=>{
    const child=spawn(tool.node,[tool.entry,'doctor'],{cwd:tool.root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let text='',error='';const timer=setTimeout(()=>{terminateChild(child);reject(Error('超分组件检查超时'));},20_000);
    child.stdout.on('data',b=>text=(text+b).slice(-20000));child.stderr.on('data',b=>error=(error+b).slice(-2000));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(text):reject(Error('超分组件检查失败：'+error));});
  });
  const check=JSON.parse(result.trim());if(!check.ready||check.protocolVersion!==1)throw Error('超分组件检查未通过');
}
export async function saveUpscaleSettings(input:{toolDirectory?:unknown}):Promise<UpscaleSettings> {
  if(setupRunning)throw Error('正在准备超分，请完成后再更改高级设置');
  if(typeof input.toolDirectory!=='string')throw Error('请填写超分工具目录');
  const directory=input.toolDirectory.trim().replace(/^"|"$/g,'');
  if(directory&&!path.isAbsolute(directory))throw Error('请填写完整目录，例如 D:\\工具\\万灵通用超分');
  const tool=directory?toolAt(directory):undefined;
  if(directory&&!tool)throw Error('未找到完整独立工具；可以留空恢复自动识别');
  if(tool)await checkTool(tool);
  const saved={mode:directory?'custom':'auto',toolDirectory:directory?path.resolve(directory):'',checkedAt:new Date().toISOString()};
  const pending=settingsFile+'.'+randomUUID()+'.tmp';writeFileSync(pending,JSON.stringify(saved,null,2));renameSync(pending,settingsFile);
  setup={status:'idle',progress:0,message:''};return upscaleSettings();
}
export function startUpscaleSetup():UpscaleSettings {
  if(setupRunning)return upscaleSettings();
  if(configuredUpscaleTool()){setup={status:'ready',progress:100,message:'超分已就绪'};return upscaleSettings();}
  const script=path.join(process.cwd(),'scripts/prepare-upscale.mjs');
  if(!existsSync(script)){setup={status:'error',progress:0,message:'超分组件入口缺失，请完整覆盖升级包后重新启动'};return upscaleSettings();}
  setupRunning=true;setup={status:'preparing',progress:0,message:'正在准备超分组件…'};
  const child=spawn(process.execPath,[script,'--root',process.cwd(),'--target',managedUpscaleDirectory()],
    {cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let buffer='',error='';
  const timer=setTimeout(()=>{terminateChild(child);error='超分准备超时，请检查网络后重试';},20*60_000);
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
      const event=JSON.parse(line);if(event.type==='progress')setup={status:'preparing',progress:Math.min(99,Number(event.progress)||0),message:String(event.message)};
      if(event.type==='error')error=String(event.message);
    }catch{/* Ignore non-protocol output. */}}
    if(buffer.length>20000)buffer='';
  });
  child.stderr.on('data',chunk=>error=(error+chunk.toString()).slice(-1500));
  child.on('error',e=>{clearTimeout(timer);setupRunning=false;setup={status:'error',progress:0,message:'无法启动超分准备：'+e.message};});
  child.on('close',code=>{
    clearTimeout(timer);setupRunning=false;
    if(code===0&&configuredUpscaleTool())setup={status:'ready',progress:100,message:'超分已就绪'};
    else setup={status:'error',progress:0,message:error||'超分准备未完成，请检查网络后重试'};
  });
  return upscaleSettings();
}
