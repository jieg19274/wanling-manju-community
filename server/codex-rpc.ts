import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {terminateChild} from './process-contract.js';

export function codexCommand():{file:string;args:string[]}|undefined {
  const configured=process.env.MANJU_CODEX_EXECUTABLE;
  if(configured)return existsSync(configured)?{file:configured,args:[]}:undefined;
  const npm=path.join(process.env.APPDATA||'', 'npm/node_modules/@openai/codex/bin/codex.js');
  if(process.platform==='win32'&&existsSync(npm))return {file:process.execPath,args:[npm]};
  for(const directory of (process.env.PATH||'').split(path.delimiter)){
    const file=path.join(directory,process.platform==='win32'?'codex.exe':'codex');
    if(existsSync(file))return {file,args:[]};
  }
  if(process.platform==='win32'){
    const managed=path.join(process.env.LOCALAPPDATA||'','OpenAI/Codex/bin');
    try{
      const candidates=readdirSync(managed,{withFileTypes:true}).filter(entry=>entry.isDirectory())
        .map(entry=>path.join(managed,entry.name,'codex.exe')).filter(file=>existsSync(file)&&statSync(file).isFile())
        .sort((left,right)=>statSync(right).mtimeMs-statSync(left).mtimeMs);
      if(candidates[0])return {file:candidates[0],args:[]};
    }catch{/* Older desktop installations use the compatibility path below. */}
  }
  const desktop=path.join(process.env.LOCALAPPDATA||'','Programs/OpenAI/Codex/bin/codex.exe');
  return existsSync(desktop)?{file:desktop,args:[]}:undefined;
}
export class CodexRpc {
  private child?:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  onMessage:(message:any)=>void=()=>{};
  onDisconnect:(error:Error)=>void=()=>{};
  async connect(){
    if(this.child)return;
    const command=codexCommand();if(!command)throw Error('未找到 Codex，请先安装 Codex CLI 或桌面版并完成登录。');
    // These overrides apply only to this owned child, never to the user's Codex settings.
    const overrides=['mcp_servers={}','web_search="disabled"',...['shell_tool','view_image','multi_agent','apps','plugins','browser_use','computer_use','image_generation','code_mode'].map(feature=>`features.${feature}=false`)];
    this.child=spawn(command.file,[...command.args,'app-server','--listen','stdio://',...overrides.flatMap(value=>['-c',value])],{windowsHide:true,stdio:'pipe'});
    const child=this.child;
    const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
    lines.on('line',line=>{
      if(line.length>32_000_000){this.close();return;}
      let message:any;try{message=JSON.parse(line);}catch{return;}
      if(message.id!==undefined&&!message.method){
        const pending=this.pending.get(message.id);if(!pending)return;
        clearTimeout(pending.timer);this.pending.delete(message.id);
        if(message.error)pending.reject(Error(String(message.error.message||'Codex 接口失败')));else pending.resolve(message.result);
      }else this.onMessage(message);
    });
    // Drain stderr without exposing account tokens or unrelated local paths.
    child.stderr.on('data',()=>{});
    const disconnected=(error:Error)=>{
      if(this.child!==child)return;this.child=undefined;
      for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();
      this.onDisconnect(error);
    };
    child.on('error',()=>disconnected(Error('Codex 启动失败，请检查安装后重试。')));
    child.on('exit',()=>disconnected(Error('Codex 连接已中断，任务进度已保存。')));
    await this.request('initialize',{clientInfo:{name:'wanling_manju',title:'万灵漫剧',version:'0.4.8'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized'});
  }
  send(message:unknown){if(!this.child?.stdin.writable)throw Error('Codex 未连接');this.child.stdin.write(JSON.stringify(message)+'\n');}
  request(method:string,params:unknown={}):Promise<any>{
    const requestId=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('Codex 响应超时；请核对任务状态后继续。'));},30_000);
      this.pending.set(requestId,{resolve,reject,timer});
      try{this.send({id:requestId,method,params});}catch(error){clearTimeout(timer);this.pending.delete(requestId);reject(error);}
    });
  }
  respond(requestId:string|number,result:unknown){this.send({id:requestId,result});}
  close(){const child=this.child;this.child=undefined;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Codex 连接已关闭'));}this.pending.clear();if(child)terminateChild(child);}
}
