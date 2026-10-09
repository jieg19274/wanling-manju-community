import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const root = import.meta.dirname;
export const manifest = JSON.parse(fs.readFileSync(path.join(root, 'upscale-tool.json'), 'utf8'));
export const resources = ['tools/node/node.exe','tools/ffmpeg/bin/ffmpeg.exe','tools/ffmpeg/bin/ffprobe.exe',
  'tools/realesrgan/realesrgan-ncnn-vulkan.exe','tools/realesrgan/models/realesr-animevideov3-x2.bin',
  'tools/realesrgan/models/realesr-animevideov3-x2.param'];
const ffmpeg = path.join(root, resources[1]), ffprobe = path.join(root, resources[2]);
const engine = path.join(root, resources[3]), models = path.join(root, 'tools/realesrgan/models');
export function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
export function doctor() {
  const checks = resources.map(file => ({file, available:fs.existsSync(path.join(root,file))}));
  for (const file of [ffmpeg,ffprobe]) if (fs.existsSync(file)) {
    const result = spawnSync(file,['-version'],{windowsHide:true,encoding:'utf8',timeout:5000});
    checks.push({file:path.relative(root,file)+' (执行)',available:result.status===0,version:result.stdout?.split(/\r?\n/)[0]});
  }
  return {protocolVersion:1,version:manifest.version,engine:manifest.engine,ready:checks.every(c=>c.available),checks,
    capabilities:{media:['image','video'],scale:[2],video:'MP4 / 恒定帧率 / 无旋转元数据',image:'PNG / JPEG → PNG',
      audio:'原音轨复制',maxFrames:18000,gpu:'需要支持 Vulkan 的显卡；检测可用不等于已通过 GPU 实际推理'}};
}
function stop(child) {
  if(child.exitCode!==null)return;
  if(process.platform==='win32'&&child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
  else child.kill('SIGKILL');
}
async function command(exe,args,signal,timeoutMs=90*60_000) {
  if(signal?.aborted)fail('CANCELLED','任务已取消');
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',error='',reason;
    const cancel=()=>{reason='CANCELLED';stop(child);};
    const timer=setTimeout(()=>{reason='TIMEOUT';stop(child);},timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.on('data',b=>output=(output+b.toString()).slice(-32_000_000));
    child.stderr.on('data',b=>error=(error+b.toString()).slice(-3000));
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
    child.on('error',e=>{finish();e.code='PROCESS_START_FAILED';reject(e);});
    child.on('close',code=>{finish();if(code===0&&!reason)resolve(output);else{
      const e=new Error(reason==='CANCELLED'?'任务已取消':reason==='TIMEOUT'?'处理超时，未发布结果':`${path.basename(exe)} 执行失败：${error}`);
      e.code=reason||'ENGINE_FAILED';reject(e);
    }});
  });
}
async function inspect(file,signal,frames=false) {
  const output=await command(ffprobe,['-v','error','-show_streams','-show_format',...(frames?['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,pkt_duration_time:stream:format']:[]),'-of','json',file],signal,60_000);
  return JSON.parse(output);
}
function videoInfo(found) {
  const v=found.streams.find(s=>s.codec_type==='video');
  if(!v?.width||!v.height)fail('INVALID_MEDIA','没有可读取的画面');
  return {width:v.width,height:v.height,duration:Number(v.duration||found.format.duration),
    audio:found.streams.filter(s=>s.codec_type==='audio'),stream:v};
}
function acquireLock(file) {
  if(fs.existsSync(file)) {
    try {
      const owner=fs.readFileSync(file,'utf8'),saved=JSON.parse(owner);
      if(Number.isInteger(saved.pid)&&saved.pid>0) {
        let exited=false;try{process.kill(saved.pid,0);}catch(e){exited=e.code==='ESRCH';}
        if(exited&&fs.readFileSync(file,'utf8')===owner)fs.unlinkSync(file);
      }
    }catch{/* An unreadable or live lock remains protected. */}
  }
  try{const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));fs.closeSync(fd);}
  catch(e){if(e.code==='EEXIST')fail('BUSY',`任务锁已存在：${file}。如上次电脑强制关机，请确认无超分任务后删除该 .lock 文件再重试。`);throw e;}
  return ()=>fs.unlinkSync(file);
}
export async function run(request,emit=()=>{},signal) {
  if(request.protocolVersion!==1)fail('UNSUPPORTED_PROTOCOL','只支持 protocolVersion=1');
  if(request.scale!==2||request.preserveOriginalAudio!==true)fail('INVALID_REQUEST','需要 scale=2、preserveOriginalAudio=true');
  if(!['image','video'].includes(request.mediaType))fail('INVALID_REQUEST','mediaType 必须为 image 或 video');
  if(!path.isAbsolute(request.sourcePath||'')||!path.isAbsolute(request.outputPath||''))fail('INVALID_REQUEST','输入与输出需要绝对路径');
  const source=fs.realpathSync(request.sourcePath),output=path.resolve(request.outputPath),isVideo=request.mediaType==='video';
  if(!fs.statSync(source).isFile())fail('INVALID_MEDIA','输入不是文件');
  if(path.extname(output).toLowerCase()!==(isVideo?'.mp4':'.png'))fail('INVALID_REQUEST',isVideo?'视频输出必须为 .mp4':'图片输出必须为 .png');
  if(!isVideo&&!/\.(png|jpe?g)$/i.test(source))fail('INVALID_MEDIA','图片输入仅支持 PNG / JPEG');
  if(isVideo&&path.extname(source).toLowerCase()!=='.mp4')fail('INVALID_MEDIA','首版视频输入仅支持 MP4');
  if(fs.existsSync(output))fail('OUTPUT_EXISTS','输出已存在，请换一个文件名；原文件不会被覆盖');
  const available=doctor();if(!available.ready)fail('NOT_READY','运行环境未准备好，请先运行「准备运行环境.cmd」');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const outputRelease=acquireLock(output+'.lock');
  let work,engineRelease;
  const jobId=request.jobId||randomUUID();
  const event=(stage,progress,extra={})=>emit({type:'progress',protocolVersion:1,jobId,stage,progress,...extra});
  try {
    fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
    engineRelease=acquireLock(path.join(root,'runtime/engine.lock'));
    event('inspect',0);
    const before=videoInfo(await inspect(source,signal));
    let fps='1',count=1;
    if(isVideo){
      if(before.audio.length>8||!before.audio.every(a=>['aac','mp3','alac','ac3','eac3'].includes(a.codec_name)))fail('UNSUPPORTED_AUDIO','此音轨编码不能原样复制到 MP4；请先转为带 AAC 音轨的 MP4');
      const stream=before.stream;
      const rotation=Number(stream.tags?.rotate||stream.side_data_list?.find(s=>s.rotation!==undefined)?.rotation||0);
      if(rotation%360!==0)fail('UNSUPPORTED_TIMELINE','暂不支持旋转元数据，请先把旋转写入画面');
      if(stream.sample_aspect_ratio&&!['1:1','0:1','N/A'].includes(stream.sample_aspect_ratio))fail('UNSUPPORTED_TIMELINE','暂不支持非方形像素，请先规范画幅');
      if(['smpte2084','arib-std-b67'].includes(stream.color_transfer))fail('UNSUPPORTED_COLOUR','首版仅处理 SDR 视频，请先完成 HDR 到 SDR 的转换');
      if(Math.abs(Number(stream.start_time||0))>0.05)fail('UNSUPPORTED_TIMELINE','暂不支持非零起始时间，请先规范为从零开始的 MP4');
      fps=stream.avg_frame_rate;
      const [a,b]=String(fps).split('/').map(Number),rate=a/b;
      if(!Number.isFinite(rate)||rate<1||rate>120||!Number.isFinite(before.duration)||before.duration<=0)fail('INVALID_MEDIA','帧率或时长无效');
      const details=await inspect(source,signal,true),times=details.frames.map(f=>Number(f.best_effort_timestamp_time));
      count=times.length;
      if(count<1||count>18000)fail('TOO_MANY_FRAMES','首版单个视频支持 1–18000 帧，请将长视频分段处理');
      if(times.some((t,i)=>!Number.isFinite(t)||(i>0&&Math.abs(t-times[i-1]-1/rate)>Math.max(.002,.02/rate))))fail('UNSUPPORTED_TIMELINE','暂不支持变帧率视频，请先转为恒定帧率，避免改变动作节奏和音画同步');
      if(Math.abs(count/rate-before.duration)>Math.max(.12,2/rate))fail('UNSUPPORTED_TIMELINE','视频帧数与时长不一致，请先修复时间轴');
    }
    const space=fs.statfsSync(path.dirname(output));
    const estimated=before.width*before.height*count*16+100_000_000;
    if(space.bavail*space.bsize<estimated)fail('DISK_SPACE','输出磁盘可用空间不足，抽帧与超分临时文件需要较多空间');
    work=fs.mkdtempSync(path.join(path.dirname(output),'.upscale-work-'));
    const inputDir=path.join(work,'input'),outputDir=path.join(work,'output');fs.mkdirSync(inputDir);fs.mkdirSync(outputDir);
    event('extract',5,{frames:count});
    await command(ffmpeg,['-v','error','-nostdin','-noautorotate','-i',source,'-map','0:v:0','-fps_mode','passthrough',...(isVideo?[]:['-frames:v','1']),path.join(inputDir,'%08d.png')],signal);
    if(fs.readdirSync(inputDir).length!==count)fail('FRAME_COUNT','抽帧数量与原视频不符');
    event('upscale',20,{completedFrames:0,frames:count});
    let last=0;
    const progress=setInterval(()=>{const n=fs.readdirSync(outputDir).length;if(n>last){last=n;event('upscale',20+Math.floor(65*n/count),{completedFrames:n,frames:count});}},750);
    try{await command(engine,['-i',inputDir,'-o',outputDir,'-m',models,'-n','realesr-animevideov3','-s','2','-t','128','-j','1:1:1','-f','png'],signal);}
    finally{clearInterval(progress);}
    const frames=fs.readdirSync(inputDir).sort();
    if(!frames.every(f=>fs.existsSync(path.join(outputDir,f)))||fs.readdirSync(outputDir).length!==count)fail('FRAME_COUNT','超分结果缺帧');
    const pending=path.join(work,isVideo?'result.mp4':'result.png');
    event('encode',86);
    if(isVideo)await command(ffmpeg,['-v','error','-nostdin','-framerate',fps,'-i',path.join(outputDir,'%08d.png'),'-i',source,
      '-map','0:v:0','-map','1:a?','-map_metadata','1','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-c:a','copy','-t',String(before.duration),'-movflags','+faststart',pending],signal);
    else fs.copyFileSync(path.join(outputDir,frames[0]),pending);
    event('validate',95);
    const after=videoInfo(await inspect(pending,signal));
    const rate=Number(fps.split('/')[0])/Number(fps.split('/')[1]||1);
    if(after.width!==before.width*2||after.height!==before.height*2||isVideo&&
       (Math.abs(after.duration-before.duration)>Math.max(.12,2/rate)||after.audio.length!==before.audio.length||after.audio.some((a,i)=>a.codec_name!==before.audio[i].codec_name)))fail('INVALID_RESULT','结果未保持 2 倍尺寸、时长或原音轨');
    if(signal?.aborted)fail('CANCELLED','任务已取消');
    // Exclusive hard link publishes the validated file without overwriting a competing output.
    try{fs.linkSync(pending,output);}catch(e){if(e.code==='EEXIST')fail('OUTPUT_EXISTS','输出已存在，未覆盖');fail('PUBLISH_FAILED','无法发布结果，请选择有写入权限的本机 NTFS 磁盘目录');}
    const result={type:'result',protocolVersion:1,jobId,version:manifest.version,outputPath:output,mediaType:request.mediaType,
      width:after.width,height:after.height,...(isVideo?{duration:after.duration,fps,audioTracks:after.audio.length}:{}),frames:count,bytes:fs.statSync(output).size};
    event('complete',100);emit(result);return result;
  } finally {
    if(work&&path.dirname(work)===path.dirname(output)&&path.basename(work).startsWith('.upscale-work-'))fs.rmSync(work,{recursive:true,force:true});
    engineRelease?.();outputRelease();
  }
}
