import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';

type Row={kind:string;state:string;approval?:string;subject?:string};
type Grant={id:string;kind:string;assetId?:string;episodeId?:string;segmentId?:string;requestId?:string;confirmed?:boolean;sourceMessageId?:string};
type Profile={scope:string;state:string;paused?:boolean;projectId:string;batchId:string;ledgerPath:string;overallApproval?:{confirmed?:boolean;sourceMessageId?:string};requests:Grant[]};
export function localImageSubmissionProof(profile:Profile,rows:Row[],adapter:{project_id:string;task:string;status:string;error:string;output_path:string;snapshot:string},candidateId:string,batchId:string,assetId:string){
  const request=JSON.parse(adapter.snapshot).request;
  const grants=profile.requests.filter(g=>g.kind==='image'&&g.assetId===assetId&&g.requestId===batchId);
  const grant=grants[0];
  if(profile.scope!=='episodes3-8'||profile.state!=='active'||profile.paused||!profile.overallApproval?.confirmed||grants.length!==1||!grant?.confirmed||grant.sourceMessageId!==profile.overallApproval.sourceMessageId)throw new Error('No active scoped approval for original image');
  const localBudget=adapter.error.trim()==='模型适配器失败：Unsettled text or overrun blocks further spending';
  const localKey=adapter.error.includes('Error: 新软件 API Key 解密失败')&&/direct-common\.mjs:11:50/.test(adapter.error)&&!adapter.error.includes('HTTP');
  if(adapter.project_id!==profile.projectId||adapter.task!=='asset-image'||adapter.status!=='remote_unknown'||(!localBudget&&!localKey)||request.projectId!==profile.projectId||request.candidateId!==candidateId||request.batchId!==batchId||request.asset?.id!==assetId||request.model!=='gpt-image-2.5-sunburst')throw new Error('Not a proven local pre-submission budget rejection');
  if(rows.some(r=>r.approval===grant.id||r.kind==='image'&&r.subject?.endsWith(':'+assetId)))throw new Error('Existing fee reservation: reconcile original request, never resubmit');
  if(rows.some(r=>r.state==='overrun'||r.kind==='text'&&r.state!=='completed'))throw new Error('Text budget still unsettled');
  if(existsSync(adapter.output_path))throw new Error('Existing output must be reconciled');
  return {reason:localBudget?'local_budget_guard_before_reservation_and_network':'local_key_initialization_before_reservation_and_network',grantId:grant.id,candidateId,batchId,assetId,originalError:adapter.error,providerSubmission:false};
}
export function remainingProfile(){const file=process.env.MANJU_BATCH_BUDGET_PROFILE;return file?JSON.parse(readFileSync(file,'utf8')) as Profile:undefined;}
export function localVideoSubmissionProof(profile:Profile,rows:Row[],job:{id:string;project_id:string;episode_id:string;segment_id:string;kind:string;status:string;error:string|null},request:{projectId?:string;batchId?:string;segmentId?:string;episodeId?:string;durationSec?:number;model?:{id?:string}},remote:{id?:string;status?:string},batchId:string,outputPath:string){
 const grants=profile.requests.filter(g=>g.kind==='video'&&g.episodeId===job.episode_id&&g.segmentId===job.segment_id&&g.requestId===batchId),grant=grants[0],error=job.error||'';
 if(profile.scope!=='episodes3-8'||profile.state!=='active'||profile.paused||!profile.overallApproval?.confirmed||grants.length!==1||!grant?.confirmed||grant.sourceMessageId!==profile.overallApproval.sourceMessageId)throw new Error('No active original video approval');
 if(job.project_id!==profile.projectId||job.kind!=='video'||job.status!=='failed'||!error.includes('Error: 新软件 API Key 解密失败')||!/direct-common\.mjs:11:50/.test(error)||error.includes('HTTP')||remote.id||!['submitting','not_submitted'].includes(remote.status||'')||request.projectId!==profile.projectId||request.batchId!==batchId||request.segmentId!==job.segment_id||request.episodeId!==job.episode_id||request.durationSec!==30||request.model?.id!=='专享sd2.5(30图10音/4-30秒/720p)'||existsSync(outputPath))throw new Error('Not a proven local video initialization failure');
 if(rows.some(r=>r.approval===grant.id||r.kind==='video'&&r.subject==='video:'+job.episode_id+':'+job.segment_id))throw new Error('Original fee reservation exists; query instead of resubmit');
 if(rows.some(r=>r.state==='overrun'||r.kind==='text'&&r.state!=='completed'))throw new Error('Text budget still unsettled');
 return {reason:'local_key_initialization_before_reservation_and_network',providerSubmission:false,grantId:grant.id,candidateId:job.id,batchId,originalError:error,priorRemote:remote};
}
export function remainingRows(profile:Profile):Row[]{const ledger=new DatabaseSync(profile.ledgerPath,{readOnly:true});try{return ledger.prepare('SELECT * FROM calls WHERE batch=?').all(profile.batchId) as Row[];}finally{ledger.close();}}
export function waitingForTextBudget(projectId:string){const profile=remainingProfile();if(!profile||profile.scope!=='episodes3-8'||profile.projectId!==projectId)return false;return remainingRows(profile).some(r=>r.state==='overrun'||r.kind==='text'&&r.state!=='completed');}
