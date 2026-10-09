import { db,getProject,jobsFor } from './store.js';
import { approvalHash,auditEpisode,contentHash,digest,highlightHash,id,now,sampleGateHash,scriptHash,selectedArtifact,sourceHash,storyboardSourceHash,promptReadiness } from '../shared/model.js';
import type { Project,Episode } from '../shared/model.js';
import {storyReviewHash} from '../shared/story-review.js';
import {candidatePreview,createCandidates,candidateBatches,controlCandidates} from './candidates.js';
import {enqueue} from './jobs.js';
import {suggestHighlight,suggestScript,suggestAssets,suggestSemanticReview,suggestSubshots} from './assist.js';
import {exportEpisode,exportEpisodeMp4,preflightEpisode} from './export.js';
import {fetchProviderBilling} from './provider-billing.js';
import {billingQuote} from '../shared/provider-billing.js';
import {usableVideo} from '../shared/generation.js';
import {assetInputHash} from '../shared/generation.js';
import {effectiveState} from '../shared/asset-state.js';
import {requiresPortraitReference,isCharacterSheet} from '../shared/asset-references.js';
import type {AgentWorkflow,WorkflowStep} from '../shared/agent-workflow.js';
import { agentTask, findAgentTask, pauseAgentTask, reserveAgentSubmission } from './agent-tasks.js';
import { exportProductionPackage } from './production-package.js';
import { productionRules } from '../shared/production-rules.js';

db.exec('CREATE TABLE IF NOT EXISTS agent_workflows(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,episode_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL)');
const busy=new Set<string>();
const authorizing=new Set<string>();
function save(flow:AgentWorkflow){flow.updatedAt=now();db.prepare('UPDATE agent_workflows SET payload=? WHERE id=?').run(JSON.stringify(flow),flow.id);}
function decodeWorkflow(row:Record<string,unknown>){
  const flow=JSON.parse(String(row.payload)) as AgentWorkflow;
  // Older workflows recorded grants only on individual submission receipts.
  flow.taskId??=[...flow.history].reverse().find(h=>h.taskId)?.taskId;
  const last=flow.history.at(-1);
  // The saved step describes that attempt, never the newly selected model.
  if(last&&!last.model&&last.key===flow.step.key&&['text','image','video'].includes(last.kind))last.model=flow.step.model;
  return flow;
}
export function workflowsFor(projectId:string){getProject(projectId);return db.prepare('SELECT payload FROM agent_workflows WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId).map(decodeWorkflow);}
export function workflowsForTask(projectId:string,taskId:string){
  getProject(projectId);
  // Include legacy records, whose effective task is the last history grant.
  return db.prepare("SELECT payload FROM agent_workflows WHERE project_id=? AND (json_extract(payload,'$.taskId')=? OR json_extract(payload,'$.taskId') IS NULL)").all(projectId,taskId).map(decodeWorkflow).filter(w=>w.taskId===taskId);
}
export function getWorkflow(projectId:string,workflowId:string){getProject(projectId);const row=db.prepare('SELECT payload FROM agent_workflows WHERE project_id=? AND id=?').get(projectId,workflowId);if(!row)throw Error('流程不存在');return decodeWorkflow(row);}
export function bindWorkflowTask(projectId:string,workflowId:string,taskId:string){
  const flow=getWorkflow(projectId,workflowId),task=agentTask(projectId,taskId,flow.episodeId);
  if(flow.taskId&&flow.taskId!==taskId&&findAgentTask(projectId,flow.taskId)?.pausedAt)
    throw Error('原任务已暂停，请先在软件任务面板恢复，不能用新额度绕过暂停');
  if((flow.delivery||'video')!==task.delivery)throw Error('工作流交付范围与任务授权不一致');
  const newGrant=flow.taskId!==taskId;
  flow.taskId=taskId;
  // A new grant must see the current pending inputs. A failed attempt remains
  // failed in its own history; updating this preview never submits or retries it.
  if(newGrant&&!busy.has(flow.id)&&!authorizing.has(flow.id)&&['waiting_budget','failed'].includes(flow.status)){
    const failed=flow.status==='failed',error=flow.error;
    refresh(flow);
    if(failed){flow.status='failed';flow.error=error;}
  }
  save(flow);return flow;
}
function context(flow:AgentWorkflow){const project=getProject(flow.projectId),episode=project.episodes.find(e=>e.id===flow.episodeId);if(project.archivedAt||!episode)throw Error('项目已回收或分集不存在');return {project,episode};}
function step(kind:WorkflowStep['kind'],key:string,label:string,message:string,tab:WorkflowStep['tab'],extra:Partial<WorkflowStep>={}):WorkflowStep{return {kind,key,label,message,tab,submissions:0,...extra};}
function next(flow:AgentWorkflow):WorkflowStep {
  const {project:p,episode:e}=context(flow);
  const gate=(key:string,label:string,message:string,tab:WorkflowStep['tab'])=>step('gate',key,label,message,tab);
  const text=(task:NonNullable<WorkflowStep['task']>,fingerprint:unknown,label:string,tab:WorkflowStep['tab'],segmentId?:string)=>{
    const key=task+':'+digest({fingerprint,model:p.textModel});
    if(flow.history.some(h=>h.key===key))return gate(key,label,'候选已生成或已尝试，请在原有页面检查结果；不会自动重复付费。',tab);
    const segment=e.segments.find(s=>s.id===segmentId);
    const preview={task,model:p.textModel?.modelId,projectId:p.id,episodeId:e.id,
      ...(['highlight','script','semantic'].includes(task)?{sourceText:e.sourceText}:{}),
      ...(task==='script'?{highlightReport:e.highlightReport,videoModel:p.videoModel}:{}),
      ...(['assets','semantic'].includes(task)?{beats:e.scriptBeats,existingAssets:p.assets}:{}),
      ...(segment?{segment,beats:e.scriptBeats,availableAssets:p.assets}:{}),
    };
    return step('text',key,label,'生成待核对候选，保留已有正文、锁稿和选用。',tab,{task,model:p.textModel?.modelId,segmentId,preview,submissions:1});
  };
  const image=(asset:NonNullable<Project['assets']>[number],stateId:string,role:string,segmentId:string)=>{
    const input={kind:'image',assetId:asset.id,stateId,role,count:1,feedback:'',episodeId:e.id,segmentId};
    const preview=candidatePreview(p.id,input),key='image:'+preview.hash;
    if(flow.history.some(h=>h.key===key))return gate(key,'检查图片生成结果','查看生成任务或候选，失败及结果未知不会自动补跑。','assets');
    return step('image',key,`生成 ${asset.name} · ${role==='turnaround'?'完整四视图＋大头照':'主图'}`,'本次生成一个候选，不替换当前选用。','assets',{input,preview,submissions:1,model:p.imageModel?.modelId});
  };
  if(e.sourceReviewedHash!==sourceHash(e)||e.sourceText.trim().length<50)return gate('source','完整原文','请在“原文与高光”保存完整章节并确认已阅读。','source');
  if(!e.scriptLockedHash){
    if(e.highlightReviewedHash!==highlightHash(e)||!e.highlightReport.trim())return e.highlightCandidate?.sourceHash===sourceHash(e)?gate('highlight-review','核对高光报告','查看模型候选，采用并确认高光剧情报告。','source'):text('highlight',sourceHash(e),'提取高光报告','source');
    if(e.scriptBeats.length)return gate('script-lock','锁定正式剧本','保留已有剧本草稿，对照完整原文与高光核对后锁定。','script');
    if(e.scriptCandidate)return gate('script-review','核对并锁定剧本','查看剧本候选，核对原文依据、对白和反应，再锁定正式剧本。','script');
    return text('script',{source:sourceHash(e),highlight:highlightHash(e),video:p.videoModel},'生成剧本候选','script');
  }
  if(e.scriptLockedHash!==scriptHash(e))return gate('script-changed','剧本已变化','请重新核对正式剧本版本。','script');
  if(e.highlightReviewedHash!==highlightHash(e)||!e.highlightReport.trim())return gate('highlight-review','核对高光报告','高光报告缺失或已变化，请对照完整原文重新核对。','source');
  if(e.sourceTraceRequired&&e.storyReview?.hash!==storyReviewHash(e))return e.semanticCandidate?.hash===storyReviewHash(e)?gate('semantic-review','核对原文覆盖','在正式剧本中查看语义核对候选并确认。','script'):text('semantic',storyReviewHash(e),'生成原文覆盖核对建议','script');
  if(e.assetCandidate?.scriptHash===e.scriptLockedHash)return gate('asset-review','核对资产清单','在“资产与状态”采用清单并核对各片段绑定。','assets');
  if(e.segments.some(s=>!s.assetBindings?.length))return text('assets',e.scriptLockedHash,'提取人物、场景和道具','assets');
  for(const s of e.segments)for(const binding of s.assetBindings||[]){
    const asset=p.assets?.find(a=>a.id===binding.assetId);if(!asset)return gate('binding','核对资产绑定','存在缺失资产，请在资产与状态中修正。','assets');
    const state=effectiveState(asset,e,s,binding.stateId),stateId=state?.id||'';
    if(binding.stateId&&!state)return gate('binding-state','核对资产状态',`“${asset.name}”绑定的状态已不存在，请重新选择。`,'assets');
    if(requiresPortraitReference(asset)){
      const prepare=(sid:string):WorkflowStep|undefined=>{
        const current=asset.images.filter(i=>(i.stateId||'')===sid&&i.inputHash===assetInputHash(p,asset.id,sid));
        const reviewedSheet=current.some(i=>isCharacterSheet(i)&&i.review?.status==='approved');
        if(reviewedSheet)return;
        const sheet=current.filter(isCharacterSheet).at(-1);
        if(!sheet)return image(asset,sid,'turnaround',s.id);
        if(sheet.review?.status!=='approved')return gate('character-sheet-review:'+asset.id+sid,'审图：三视图＋大头照',`核对“${asset.name}”横向四格依次为正面全身、90°侧面全身、背面全身、正面大头照；四格必须同一身份与当前服饰。错图先返修，不能迁就错图。`,'assets');
        return;
      };
      const approved=asset.images.filter(i=>(i.stateId||'')===stateId&&i.review?.status==='approved'&&i.inputHash===assetInputHash(p,asset.id,stateId));
      const ready=approved.some(isCharacterSheet);
      if(stateId&&!ready){const base=prepare('');if(base)return base;}
      const current=prepare(stateId);if(current)return current;
      const selected=asset.images.find(i=>i.id===binding.imageId);
      if(!isCharacterSheet(selected)||selected?.review?.status!=='approved'||(selected.stateId||'')!==stateId||selected.inputHash!==assetInputHash(p,asset.id,stateId))
        return gate('character-sheet-binding:'+asset.id+stateId,'选用完整四视图',`请为“${asset.name}”选用当前状态已审图的完整四视图＋大头照，整张传递到视频。`,'assets');
      continue;
    }
    for(const role of ['main']){
      const selected=asset.images.find(i=>i.id===binding.imageId);
      if(selected?.review?.status==='approved'&&((selected.role||'main')===role||role==='main'&&selected.role==='turnaround')&&(selected.stateId||'')===stateId&&selected.inputHash===assetInputHash(p,asset.id,stateId||undefined))continue;
      if(asset.images.some(i=>(i.role||'main')===role&&(i.stateId||'')===stateId))return gate('image-review:'+asset.id+role,'审图并选用参考图',`请核对“${asset.name}”的主图及当前状态，并为片段明确选用。`,'assets');
      if(stateId && !asset.images.some(i=>!i.stateId && i.review?.status==='approved' && i.inputHash===assetInputHash(p,asset.id))){
        if(asset.images.some(i=>!i.stateId))return gate('base-image-review:'+asset.id,'先核对基础身份图',`核对“${asset.name}”基础图后，才能以它为参考生成剧情状态图。`,'assets');
        return image(asset,'','main',s.id);
      }
      return image(asset,stateId,role,s.id);
    }
  }
  for(const s of e.segments){
    if(!s.visualPlan.trim())return gate('visual:'+s.id,'保存视觉与机位',`片段 ${s.number} 尚无视觉与机位，请在片段详情中填写。`,'review');
    if(s.subshotsReviewed!==true){
      if(s.subshotCandidate)return gate('shots-review:'+s.id,'逐镜核对分镜',`查看片段 ${s.number} 的分镜候选并核对。`,'review');
      return text('storyboard',storyboardSourceHash(e,s),`规划片段 ${s.number} 分镜`,'review',s.id);
    }
  }
  const readiness=e.segments.map(s=>({segment:s,...promptReadiness(e,s,p)}));
  const pending=readiness.find(item=>item.state==='candidate');
  if(pending)return gate('prompt-choice:'+pending.segment.id,'核对并选用新提示词',`片段 ${pending.segment.number} 的新版已生成成功。请比较并选用；原选用和历史版本保留，不需要重复生成。`,'review');
  const missing=readiness.filter(item=>item.state!=='ready').map(item=>item.segment);
  if(missing.length){
    const key='prompts:'+digest(missing.map(s=>[s.id,contentHash(e,s)])),receipt=flow.history.find(h=>h.key===key);
    if(receipt){
      const jobs=(receipt.jobIds||[]).map(id=>db.prepare('SELECT status FROM jobs WHERE id=?').get(id) as {status:string}|undefined);
      if(jobs.some(job=>job&&['queued','running','paused'].includes(job.status)))return gate(key,'等待提示词编译','本地任务尚未完成，请查看任务状态；不重复入队。','review');
      if(jobs.some(job=>job?.status==='failed'))return gate(key,'检查提示词任务','本地编译任务失败，请查看失败原因并处理。','review');
      return gate(key,'核对提示词内容','编译任务已经结束，请核对受影响片段的正文或候选；不会重复入队。','review');
    }
    return step('local',key,'生成完整视频提示词','只组装缺失或实际不兼容的片段，不调用收费模型。','review',{task:'prompts',input:{segmentIds:missing.map(s=>s.id)}});
  }
  const issues=auditEpisode(e,p);if(issues.length||e.auditApprovedHash!==approvalHash(e))return gate('audit','五层核对放行',issues.slice(0,6).join('；')||'请使用原有“五层核对”按钮放行本集。','export');
  if (flow.delivery === 'package') return step('export','package:'+approvalHash(e),'导出分镜生产包','本任务完成生产包后停止。','export',{task:'package'});
  const successful=e.segments.filter(s=>{const a=selectedArtifact(s,'video');return a&&usableVideo(p,e,s,a)&&(a.review?.status==='approved'||a.userAcceptance?.status==='accepted');});
  for(const s of e.segments){
    if(successful.some(t=>t.id===s.id))continue;
    if(s.artifacts.some(a=>a.kind==='video'&&a.mediaPath&&usableVideo(p,e,s,a)))return gate('video-review:'+s.id,'审片并选用',`查看片段 ${s.number} 的视频候选并选用。`,'review');
    if(s.number>1&&e.sampleApprovedHash!==sampleGateHash(p,e))return gate('sample','首片放行','请先核对一个正式试片，再点击原有“试片放行”。','review');
    const input={kind:'video',episodeId:e.id,segmentId:s.id,count:1,feedback:'',requestId:flow.id+'-'+(flow.history.length+1)};const preview=candidatePreview(p.id,input),key='video:'+preview.hash;
    if(flow.history.some(h=>h.key===key))return gate(key,'检查视频任务','结果未知请先查询或找回原任务，不自动重复付费。','review');
    return step('video',key,`生成片段 ${s.number} 视频`,'提交一个候选，保留原版本及当前选用。','review',{input,preview,segmentId:s.id,model:p.videoModel?.modelId,submissions:1});
  }
  return step('export','export:'+digest(e.segments.map(s=>s.selected.video)),'合成 MP4 成片','所有片段已选用，执行原有导出预检后合成 MP4，并另存剪映草稿。','export');
}
function refresh(flow:AgentWorkflow){flow.step=next(flow);delete flow.error;flow.step.hash=digest({step:flow.step,project:context(flow).project});flow.status=flow.step.kind==='gate'?'waiting_review':['text','image','video','export'].includes(flow.step.kind)?'waiting_budget':'running';save(flow);}
export function startWorkflow(projectId:string,input:Record<string,unknown>){
  const project=getProject(projectId);
  if(input.delivery!==undefined&&input.delivery!=='package'&&input.delivery!=='video')throw Error('交付类型无效');
  const row=db.prepare("SELECT payload FROM agent_workflows WHERE project_id=? AND episode_id=? AND json_extract(payload,'$.status') NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1").get(projectId,String(input.episodeId||''));
  const existing=row?decodeWorkflow(row):undefined;
  if(existing){if(input.delivery && (existing.delivery || 'video') !== input.delivery)throw Error('已有工作流交付范围不同，请先取消旧流程');return input.taskId?bindWorkflowTask(projectId,existing.id,String(input.taskId)):existing;}
  const task=input.taskId?agentTask(projectId,String(input.taskId),String(input.episodeId||'')):undefined;
  const delivery=input.delivery??task?.delivery??productionRules(project.productionRules).delivery;
  if(task&&delivery!==task.delivery)throw Error('工作流交付范围与任务授权不一致');
  const limits={text:20,image:40,video:delivery==='video'?10:0};
  for(const kind of ['text','image','video'] as const){const n=Number((input.limits as Record<string,unknown>|undefined)?.[kind]??limits[kind]);if(!Number.isInteger(n)||n<0||n>200)throw Error('提交次数上限须为0–200的整数');limits[kind]=n;}
  if(delivery==='package'&&limits.video)throw Error('生产包流程不包含视频生成额度');
  const flow:AgentWorkflow={id:id(),projectId,episodeId:String(input.episodeId||''),delivery,createdAt:now(),updatedAt:now(),status:'running',limits,used:{text:0,image:0,video:0},history:[],step:step('gate','source','原文','准备检查当前进度。','source')};context(flow);
  if(input.taskId)flow.taskId=String(input.taskId);
  db.prepare('INSERT INTO agent_workflows VALUES(?,?,?,?,?)').run(flow.id,projectId,flow.episodeId,JSON.stringify(flow),flow.createdAt);refresh(flow);void advanceWorkflow(projectId,flow.id);return getWorkflow(projectId,flow.id);
}
export async function authorizeWorkflow(projectId:string,workflowId:string,input:Record<string,unknown>,taskId?:string){
  if(busy.has(workflowId)||authorizing.has(workflowId))throw Error('当前步骤正在执行或确认');
  authorizing.add(workflowId);
  try {
  const flow=getWorkflow(projectId,workflowId);if(flow.status!=='waiting_budget'||input.confirmed!==true||flow.step.hash!==input.hash)throw Error('请先核对本次步骤、输入与预算');
  if(flow.taskId&&!taskId)throw Error('本流程由Agent任务接管，请使用原任务额度继续');
  if(taskId){bindWorkflowTask(projectId,workflowId,taskId);flow.taskId=taskId;}
  const expected=flow.step.hash;refresh(flow);if(flow.step.hash!==expected)throw Error('输入已变化，请重新核对预算');
  const kind=flow.step.kind;
  let taskQuote: ReturnType<typeof billingQuote> | undefined;
  if (taskId) {
    const task = agentTask(projectId, taskId, flow.episodeId);
    if ((flow.delivery || 'video') !== task.delivery) throw Error('工作流交付范围与任务授权不一致');
    // An explicit new grant provides only its remaining quota. Prior
    // reservations remain recorded on both the old task and this workflow.
    for(const kind of ['text','image','video'] as const)flow.limits[kind]=flow.used[kind]+task.limits[kind]-task.used[kind];
  }
  if(kind==='text'||kind==='image'||kind==='video'){
    if(flow.used[kind]+flow.step.submissions>flow.limits[kind])throw Error('本流程提交次数达到上限；未提交模型请求');
    const adapter=context(flow).project[`${kind}Model`]?.adapterPath||'';
    if(/direct-(text|image|video)\.mjs$/u.test(adapter)){
      const billing=await fetchProviderBilling(true),quote=billingQuote(billing,flow.step.model||'',flow.step.submissions);
      taskQuote = quote;
      if(billing.credentialError)throw Error(billing.credentialError+' 未提交生成。');
      const wallet=billing.accountBalanceStale||billing.accountBalance?.matchesModelKey===false?undefined:billing.accountBalance;
      if(wallet&&wallet.available<=0)throw Error('账户余额不足或已耗尽，未提交生成');
      if(quote.known&&wallet&&wallet.available<quote.maximum)throw Error('账户余额不足以覆盖本步报价，未提交生成');
      if(billing.quota&&!billing.quota.unlimited&&billing.quota.available<=0)throw Error('当前密钥额度不足或已耗尽，未提交生成');
      if(billing.quota?.expiresAt&&billing.quota.expiresAt*1000<Date.now())throw Error('当前密钥已过期');
      if(quote.known&&billing.quota&&!billing.quota.unlimited&&billing.conversion&&billing.quotaPerUnit&&billing.quota.available/billing.quotaPerUnit*billing.conversion<quote.maximum)throw Error('当前密钥额度不足以覆盖公开报价上界，未提交生成');
      if(!quote.known&&input.acceptUnknownCost!==true)throw Error('实际费用尚无法估计，请明确确认未知费用');
      if(!taskId&&input.pricingVersion!==billing.pricingVersion)throw Error('价格版本已变化，请刷新费用并重新确认');
    }
  }
  const latest=getWorkflow(projectId,workflowId);
  if(latest.status!=='waiting_budget'||latest.step.hash!==expected||latest.taskId!==flow.taskId)throw Error('流程状态已变化，未提交生成');
  const freshStep=next(flow);freshStep.hash=digest({step:freshStep,project:context(flow).project});
  if(freshStep.hash!==expected)throw Error('查询费用期间输入已变化，请重新核对');
  if (taskId && (kind === 'text' || kind === 'image' || kind === 'video'))
    reserveAgentSubmission(projectId, taskId, flow.episodeId, kind, flow.step.submissions, taskQuote);
  else if(taskId)agentTask(projectId,taskId,flow.episodeId);
  // Reserve before execution: crashes and unknown remote outcomes consume the slot.
  if(kind==='text'||kind==='image'||kind==='video')flow.used[kind]+=flow.step.submissions;
  flow.history.push({key:flow.step.key,label:flow.step.label,status:'running',at:now(),submissions:flow.step.submissions,kind,...(flow.step.model?{model:flow.step.model}:{}),...(taskId?{taskId}:{})});flow.status='running';save(flow);
  void execute(flow);return flow;
  } finally {authorizing.delete(workflowId);}
}
// An awaited operation owns only its receipt/result, not the snapshot's task
// binding or control state. Merge into the latest row at every completion.
function mergeExecution(flow:AgentWorkflow,receipt:AgentWorkflow['history'][number],result?:Pick<AgentWorkflow,'exportResult'>){
  const current=getWorkflow(flow.projectId,flow.id);
  const item=current.history.find(h=>h.key===receipt.key&&h.at===receipt.at);
  if(!item)throw Error('本次执行记录已变化，不能覆盖最新工作流');
  Object.assign(item,receipt);
  if(result)current.exportResult=result.exportResult;
  save(current);return current;
}
function executionStopped(flow:AgentWorkflow){
  if(['paused','cancelled','completed'].includes(flow.status))return true;
  if(flow.taskId){
    const task=findAgentTask(flow.projectId,flow.taskId);
    if(task?.revokedAt){flow.status='cancelled';save(flow);return true;}
    try{agentTask(flow.projectId,flow.taskId,flow.episodeId);}catch(error){flow.status='paused';flow.error=(error as Error).message;save(flow);return true;}
  }
  return false;
}
async function execute(flow:AgentWorkflow){
  if(busy.has(flow.id))return;busy.add(flow.id);
  const receipt=flow.history.at(-1)!;
  try{
    const op=flow.step;
    if(op.kind==='text'){
      if(op.task==='highlight')await suggestHighlight(flow.projectId,flow.episodeId);
      else if(op.task==='script')await suggestScript(flow.projectId,flow.episodeId);
      else if(op.task==='assets')await suggestAssets(flow.projectId,flow.episodeId);
      else if(op.task==='semantic')await suggestSemanticReview(flow.projectId,flow.episodeId);
      else if(op.task==='storyboard')await suggestSubshots(flow.projectId,flow.episodeId,op.segmentId!,1);
    }else if(op.kind==='image'||op.kind==='video'){
      receipt.batchId=flow.id+'-'+flow.history.length;
      const preview=candidatePreview(flow.projectId,op.input!);
      createCandidates(flow.projectId,{...op.input,hash:preview.hash,requestId:receipt.batchId,confirmed:true});mergeExecution(flow,receipt);return;
    }else if(op.kind==='local'){
      if(op.task!=='prompts')throw Error('旧版独立人物裁图步骤已移除，请重新核对并选用完整四视图');
      receipt.jobIds=enqueue(flow.projectId,flow.episodeId,op.input!.segmentIds as string[],['prompt']).map(j=>j.id);mergeExecution(flow,receipt);return;
    }else if(op.kind==='export'){
      if (op.task === 'package') {
        flow.exportResult = { package: exportProductionPackage(flow.projectId, flow.episodeId) };
        receipt.status = 'completed';
        const current=mergeExecution(flow,receipt,{exportResult:flow.exportResult});
        if(executionStopped(current))return;
        current.status = 'completed'; save(current); return;
      }
      const {project,episode}=context(flow),preflight=await preflightEpisode(project,episode);
      if(preflight.issues.length)throw Error(preflight.issues.join('；'));
      const mp4=await exportEpisodeMp4(flow.projectId,flow.episodeId,{upscale:false});
      flow.exportResult={mp4};mergeExecution(flow,receipt,{exportResult:flow.exportResult});
      try {
        const draft=await exportEpisode(flow.projectId,flow.episodeId,{upscale:false});
        flow.exportResult={...draft,mp4};
      } catch(error) {
        // A separately saved MP4 remains usable even if the draft destination fails.
        flow.exportResult={mp4,draftError:(error as Error).message};
      }
      receipt.status='completed';
      const current=mergeExecution(flow,receipt,{exportResult:flow.exportResult});
      if(executionStopped(current))return;
      current.status='completed';save(current);return;
    }
    receipt.status='completed';
    const current=mergeExecution(flow,receipt);if(executionStopped(current))return;refresh(current);
  }catch(error){receipt.status='failed';receipt.error=(error as Error).message;
    const current=mergeExecution(flow,receipt);current.error=receipt.error;
    if(!executionStopped(current))current.status='failed';save(current);}
  finally{busy.delete(flow.id);}
}
export async function advanceWorkflow(projectId:string,workflowId:string){
  if(busy.has(workflowId))return getWorkflow(projectId,workflowId);
  const flow=getWorkflow(projectId,workflowId);if(['paused','cancelled','completed','failed'].includes(flow.status))return flow;
  if(flow.taskId){try{agentTask(projectId,flow.taskId,flow.episodeId);}catch(error){flow.status='paused';flow.error=(error as Error).message;save(flow);return flow;}}
  const receipt=flow.history.at(-1);
  if(receipt?.status==='running'){
    if(receipt.batchId){const batch=candidateBatches(projectId).find(b=>b.id===receipt.batchId);if(!batch)return fail(flow,receipt,'预约记录缺失；未自动补跑');if(batch.items.some(i=>i.status==='failed'||i.status==='cancelled'))return fail(flow,receipt,batch.items.find(i=>i.error)?.error||'候选未完成');if(batch.items.some(i=>i.status!=='completed'))return flow;}
    else if(receipt.jobIds){const jobs=jobsFor(projectId).filter(j=>receipt.jobIds!.includes(j.id));if(jobs.length!==receipt.jobIds.length||jobs.some(j=>['failed','cancelled'].includes(j.status)))return fail(flow,receipt,jobs.find(j=>j.error)?.error||'提示词任务未完成');if(jobs.some(j=>j.status!=='completed'))return flow;}
    else return fail(flow,receipt,'上次执行中断，结果须先核对；未自动重试');
    receipt.status='completed';save(flow);
  }
  refresh(flow);
  if(flow.step.kind==='local'){flow.history.push({key:flow.step.key,label:flow.step.label,status:'running',kind:'local',at:now(),submissions:0});save(flow);void execute(flow);}
  return flow;
}
function fail(flow:AgentWorkflow,receipt:AgentWorkflow['history'][number],message:string){receipt.status='failed';receipt.error=message;flow.status='failed';flow.error=message;save(flow);return flow;}
export async function controlWorkflow(projectId:string,workflowId:string,operation:string){
  const flow=getWorkflow(projectId,workflowId);
  if(operation==='pause'||operation==='cancel'){
    if(['completed','cancelled'].includes(flow.status))return flow;
    if(operation==='pause'&&flow.taskId)pauseAgentTask(projectId,flow.taskId);
    const affected=operation==='pause'&&flow.taskId?workflowsForTask(projectId,flow.taskId):[flow];
    for(const item of affected){
      if(['completed','cancelled'].includes(item.status))continue;
      item.status=operation==='pause'?'paused':'cancelled';save(item);const batch=item.history.at(-1)?.batchId;if(batch)controlCandidates(projectId,batch,operation);
      for(const jobId of item.history.at(-1)?.jobIds||[])db.prepare("UPDATE jobs SET status=? WHERE id=? AND status='queued'").run(operation==='pause'?'paused':'cancelled',jobId);
    }
    return getWorkflow(projectId,workflowId);
  }
  if(operation!=='resume'||['cancelled','completed'].includes(flow.status))throw Error('当前流程不能继续；请重新建立流程');
  if(flow.taskId)agentTask(projectId,flow.taskId,flow.episodeId);
  flow.status='running';save(flow);const batch=flow.history.at(-1)?.batchId;if(batch)controlCandidates(projectId,batch,'resume');
  for(const jobId of flow.history.at(-1)?.jobIds||[])db.prepare("UPDATE jobs SET status='queued' WHERE id=? AND status='paused'").run(jobId);
  return advanceWorkflow(projectId,workflowId);
}
export function startWorkflows(){setInterval(()=>{for(const row of db.prepare("SELECT payload FROM agent_workflows WHERE json_extract(payload,'$.status')='running'").all()){const flow=decodeWorkflow(row);void advanceWorkflow(flow.projectId,flow.id).catch(error=>{const current=getWorkflow(flow.projectId,flow.id);if(!executionStopped(current)){current.status='failed';current.error=error.message;save(current);}});}},1000).unref();}
