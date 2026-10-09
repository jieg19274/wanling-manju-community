import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { beatFor, contentHash, digest, id, now, subshotsFor, type Artifact } from '../shared/model.js';
import { usableVideo } from '../shared/generation.js';
import { executionPlanIssues, labelAppearance, validateLabelStyle, visibleText, type LabelStyle, type VisibleCue } from '../shared/execution-plan.js';
import { getProject, generationSpec, registerGenerationSpec, updateProject } from './store.js';
import { inspectVideo, mediaPath, probe, relativeMedia } from './media.js';
import { verifyReferenceProvenance } from './reference-provenance.js';
import { resolvedLabelFonts } from './label-fonts.js';
import { terminateChild } from './process-contract.js';
import { expectedResolution, validateGeneratedMedia } from '../shared/media-contract.js';

const running = new Map<string,{ hash:string; promise:Promise<{artifactId:string;mediaPath:string}> }>();
async function fileHash(file:string) {
  const hash=createHash('sha256'); for await(const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function run(command:string,args:string[],cwd?:string) {
  return new Promise<string>((resolve,reject)=>{
    const child=spawn(command,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',errors='';const timer=setTimeout(()=>{terminateChild(child);reject(Error('本地浮签修正超时；原片保留，请检查结果后重试'));},10*60_000);
    child.stdout.on('data',c=>{output=(output+c.toString()).slice(-12000);});child.stderr.on('data',c=>{errors=(errors+c.toString()).slice(-5000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(`本地浮签修正失败：${errors.slice(-1000)}`));});
  });
}
async function audioHash(file:string) { return (await run('ffmpeg',['-hide_banner','-loglevel','error','-i',file,'-map','0:a','-c:a','copy','-f','hash','-hash','sha256','-'])).trim(); }
// Reject ASS controls rather than silently rewriting protected formal text.
export function escapeAss(text:string) {
  if (/[{}\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw Error('正式文字含当前渲染器不支持的控制/排版符号；未改写全文或生成修正版');
  return text.replaceAll('\r','').replaceAll('\n','\\N');
}
const time=(seconds:number)=>{const ticks=Math.round(seconds*100);return `${Math.floor(ticks/360000)}:${String(Math.floor(ticks/6000)%60).padStart(2,'0')}:${String(Math.floor(ticks/100)%60).padStart(2,'0')}.${String(ticks%100).padStart(2,'0')}`;};
const color=(hex:string)=>`&H00${hex.slice(5,7)}${hex.slice(3,5)}${hex.slice(1,3)}`;
function wrapText(text:string,width:number,fontSize:number) {
  const rows:string[]=[];let row='',used=0;
  for(const char of text.replaceAll('\r','')) {
    if(char==='\n'){rows.push(row);row='';used=0;continue;}
    const measure=fontSize*(/[\u0000-\u007f]/u.test(char)?.65:1.08);
    if(used+measure>width && row){rows.push(row);row='';used=0;}
    row+=char;used+=measure;
  }
  rows.push(row);return rows;
}
export function buildLabelAss(width:number,height:number,cues:VisibleCue[],texts:string[],style:LabelStyle,fonts:{label:string;system:string}) {
  const events:string[]=[];
  for(const [index,cue] of cues.entries()) {
    const a=labelAppearance(style,cue.kind==='systemPanels'),font=cue.kind==='systemPanels'?fonts.system:fonts.label;
    const x=Math.round(cue.x*width),y=Math.round(cue.y*height),w=Math.round(cue.width*width),h=Math.round(cue.height*height),padding=Math.max(3,Math.round(height*.009));
    const size=Math.max(16,Math.round(height*a.size)),rows=wrapText(texts[index],w-padding*2,size);
    if(rows.length*size*1.3>h-padding*2 || size*1.08>w-padding*2) throw Error(`“${texts[index]}”在当前区域放不下，请扩大文字区域或选用正常字号；不能裁掉正文`);
    const start=time(cue.startSec),end=time(cue.endSec);
    events.push(`Dialogue: 0,${start},${end},Label,,0,0,0,,{\\an7\\pos(${x},${y})\\bord0\\shad0\\1c&H001A1714\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`);
    const text=rows.map(escapeAss).join('\\N');
    events.push(`Dialogue: 1,${start},${end},Label,,0,0,0,,{\\an7\\pos(${x+padding},${y+padding})\\fn${font}\\fs${size}\\1c${color(a.color)}\\3c${color(a.outline)}\\bord1.2\\shad0\\q2}${text}`);
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Label,${fonts.label},32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1.2,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}
export async function repairLabels(projectId:string,episodeId:string,segmentId:string,artifactId:string,raw:Record<string,unknown>) {
  const requestId=String(raw.requestId||'');if(!/^[\w-]{8,80}$/u.test(requestId))throw Error('纠字请求缺少有效编号');
  if(raw.confirmed!==true)throw Error('请先核对正式全文、时窗和覆盖区域，再生成修正版');
  const style=validateLabelStyle(raw.style),cues=structuredClone(raw.cues) as VisibleCue[];
  if(!Array.isArray(cues)||!cues.length||cues.length>40)throw Error('请选择需要修正的正式浮签或系统文字');
  const hash=digest({episodeId,segmentId,artifactId,style,cues}),key=`${projectId}:${requestId}`,active=running.get(key);
  if(active){if(active.hash!==hash)throw Error('同一纠字请求的内容已变化，请检查已生成结果');return active.promise;}
  const project=getProject(projectId),episode=project.episodes.find(e=>e.id===episodeId),segment=episode?.segments.find(s=>s.id===segmentId);
  const source=segment?.artifacts.find(a=>a.id===artifactId&&a.kind==='video');
  if(!episode||!segment||!source?.mediaPath||!source.generationHash)throw Error('原视频不存在或缺少生成来源');
  if(source.demo)throw Error('技术演示视频不能通过纠字转成正式生产版本');
  const completed=segment.artifacts.find(a=>a.labelRepair?.requestId===requestId);
  if(completed){if(completed.labelRepair!.payloadHash!==hash)throw Error('同一纠字请求的内容已变化，请使用已生成版本');await verifyLabelRepair(segment.artifacts,completed);return{artifactId:completed.id,mediaPath:completed.mediaPath!};}
  if(project.archivedAt)throw Error('归档项目不能修正视频');
  if(!usableVideo(project,episode,segment,source))throw Error('原视频与当前正式输入不一致，请先核对来源');
  verifyReferenceProvenance(project,episode,segment,source);
  const beat=beatFor(episode,segment),plan={effects:[],combat:[],visible:cues,labelStyle:style};
  const issues=executionPlanIssues(beat,{...segment,effectIds:[],executionPlan:plan},subshotsFor(beat,segment),project,true);
  if(issues.length)throw Error(issues.join('；'));
  const sourceHash=contentHash(episode,segment),input=mediaPath(source.mediaPath),texts=cues.map(c=>visibleText(beat,c));
  const promise=(async()=>{
    const inputHash=await fileHash(input),sourceStat=statSync(input),media=await probe(input),fonts=await resolvedLabelFonts(style);
    validateGeneratedMedia(media,segment.durationSec,project.aspectRatio||'16:9',Boolean(beat.dialogue.length||beat.os.length),expectedResolution(project));
    const spec=generationSpec(projectId,source.specId||source.jobId||source.id);
    const folder=mediaPath(`label-repairs/${projectId}/${requestId}`);mkdirSync(folder,{recursive:true});
    const ass=buildLabelAss(media.width,media.height,cues,texts,style,fonts);writeFileSync(path.join(folder,'labels.ass'),ass,'utf8');
    const temp=path.join(folder,`${id()}.tmp.mp4`),output=path.join(folder,`${id()}.mp4`);
    const before=media.hasAudio?await audioHash(input):undefined;
    await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-i',input,'-vf','ass=labels.ass','-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',temp],folder);
    const after=media.hasAudio?await audioHash(temp):undefined,result=await probe(temp);
    if(before!==after||media.hasAudio!==result.hasAudio||Math.abs(media.duration-result.duration)>.15||media.width!==result.width||media.height!==result.height)throw Error('修正版未保持原声音、时长或画幅；结果未放行');
    if(statSync(input).size!==sourceStat.size||statSync(input).mtimeMs!==sourceStat.mtimeMs||await fileHash(input)!==inputHash)throw Error('纠字期间原视频文件发生变化，结果未写入');
    renameSync(temp,output);const outputHash=await fileHash(output),technical=await inspectVideo(output),artifactId=id(),stamp=now();
    const artifact:Artifact={id:artifactId,specId:artifactId,kind:'video',createdAt:stamp,sourceHash:source.sourceHash,generationHash:source.generationHash,modelPromptHash:source.modelPromptHash,referenceHashes:structuredClone(source.referenceHashes),modelName:source.modelName,modelId:source.modelId,mediaPath:relativeMedia(output),technical,
      labelRepair:{requestId,payloadHash:hash,sourceArtifactId:source.id,sourceFileHash:inputHash,outputFileHash:outputHash,audioHash:after,cues,style,resolvedFonts:fonts,createdAt:stamp}};
    updateProject(projectId,current=>{
      const ep=current.episodes.find(e=>e.id===episodeId),row=ep?.segments.find(s=>s.id===segmentId),original=row?.artifacts.find(a=>a.id===source.id);
      if(!ep||!row||!original||contentHash(ep,row)!==sourceHash||original.mediaPath!==source.mediaPath||!usableVideo(current,ep,row,original)||current.archivedAt)throw Error('纠字期间正式输入发生变化，请核对保留的修正文件');
      verifyReferenceProvenance(current,ep,row,original);
      registerGenerationSpec(artifactId,projectId,{...spec,id:undefined,origin:'label-correction',labelRepair:artifact.labelRepair});
      row.artifacts.push(artifact);
    });
    writeFileSync(path.join(folder,'修正记录.json'),JSON.stringify({artifactId,sourceArtifactId:source.id,formalTexts:texts,...artifact.labelRepair,mediaPath:artifact.mediaPath,review:'pending'},null,2),'utf8');
    return {artifactId,mediaPath:artifact.mediaPath!};
  })();
  running.set(key,{hash,promise});try{return await promise;}finally{running.delete(key);}
}
export async function verifyLabelRepair(artifacts:Artifact[],artifact:Artifact) {
  const repair=artifact.labelRepair;if(!repair)return;
  const source=artifacts.find(a=>a.id===repair.sourceArtifactId);
  if(!source?.mediaPath||!artifact.mediaPath||!existsSync(mediaPath(source.mediaPath))||await fileHash(mediaPath(source.mediaPath))!==repair.sourceFileHash||await fileHash(mediaPath(artifact.mediaPath))!==repair.outputFileHash)throw Error('文字修正版或原片文件哈希已变化，请重新核对');
}
