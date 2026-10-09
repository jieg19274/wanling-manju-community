import fs from 'node:fs';
import path from 'node:path';
import {doctor,run,fail} from './core.mjs';
let human=false;
const emit=value=>{
  if(!human){process.stdout.write(JSON.stringify(value)+'\n');return;}
  if(value.type==='progress')process.stdout.write(`${({inspect:'检查素材',extract:'抽取画面',upscale:'真实超分',encode:'合成结果',validate:'核对结果',complete:'处理完成'})[value.stage]} ${value.progress}%${value.completedFrames!==undefined?' · '+value.completedFrames+'/'+value.frames+' 帧':''}\n`);
  else if(value.type==='result')process.stdout.write(`完成：${value.width}×${value.height}\n结果：${value.outputPath}\n`);
  else if(value.type==='error')process.stdout.write(`处理失败（${value.code}）：${value.message}\n`);
};
const controller=new AbortController();
for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>controller.abort());
try {
  const [command,...args]=process.argv.slice(2);
  if(command==='doctor'){const result=doctor();if(args.includes('--human'))process.stdout.write(result.ready?'运行环境已准备好。实际处理还需要可用的 Vulkan 显卡。\n':'运行环境不完整，请运行「准备运行环境.cmd」。\n'+result.checks.filter(c=>!c.available).map(c=>c.file).join('\n')+'\n');else emit(result);if(!result.ready)process.exitCode=2;}
  else if(command==='run') {if(!args[0])fail('INVALID_REQUEST','用法：run request.json');await run(JSON.parse(fs.readFileSync(args[0],'utf8')),emit,controller.signal);}
  else if(command==='file') {
    human=true;
    if(!args[0])fail('INVALID_REQUEST','把 MP4、PNG 或 JPEG 拖到「拖入文件超分.cmd」，或 file 输入文件 [输出文件]');
    const source=path.resolve(args[0]),image=/\.(png|jpe?g)$/i.test(source);
    const output=args[1]?path.resolve(args[1]):path.join(path.dirname(source),path.parse(source).name+'_2x'+(image?'.png':'.mp4'));
    await run({protocolVersion:1,sourcePath:source,outputPath:output,mediaType:image?'image':'video',scale:2,preserveOriginalAudio:true},emit,controller.signal);
  } else fail('INVALID_REQUEST','用法：doctor | run request.json | file 输入文件 [输出文件]');
}catch(e){emit({type:'error',protocolVersion:1,code:e.code||'FAILED',message:e.message});process.exitCode=1;}
