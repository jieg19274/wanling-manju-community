// Small compatibility bridge: the independent tool owns its runtime and protocol.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const [requestFile,outputFile]=process.argv.slice(2);
try {
  const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
  const root=path.resolve(request.toolDirectory||'');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'upscale-tool.json'),'utf8'));
  if(manifest.id!=='wanling-universal-upscaler'||manifest.protocolVersion!==1||manifest.entry!=='cli.mjs')throw Error('不兼容的独立超分接口');
  const contract={protocolVersion:1,sourcePath:path.resolve(request.sourcePath),outputPath:path.resolve(outputFile),mediaType:'video',scale:2,preserveOriginalAudio:true};
  const contractFile=outputFile+'.v1.json';fs.writeFileSync(contractFile,JSON.stringify(contract));
  let child;
  try {
    await new Promise((resolve,reject)=>{
      child=spawn(path.join(root,'tools/node/node.exe'),[path.join(root,'cli.mjs'),'run',contractFile],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let error='',buffer='';child.stdout.on('data',b=>{process.stdout.write(b);buffer+=b.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const e=JSON.parse(line);if(e.type==='error')error=e.message;}catch{}}});
      child.stderr.on('data',b=>error=(error+b).slice(-3000));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(error||'独立超分工具失败')));
      for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>{
        if(child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});else child.kill('SIGTERM');}
      });
    });
  } finally {if(fs.existsSync(contractFile))fs.unlinkSync(contractFile);}
}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
