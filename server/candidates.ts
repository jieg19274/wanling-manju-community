import {db,getProject,insertJobs,jobById,updateProject,type Job} from './store.js';
import {enqueue,wake,cancelQueued,validateGeneration} from './jobs.js';
import {assetInputHash,generationSignature} from '../shared/generation.js';
import {digest,id,now,approvalHash,selectedArtifact,selectedPromptContractIssues,knownVideoCapabilities} from '../shared/model.js';
import {referenceHashes} from './reference-provenance.js';
import {applyAction} from './actions.js';
import {approvedUnknownRetry} from './unknown-retry.js';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {mediaPath} from './media.js';
import {localImageSubmissionProof,localVideoSubmissionProof,remainingProfile,remainingRows} from './local-submission.js';
import {assetImageReferences} from './asset-image-references.js';
import {preparedVideoPrompt} from './video-prompt.js';

type Input={kind:'image'|'video';assetId?:string;stateId?:string;role?:string;sourceImageId?:string;episodeId?:string;segmentId?:string;count:number;feedback:string;unknownRetryApproval?:string};
type Item={id:string;status:'queued'|'running'|'completed'|'failed'|'cancelled';error?:string};
type Batch={id:string;projectId:string;input:Input;hash:string;preview:ReturnType<typeof candidatePreview>;items:Item[];createdAt:string;cancelled?:boolean;paused?:boolean;acknowledgedFailures?:string[]};
function inputOf(value:Record<string,unknown>):Input {
  const count=Number(value.count),kind=String(value.kind);
  if(!['image','video'].includes(kind)||!Number.isInteger(count)||count<1||count>4)throw new Error('每次可预约1–4个图片或视频候选');
  const feedback=String(value.feedback||'').trim();if(feedback.length>500)throw new Error('候选视觉偏好最多500字');
  if(value.unknownRetryApproval && (kind!=='image'||count!==1))throw new Error('Unknown retry approval permits exactly one image');
  return {kind:kind as Input['kind'],count,feedback,...(value.sourceImageId?{sourceImageId:String(value.sourceImageId)}:{}),...(value.unknownRetryApproval?{unknownRetryApproval:String(value.unknownRetryApproval)}:{}),...Object.fromEntries(['assetId','stateId','role','episodeId','segmentId'].map(key=>[key,String(value[key]||'')]))};
}
export function candidatePreview(projectId:string,value:Record<string,unknown>) {
  const input=inputOf(value),project=getProject(projectId);
  let signature='',summary:object={},model=project.imageModel;
  if(input.kind==='image') {
    const asset=project.assets?.find(a=>a.id===input.assetId),state=asset?.states.find(s=>s.id===input.stateId);
    if(!asset||(input.stateId&&!state))throw new Error('请选择有效资产和状态');
    if(!model?.adapterPath)throw new Error('尚未配置图片模型');
    const references=assetImageReferences(project,asset.id,input.stateId||'',input.role||'main',input.sourceImageId);
    signature=digest({asset:assetInputHash(project,asset.id,input.stateId),model,...(references.length?{references}:{})});
    summary={asset:asset.name,identity:asset.identity,state:state?.label||'基础状态',appearance:state?.appearance||'',role:input.role||'main',...(input.role==='turnaround'?{layout:'正面全身、90°侧面全身、背面全身、正面大头照（横向四等分）'}:{}),references,repairSourceImageId:input.sourceImageId||'',style:project.visualStyle,aspect:project.aspectRatio};
  } else {
    model=project.videoModel;
    const episode=project.episodes.find(e=>e.id===input.episodeId),segment=episode?.segments.find(s=>s.id===input.segmentId);
    if(!episode||!segment||segment.durationSec!==30||episode.auditApprovedHash!==approvalHash(episode))throw new Error('请先完成本集五层放行；每段固定30秒');
    const contractIssues=selectedPromptContractIssues(episode,segment,project);if(contractIssues.length)throw new Error(contractIssues.join('；'));
    const prompt=selectedArtifact(segment,'prompt');if(!prompt)throw new Error('请先选择最终提示词');
    validateGeneration(projectId,episode.id,[segment.id],['video'],{regenerate:true,
      candidate:{batchId:String(value.requestId||''),candidateId:'preview',keepSelection:true,feedback:input.feedback}});
    const prepared=preparedVideoPrompt(project,episode,segment,input.feedback);
    signature=digest({generation:generationSignature(project,episode,segment),references:referenceHashes(project,episode,segment),modelPromptHash:prepared.hash});
    summary={episode:episode.number,segment:segment.number,durationSec:30,aspect:project.aspectRatio,promptId:prompt.id,
      prompt:prepared.content,promptHash:prepared.hash,promptCharacters:prepared.characters,
      promptLimit:{...knownVideoCapabilities(project.videoModel?.modelId||''),...project.videoModel?.capabilities}.maxPromptChars,references:referenceHashes(project,episode,segment)};
  }
  return {input,hash:digest({input,signature}),model:{name:model?.name||'本地适配器',id:model?.modelId||''},summary:{...summary,visualPreference:input.feedback||'无，按当前输入再试'},
    cost:{known:false,maximumSubmissions:input.count,totalVideoSeconds:input.kind==='video'?input.count*30:0,message:'服务商单价/计费方式未知，无法可靠估价或承诺金额上限；不是免费。本次最多提交'+input.count+'次，不自动补跑失败候选。'},selection:'保留当前选用；新结果仅作为候选'};
}
export function candidateBatches(projectId:string):Batch[] {return db.prepare('SELECT payload FROM candidate_batches WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId).map(row=>JSON.parse(String(row.payload)));}
function save(batch:Batch){db.prepare('UPDATE candidate_batches SET payload=? WHERE id=?').run(JSON.stringify(batch),batch.id);}
function saveChanged(batch:Batch,previous:string){if(JSON.stringify(batch)!==previous)save(batch);}
function sqliteBusy(error:unknown):boolean {
  const value=error as {code?:string;errcode?:number};
  return ['SQLITE_BUSY','SQLITE_LOCKED'].includes(value?.code||'') ||
    (Number.isInteger(value?.errcode)&&[5,6].includes(Number(value.errcode)&255));
}
function backgroundTick(){void tickCandidates().catch(error=>{
  console.error('候选队列本轮未完成，将在下一轮继续；错误类型：'+String((error as {code?:string;name?:string})?.code||(error as Error)?.name||'unknown'));
});}
export function createCandidates(projectId:string,value:Record<string,unknown>) {
  const requestId=String(value.requestId||'');if(!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)||value.confirmed!==true)throw new Error('请明确确认模型、数量、输入与未知费用');
  const existing=db.prepare('SELECT payload FROM candidate_batches WHERE id=? AND project_id=?').get(requestId,projectId);
  if(existing){const batch:Batch=JSON.parse(String(existing.payload));if(batch.hash!==value.hash||JSON.stringify(batch.input)!==JSON.stringify(inputOf(value)))throw new Error('同一确认号不能更改请求');return batch;}
  const preview=candidatePreview(projectId,value);if(preview.hash!==value.hash)throw new Error('生成输入已变化，请重新预览确认');
  const batch:Batch={id:requestId,projectId,input:preview.input,hash:preview.hash,preview,items:Array.from({length:preview.input.count},()=>({id:id(),status:'queued'})),createdAt:now()};
  db.prepare('INSERT INTO candidate_batches VALUES(?,?,?,?)').run(batch.id,projectId,JSON.stringify(batch),batch.createdAt);backgroundTick();return batch;
}
export function controlCandidates(projectId:string,batchId:string,operation:string,confirmed=false) {
  const row=db.prepare('SELECT payload FROM candidate_batches WHERE id=? AND project_id=?').get(batchId,projectId);if(!row)throw new Error('候选批次不存在');
  const batch:Batch=JSON.parse(String(row.payload));
  if(operation==='cancel'){batch.cancelled=true;for(const item of batch.items){const job=jobById(item.id);if(job&&['queued','paused'].includes(job.status))cancelQueued(projectId,job.id);if(!job||['queued','paused'].includes(job.status))item.status='cancelled';}}
  else if(operation==='pause'){batch.paused=true;for(const item of batch.items)db.prepare("UPDATE jobs SET status='paused' WHERE id=? AND status='queued'").run(item.id);}
  else if(operation==='resume'&&!batch.cancelled){batch.paused=false;batch.acknowledgedFailures=batch.items.filter(i=>i.status==='failed').map(i=>i.id);for(const item of batch.items)db.prepare("UPDATE jobs SET status='queued' WHERE id=? AND status='paused'").run(item.id);wake();}
  else if(operation==='retry-unsubmitted'&&confirmed&&!batch.cancelled&&batch.input.kind==='image'&&batch.items.length===1){
    const item=batch.items[0],job=jobById(item.id),profile=remainingProfile();
    if(!profile||profile.projectId!==projectId||!job||job.status!=='failed'||item.status!=='failed')throw new Error('Original failed image job required');
    if(candidatePreview(projectId,{...batch.input,requestId:batch.id}).hash!==batch.hash)throw new Error('Original frozen input changed; cannot resume');
    const adapters=db.prepare("SELECT * FROM adapter_tasks WHERE project_id=? AND task='asset-image' AND status!='not_submitted' AND json_extract(snapshot,'$.request.candidateId')=?").all(projectId,item.id) as unknown as (Parameters<typeof localImageSubmissionProof>[2]&{id:string})[];
    if(!adapters.length)throw new Error('Missing original submission history');
    for(const adapter of adapters){const proof=localImageSubmissionProof(profile,remainingRows(profile),adapter,item.id,batch.id,batch.input.assetId!);writeFileSync(adapter.output_path+'.local-submission-evidence.json',JSON.stringify({...proof,at:now(),adapterId:adapter.id},null,2));}
    db.exec('BEGIN IMMEDIATE');try{
      const changed=db.prepare("UPDATE jobs SET status='queued',error=NULL,updated_at=? WHERE id=? AND status='failed'").run(now(),job.id);
      if(changed.changes!==1)throw new Error('Original job already resumed');
      for(const adapter of adapters)db.prepare("UPDATE adapter_tasks SET status='not_submitted' WHERE id=? AND status='remote_unknown'").run(adapter.id);
      item.status='queued';item.error=undefined;batch.paused=false;save(batch);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}wake();
  }
  else if(operation==='retry-unsubmitted'&&confirmed&&!batch.cancelled&&batch.input.kind==='video'&&batch.items.length===1){
    const item=batch.items[0],job=jobById(item.id),profile=remainingProfile();
    if(!profile||!job||item.status!=='failed'||candidatePreview(projectId,{...batch.input,requestId:batch.id}).hash!==batch.hash)throw new Error('Original failed frozen video required');
    const folder=mediaPath(path.join('generated',job.episode_id,job.segment_id)),output=path.join(folder,job.id+'.mp4'),original=path.join(folder,job.id+'.json'),remoteFile=output+'.remote.json';
    if(!existsSync(original)||!existsSync(remoteFile))throw new Error('Missing original video submission evidence');
    const request=JSON.parse(readFileSync(original,'utf8')),remote=JSON.parse(readFileSync(remoteFile,'utf8')),project=getProject(projectId),episode=project.episodes.find(e=>e.id===job.episode_id),segment=episode?.segments.find(s=>s.id===job.segment_id);
    if(!episode||!segment||request.generationHash!==generationSignature(project,episode,segment))throw new Error('Original frozen video generation input changed');
    const proof=localVideoSubmissionProof(profile,remainingRows(profile),job,request,remote,batch.id,output);
    writeFileSync(output+'.local-submission-evidence.json',JSON.stringify({...proof,at:now()},null,2));
    db.exec('BEGIN IMMEDIATE');try{const changed=db.prepare("UPDATE jobs SET status='queued',error=NULL,updated_at=? WHERE id=? AND status='failed'").run(now(),job.id);if(changed.changes!==1)throw new Error('Original video already resumed');item.status='queued';item.error=undefined;batch.paused=false;save(batch);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}wake();
  }
  else throw new Error('候选操作无效');save(batch);backgroundTick();return batch;
}
let busy=false;
export async function tickCandidates(){
  if(busy)return;busy=true;
  try {
    for(const row of db.prepare('SELECT payload FROM candidate_batches ORDER BY created_at').all()){
      const batch:Batch=JSON.parse(String(row.payload));
      for(const item of batch.items){const job=jobById(item.id);if(job){item.status=(job.status==='paused'?'running':job.status) as Item['status'];item.error=job.error||undefined;}else if(item.status==='running'){item.status='failed';item.error='实例中断，未找到已入队任务；未自动补跑';}}
      if(batch.cancelled||batch.paused||batch.items.some(i=>i.status==='running')){saveChanged(batch,String(row.payload));continue;}
      const item=batch.items.find(i=>i.status==='queued');if(!item){saveChanged(batch,String(row.payload));continue;}
      // A failed/unknown submission pauses the remainder until the user decides.
      if(batch.items.some(i=>i.status==='failed'&&!batch.acknowledgedFailures?.includes(i.id))){batch.paused=true;save(batch);continue;}
      try{
        if(candidatePreview(batch.projectId,{...batch.input,requestId:batch.id}).hash!==batch.hash)throw new Error('确认后输入已变化；未提交候选');
        const active=db.prepare("SELECT id FROM jobs WHERE project_id=? AND segment_id=? AND kind=? AND status IN ('queued','running','paused')").get(batch.projectId,(batch.input.kind==='image'?batch.input.assetId:batch.input.segmentId)||'',batch.input.kind==='image'?'image':'video');
        if(active){saveChanged(batch,String(row.payload));continue;}
        item.status='running';save(batch);
        const candidate={batchId:batch.id,candidateId:item.id,keepSelection:true as const,feedback:batch.input.feedback};
        if(batch.input.kind==='video'){
          const jobs=enqueue(batch.projectId,batch.input.episodeId!,[batch.input.segmentId!],['video'],{regenerate:true,candidate});if(!jobs.length)throw new Error('已有活动任务，未提交候选');
        }else{
          const project=getProject(batch.projectId),asset=project.assets?.find(a=>a.id===batch.input.assetId);
          const unknowns=db.prepare("SELECT a.id FROM adapter_tasks a WHERE a.project_id=? AND a.task='asset-image' AND a.status='remote_unknown' AND (json_extract(a.snapshot,'$.request.asset.id')=? OR (json_extract(a.snapshot,'$.request.asset.id') IS NULL AND (json_extract(a.snapshot,'$.request.candidateId') IS NULL OR EXISTS(SELECT 1 FROM jobs j WHERE j.id=json_extract(a.snapshot,'$.request.candidateId') AND j.segment_id=?))))").all(batch.projectId,asset!.id,asset!.id) as {id:string}[];
          if(unknowns.length && !approvedUnknownRetry(batch.projectId,asset!.id,batch.id,batch.input.unknownRetryApproval,unknowns.map(a=>a.id)))throw new Error('该资产计费状态未知；须另行明确批准一次新尝试并接受重复计费风险');
          const references=assetImageReferences(project,asset!.id,batch.input.stateId||'',batch.input.role||'main',batch.input.sourceImageId);
          const job={id:item.id,project_id:batch.projectId,episode_id:'',segment_id:batch.input.assetId!,kind:'image',status:'queued',error:null,created_at:now(),updated_at:now(),snapshot:JSON.stringify({version:1,project:{...project,sourceCorpus:undefined,episodes:[],archivedEpisodes:undefined,assets:[asset]},candidate,image:{assetId:batch.input.assetId,stateId:batch.input.stateId||'',role:batch.input.role||'main',sourceImageId:batch.input.sourceImageId,references}})} as Job;
          insertJobs([job]);if(!jobById(item.id))throw new Error('已有活动任务，未提交候选');wake();
        }
      }catch(error){if(sqliteBusy(error))throw error;item.status='failed';item.error=(error as Error).message;batch.paused=true;}
      saveChanged(batch,String(row.payload));
    }
  }catch(error){if(!sqliteBusy(error))throw error;}finally{busy=false;}
}
export function startCandidates(){backgroundTick();setInterval(backgroundTick,500).unref();}
export function candidateChangeImpact(projectId:string,value:Record<string,unknown>){
  if(!['segment.assets','asset.update','asset.state'].includes(String(value.type)))throw new Error('不支持的资产变更');
  const project=getProject(projectId);
  const signatures=()=>new Map(project.episodes.flatMap(e=>e.segments.map(s=>{let hash='';try{hash=generationSignature(project,e,s);}catch{hash=digest({revision:s.assetRevision,bindings:s.assetBindings});}return [s.id,hash] as const;})));
  const before=signatures();applyAction(project,{...value,type:String(value.type)});const after=signatures();
  return {hash:digest({action:value,before:[...before]}),affected:project.episodes.flatMap(e=>e.segments.filter(s=>before.get(s.id)!==after.get(s.id)).map(s=>({episodeId:e.id,episode:e.number,segmentId:s.id,segment:s.number}))),message:'只更新输入和撤销相关放行；保留旧图/旧视频，不自动生成或收费。'};
}
export function applyCandidateChange(projectId:string,value:Record<string,unknown>){const action=value.action as Record<string,unknown>;if(!action||candidateChangeImpact(projectId,action).hash!==value.hash)throw new Error('资产或片段已变化，请重新预览影响');return updateProject(projectId,p=>applyAction(p,{...action,type:String(action.type)}));}
