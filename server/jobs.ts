import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {adapterTimeout,terminateChild} from './process-contract.js';
import {referenceHashes} from './reference-provenance.js';
import { usableVideo, generationSignature, generationSignatureMatches } from '../shared/generation.js';
import {requiresPortraitReference} from '../shared/asset-references.js';
import {approvedAudioTrial}from'./unknown-retry.js';
import { expectedResolution, validateGeneratedMedia } from '../shared/media-contract.js';
import { anchorSvg, approvalHash, beatFor, selectedPromptContractIssues, composePrompt, contentHash, id, knownVideoCapabilities, now, sampleGateHash,
  segmentReferences, selectedArtifact, videoReferences,
  type Artifact, type ArtifactKind, type Episode, type Segment } from '../shared/model.js';
import type { Project } from '../shared/model.js';
import { effectVersion, visualDescription } from './effects.js';
import { mediaPath, probe, relativeMedia } from './media.js';
import {runtimePreflight} from './maintenance.js';
import {generateAssetImage} from './assist.js';
import {candidatePrompt} from '../shared/candidate-contract.js';
import {preparedVideoPrompt} from './video-prompt.js';
import {PROMPT_TEMPLATE_VERSION} from '../shared/prompt-contract.js';
import {buildVideoPrompt,MODEL_PROMPT_FORMAT} from '../shared/video-prompt.js';
import {sha256} from '../shared/hash.js';

function requestPromptMatches(original:Record<string,unknown>, project:Project, episode:Episode, segment:Segment, feedback?:string,
  frozenPrompt?:ReturnType<typeof preparedVideoPrompt>) {
  if(frozenPrompt)return original.promptFormat===frozenPrompt.format&&original.prompt===frozenPrompt.content&&
    original.promptHash===frozenPrompt.hash&&sha256(frozenPrompt.content)===frozenPrompt.hash;
  const base=selectedArtifact(segment,'prompt')?.content||'';
  if(original.promptFormat===undefined)return original.prompt===candidatePrompt(base,feedback);
  const prepared=buildVideoPrompt(base,videoReferences(project,episode,segment),feedback);
  return original.promptFormat===MODEL_PROMPT_FORMAT&&original.prompt===prepared.content&&original.promptHash===prepared.hash;
}
import {waitingForTextBudget} from './local-submission.js';
import {concurrencyLimits} from './concurrency.js';
import {cancelQueuedAdapter,AdapterCancelledError} from './adapter-runner.js';
import { acquireWorker, db, getProject, generationSpec,insertJobs, jobById, nextJob, setJob, updateProject, type Job } from './store.js';

let active = false;
let scheduled = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function prepareJobs(projectId: string, episodeId: string, segmentIds: string[], kinds: ArtifactKind[],
  options: { regenerate?: boolean; candidate?: {batchId:string; candidateId:string; keepSelection:true;feedback?:string} } = {}): Job[] {
  segmentIds = [...new Set(segmentIds)]; kinds = [...new Set(kinds)];
  const project = getProject(projectId);
  const episode = project.episodes.find(item => item.id === episodeId);
  if (!episode || !episode.scriptLockedHash) throw new Error('请先锁定正式剧本');
  if (!segmentIds.length || !kinds.length) throw new Error('请先选择片段和生成内容');
  if (kinds.some(kind => !['anchor', 'prompt', 'video'].includes(kind))) throw new Error('未知生成类型');
  if (kinds.includes('video') && !(project.videoModel?.adapterPath || process.env.MANJU_VIDEO_ADAPTER))
    throw new Error('尚未配置视频模型适配器；可先生成生产包并为片段导入已有视频');
  if (kinds.includes('video') && episode.auditApprovedHash !== approvalHash(episode))
    throw new Error('五层无损核对未通过，请先核对并放行本集');
  if (kinds.includes('video') && new Set(segmentIds).size > 1 &&
    (episode.sampleApprovedHash !== sampleGateHash(project, episode) ||
      !episode.segments.some(segment => selectedArtifact(segment, 'video')?.review?.status === 'approved')))
    throw new Error('请先生成并审片通过一个正式试片，再放行本集批量视频生成');
  if (kinds.includes('video') && !runtimePreflight().ready) throw new Error('本机 FFmpeg/FFprobe 不可用，无法核验输出，已阻止提交视频生成');
  const jobs: Job[] = [];
  for (const segmentId of segmentIds) {
    const segment = episode.segments.find(item => item.id === segmentId);
    if (!segment) throw new Error('片段不属于当前分集');
    if (!segment.visualPlan.trim()) throw new Error(`片段 ${segment.number} 尚无视觉与机位`);
    for (const kind of kinds) {
      let preparedPrompt: ReturnType<typeof preparedVideoPrompt> | undefined;
      if (kind === 'video' && (!selectedArtifact(segment, 'prompt') ||
        selectedArtifact(segment, 'prompt')?.sourceHash !== contentHash(episode, segment)))
        throw new Error(`片段 ${segment.number} 缺少已核对的最终视频提示词`);
      if (kind === 'video') {
        const contractIssues=selectedPromptContractIssues(episode,segment,project);if(contractIssues.length)throw new Error(contractIssues.join('；'));
        if (segment.durationSec !== 30) throw new Error('每个生成片段必须固定30秒');
        const currentHash = contentHash(episode, segment);
        const completed = segment.artifacts.some(item => item.kind === 'video' && item.mediaPath &&
          usableVideo(project, episode, segment, item));
        if (completed && !options.regenerate)
          throw new Error(`片段 ${segment.number} 已有当前剧本与模型的成功视频；如需新版，请从该片段明确选择重新生成`);
        const ambiguous = db.prepare("SELECT id FROM jobs WHERE project_id=? AND segment_id=? AND kind='video' AND status='failed'")
          .all(projectId, segmentId) as { id: string }[];
        for (const old of ambiguous) {
          const remote = path.join(mediaPath(path.join('generated', episode.id, segment.id)), `${old.id}.mp4.remote.json`);
          if (existsSync(remote)) {
            let state: { status?: string } = {};
            try { state = JSON.parse(readFileSync(remote, 'utf8')); } catch { /* 未知状态仍阻断 */ }
            if (!['downloaded', 'failed', 'cancelled', 'not_submitted'].includes(state.status || ''))
              throw new Error(`片段 ${segment.number} 的旧视频任务远端状态不明；请先核对或找回，不能重复付费`);
          } else throw new Error(`片段 ${segment.number} 的旧视频任务缺少远端对账记录，禁止重复付费`);
        }
        const known = knownVideoCapabilities(project.videoModel?.modelId || '');
        const capability = { ...known, ...project.videoModel?.capabilities,
          fixedDurationSec: known?.fixedDurationSec || project.videoModel?.capabilities?.fixedDurationSec };
        const audioTrial=approvedAudioTrial(projectId,segment.id,project.videoModel?.modelId||'',options.candidate?.batchId);
        if (path.basename(project.videoModel?.adapterPath || '').toLowerCase() === 'direct-video.mjs' &&
          (!capability?.maxDurationSec || !capability.maxReferences || (capability.nativeAudio === undefined&&!audioTrial)))
          throw new Error('当前视频模型缺少时长、参考图或原生声音能力配置；请先在模型设置中核对后再付费提交');
        const refs = videoReferences(project, episode, segment);
        if (refs.some(item => !item.mediaPath)) throw new Error(`片段 ${segment.number} 有未就绪的资产参考图`);
        for (const ref of refs.filter(item => requiresPortraitReference(item) && item.role === 'main'))
          if (ref.referenceLayout !== 'three-view-portrait')
            throw new Error(`片段 ${segment.number} 的人物“${ref.name}”缺少当前剧情状态的完整四视图＋大头照`);
        if (capability?.maxDurationSec && segment.durationSec > capability.maxDurationSec)
          throw new Error(`片段 ${segment.number} 超过视频模型时长上限`);
        if (capability?.fixedDurationSec && segment.durationSec !== capability.fixedDurationSec)
          throw new Error(`片段 ${segment.number} 为 ${segment.durationSec} 秒，当前视频模型只接受固定 ${capability.fixedDurationSec} 秒；请选择支持该时长的模型，不要为凑时长拉长空镜`);
        if (capability?.maxReferences && refs.length > capability.maxReferences)
          throw new Error(`片段 ${segment.number} 超过视频模型参考图上限`);
        preparedPrompt = preparedVideoPrompt(project, episode, segment, options.candidate?.feedback);
        if (capability?.aspectRatios?.length &&
          !capability.aspectRatios.includes(project.aspectRatio || '16:9'))
          throw new Error('项目画幅不在视频模型支持范围内');
        if (capability?.outputResolution && capability.resolutions?.length && !capability.resolutions.includes(capability.outputResolution))
          throw new Error('选择的输出分辨率不在模型支持列表中');
        const beat = beatFor(episode, segment);
        if (capability?.minDurationSec && segment.durationSec < capability.minDurationSec) throw new Error('模型最短时长超过固定30秒要求');
        if ((capability?.nativeAudio === false || (capability?.nativeAudio !== true&&!audioTrial && path.basename(project.videoModel?.adapterPath || '') === 'direct-video.mjs')) && (beat.dialogue.length || beat.os.length))
          throw new Error(`片段 ${segment.number} 需要模型原生对白/OS声音，但所选模型未声明支持`);
      }
      const inFlight = db.prepare("SELECT id FROM jobs WHERE project_id=? AND segment_id=? AND kind=? AND status IN ('queued','running','paused') LIMIT 1")
        .get(projectId, segmentId, kind);
      if (inFlight) continue;
      jobs.push({ id: options.candidate?.candidateId || id(), project_id: projectId, episode_id: episodeId, segment_id: segmentId,
        kind, status: 'queued', error: null, created_at: now(), updated_at: now(),
        snapshot: JSON.stringify({ version: 1, candidate:options.candidate, ...(preparedPrompt ? { preparedPrompt } : {}), project: { ...project, sourceCorpus: undefined, episodePlan: undefined, episodePlanProgress: undefined,
          archivedEpisodes: undefined, episodes: [{ ...episode, scriptHistory: undefined }],
          assets: project.assets?.filter(asset => segment.assetBindings?.some(binding => binding.assetId === asset.id)) },
          hash: kind === 'video' ? generationSignature(project, episode, segment) : contentHash(episode, segment),
          references: kind === 'video' ? referenceHashes(project, episode, segment) : [] }) });
    }
  }
  return jobs;
}

// Run the same local checks before requesting a spending confirmation. This
// function never inserts jobs or starts an adapter.
export function validateGeneration(...args: Parameters<typeof prepareJobs>): void {
  prepareJobs(...args);
}

export function enqueue(...args: Parameters<typeof prepareJobs>): Job[] {
  const jobs = prepareJobs(...args);
  insertJobs(jobs);
  wake();
  return jobs;
}

export function pauseProject(projectId: string): void {
  db.prepare("UPDATE jobs SET status='paused',updated_at=? WHERE project_id=? AND status='queued'").run(now(), projectId);
  db.prepare("UPDATE candidate_batches SET payload=json_set(payload,'$.paused',json('true')) WHERE project_id=?").run(projectId);
}

export function cancelQueued(projectId: string, jobId: string): void {
  const changed = db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=? AND project_id=? AND status IN ('queued','paused')").run(now(),jobId,projectId);
  if (!changed.changes && !cancelQueuedAdapter(projectId, jobId))
    throw new Error('只能取消尚未提交的排队/暂停任务；已提交模型任务必须向供应商核对');
}

export function reconcileTask(projectId: string, jobId: string, input: Record<string, unknown>): void {
  if (input.confirmed !== true || typeof input.receipt !== 'string' || input.receipt.trim().length < 8 ||
    !['failed','cancelled','not_submitted'].includes(String(input.status))) throw new Error('须提供供应商核对凭据并明确确认失败、取消或未提交，不能凭猜测释放计费保护');
  const job = jobById(jobId);
  if(job?.kind==='image') {
    if(job.project_id!==projectId||job.status!=='failed')throw new Error('图片任务不在待对账状态');
    const changed=db.prepare("UPDATE adapter_tasks SET status='failed',error=?,updated_at=? WHERE project_id=? AND json_extract(snapshot,'$.request.candidateId')=? AND status='remote_unknown'").run(`供应商人工对账：${input.receipt}`,now(),projectId,job.id);
    if(!changed.changes)throw new Error('此图片任务没有未知计费记录，无需释放');
    return;
  }
  if (job) {
    if (job.project_id !== projectId || job.kind !== 'video' || job.status !== 'failed') throw new Error('视频任务不在待对账状态');
    const file = mediaPath(path.join('generated',job.episode_id,job.segment_id,`${job.id}.mp4.remote.json`));
    mkdirSync(path.dirname(file),{recursive:true});
    const prior = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...prior, status: input.status, reconciledAt: now(), receipt: input.receipt.trim(), manuallyConfirmed: true },null,2));
  } else {
    const changed = db.prepare("UPDATE adapter_tasks SET status='failed',error=?,updated_at=? WHERE id=? AND project_id=? AND status IN ('remote_unknown','running')")
      .run(`供应商人工对账：${input.receipt}`,now(),jobId,projectId);
    if (!changed.changes) throw new Error('任务不在待对账状态');
  }
}

export function resumeProject(projectId: string): void {
  db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE project_id=? AND status='paused'").run(now(), projectId);
  db.prepare("UPDATE candidate_batches SET payload=json_set(payload,'$.paused',json('false')) WHERE project_id=? AND COALESCE(json_extract(payload,'$.cancelled'),0)=0 AND NOT EXISTS(SELECT 1 FROM json_each(candidate_batches.payload,'$.items') WHERE json_extract(value,'$.status')='failed')").run(projectId);
  wake();
}

export function retryFailed(projectId: string): void {
  // A failed paid video request may still be running remotely. It requires
  // provider-side reconciliation before any deliberate resubmission.
    db.prepare("UPDATE jobs SET status='queued',error=NULL,updated_at=? WHERE project_id=? AND status='failed' AND kind NOT IN ('video','image')").run(now(), projectId);
  wake();
}

export async function recoverDownloadedVideo(projectId: string, jobId: string): Promise<Artifact> {
  const job = jobById(jobId);
  if (!job || job.project_id !== projectId || job.kind !== 'video' || !['failed','completed'].includes(job.status))
    throw new Error('只可找回本项目已失败的视频任务');
  const project = getProject(projectId);
  const episode = project.episodes.find(item => item.id === job.episode_id);
  const segment = episode?.segments.find(item => item.id === job.segment_id);
  if(job.status==='completed'&&!segment?.artifacts.some(item=>item.kind==='video'&&item.jobId===job.id))throw new Error('已完成任务缺少原视频版本，不能重复登记');
  if (!episode || !segment || episode.auditApprovedHash !== approvalHash(episode))
    throw new Error('分集剧情或五层核对状态已变化，不能自动绑定旧视频');
  const folder = mediaPath(path.join('generated', episode.id, segment.id));
  const output = path.join(folder, `${jobId}.mp4`);
  const requestFile = path.join(folder, `${jobId}.json`);
  if (!existsSync(output) || !existsSync(requestFile)) throw new Error('本地没有此任务的原请求与视频文件');
  const original = JSON.parse(readFileSync(requestFile, 'utf8')) as Record<string, unknown>;
  const recoverySpec=validateRecoveryRequest(job,original);
  if (!generationSignatureMatches(project, episode, segment, original.generationHash) ||
    JSON.stringify(original.referenceHashes) !== JSON.stringify(referenceHashes(project, episode, segment)))
    throw new Error('找回视频的冻结生成签名或参考图文件已变化');
  if (!requestPromptMatches(original,project,episode,segment,generationSpec(projectId,jobId).candidate?.feedback,recoverySpec.preparedPrompt) ||
    original.durationSec !== segment.durationSec || original.episodeId !== episode.id ||
    original.segmentId !== segment.id || (original.model as { id?: string } | undefined)?.id !== project.videoModel?.modelId)
    throw new Error('视频原请求与当前剧本、时长或模型不一致，不能自动绑定');
  const measured = await probe(output);
  const beat = beatFor(episode, segment);
  validateGeneratedMedia(measured, segment.durationSec, project.aspectRatio || '16:9', Boolean(beat.dialogue.length || beat.os.length), expectedResolution(project));
  if ((beat.dialogue.length || beat.os.length) && !measured.hasAudio)
    throw new Error('找回的视频缺少对白或内心OS所需的声音轨');
  const stat = statSync(output), relative = relativeMedia(output);
  if (!stat.size) throw new Error('找回的视频文件为空');
  const artifact: Artifact = segment.artifacts.find(item => item.kind === 'video' && item.mediaPath === relative) ||
    { id: id(),jobId:job.id,specId:job.id, kind: 'video', createdAt: now(), sourceHash: contentHash(episode, segment),
      generationHash: String(original.generationHash),
      ...(original.promptFormat===MODEL_PROMPT_FORMAT?{modelPromptHash:String(original.promptHash)}:{}),
      referenceHashes: original.referenceHashes as Artifact['referenceHashes'],
      mediaPath: relative, modelName: project.videoModel?.name || '', modelId: project.videoModel?.modelId || '',
      technical: { ...measured, warnings: [], size: stat.size, modifiedAt: stat.mtimeMs } };
  const candidate=generationSpec(projectId,jobId).candidate;
  if(candidate){artifact.candidateId=candidate.candidateId;artifact.batchId=candidate.batchId;}
  updateProject(projectId, current => {
    const target = current.episodes.find(item => item.id === job.episode_id)?.segments
      .find(item => item.id === job.segment_id);
    if (!target || contentHash(current.episodes.find(item => item.id === job.episode_id)!, target) !== artifact.sourceHash)
      throw new Error('片段在找回期间已变化');
    const currentEpisode=current.episodes.find(item=>item.id===job.episode_id)!;
    if(!generationSignatureMatches(current,currentEpisode,target,original.generationHash) || JSON.stringify(referenceHashes(current,currentEpisode,target))!==JSON.stringify(original.referenceHashes)) throw new Error('找回期间生成输入或参考图已变化，未自动绑定');
    const existingIndex=target.artifacts.findIndex(item=>item.id===artifact.id);
    if(existingIndex<0)target.artifacts.push(artifact);else target.artifacts[existingIndex]=artifact;
    if (!generationSpec(projectId,jobId).candidate?.keepSelection && !target.selected.video) target.selected.video = artifact.id;
  });
  setJob(jobId, 'completed');
  return artifact;
}

export function validateRecoveryRequest(job:Job,original:Record<string,unknown>) {
  const frozen=generationSpec(job.project_id,job.id) as {project:Project;hash:string;references:ReturnType<typeof referenceHashes>;candidate?:{feedback?:string};preparedPrompt?:ReturnType<typeof preparedVideoPrompt>};
  const episode=frozen.project.episodes.find(item=>item.id===job.episode_id),segment=episode?.segments.find(item=>item.id===job.segment_id);
  if(!episode || !segment || !generationSignatureMatches(frozen.project,episode,segment,frozen.hash))throw new Error('冻结生成版本损坏或不属于原任务，禁止恢复');
  const model=original.model as {id?:string;capabilities?:unknown} | undefined;
  if(original.generationHash!==frozen.hash || JSON.stringify(original.referenceHashes)!==JSON.stringify(frozen.references) ||
    !requestPromptMatches(original,frozen.project,episode,segment,frozen.candidate?.feedback,frozen.preparedPrompt) || original.durationSec!==segment.durationSec ||
    original.episodeId!==episode.id || original.segmentId!==segment.id || original.aspectRatio!==(frozen.project.aspectRatio || '16:9') ||
    model?.id!==frozen.project.videoModel?.modelId || JSON.stringify(model?.capabilities)!==JSON.stringify(frozen.project.videoModel?.capabilities || knownVideoCapabilities(frozen.project.videoModel?.modelId || '')))
    throw new Error('原请求文件与不可变生成spec不一致，禁止用改写请求找回视频');
  return frozen;
}

export async function recoverRemoteVideo(projectId: string, jobId: string): Promise<Artifact> {
  const job = jobById(jobId);
  if (!job || job.project_id !== projectId || job.kind !== 'video' || job.status !== 'failed')
    throw new Error('只可找回本项目已失败的视频任务');
  const project = getProject(projectId);
  const adapter = project.videoModel?.adapterPath || '';
  if (path.basename(adapter).toLowerCase() !== 'direct-video.mjs')
    throw new Error('当前适配器尚不支持自动找回远端视频，请先在供应商后台核对');
  const episode = project.episodes.find(item => item.id === job.episode_id);
  const segment = episode?.segments.find(item => item.id === job.segment_id);
  if (!episode || !segment) throw new Error('原片段已不存在');
  const folder = mediaPath(path.join('generated', episode.id, segment.id));
  const output = path.join(folder, `${jobId}.mp4`);
  if (existsSync(output)) return recoverDownloadedVideo(projectId, jobId);
  const originalFile = path.join(folder, `${jobId}.json`);
  const remoteFile = `${output}.remote.json`;
  if (!existsSync(originalFile) || !existsSync(remoteFile)) throw new Error('找不到原始请求或远端任务号');
  const original = JSON.parse(readFileSync(originalFile, 'utf8')) as Record<string, unknown>;
  const recoverySpec=validateRecoveryRequest(job,original);
  if (!generationSignatureMatches(project, episode, segment, original.generationHash)) throw new Error('远端视频属于旧生成输入');
  const remote = JSON.parse(readFileSync(remoteFile, 'utf8')) as { id?: string };
  if (!remote.id || !requestPromptMatches(original,project,episode,segment,generationSpec(projectId,jobId).candidate?.feedback,recoverySpec.preparedPrompt) ||
    original.durationSec !== segment.durationSec ||
    (original.model as { id?: string } | undefined)?.id !== project.videoModel?.modelId)
    throw new Error('远端任务与当前剧本、模型或时长不一致，不能自动绑定');
  const recoverRequest = path.join(folder, `${jobId}.recover.json`);
  writeFileSync(recoverRequest, JSON.stringify({ projectId,segmentId:segment.id,task: 'recover', remoteTaskId: remote.id,
    model: original.model }, null, 2));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(adapter), recoverRequest, output],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer=setTimeout(()=>{terminateChild(child);reject(new Error('远端恢复适配器超时；保持未知状态，未重提生成'));},adapterTimeout(40*60_000));
    let stderr = '';
    child.stderr.on('data', data => stderr += data.toString().slice(0, 500));
    child.on('error', error=>{clearTimeout(timer);reject(error);});
    child.on('close', code => {clearTimeout(timer);code === 0 ? resolve() : reject(new Error(`远端找回失败：${stderr.slice(-500)}`));});
  });
  return recoverDownloadedVideo(projectId, jobId);
}

export function wake(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; runQueue(); });
}

// An explicit one-job launch can share the live queue's frozen request. It never
// starts another queue, recovers other jobs, or re-submits a claimed request.
export async function runQueuedVideoConcurrently(projectId:string,jobId:string):Promise<void> {
  const original=jobById(jobId);
  if(!original||original.project_id!==projectId||original.kind!=='video'||original.status!=='queued')
    throw new Error('只能并行启动明确指定、尚未提交的现有视频任务');
  const remote=mediaPath(path.join('generated',original.episode_id,original.segment_id,`${jobId}.mp4.remote.json`));
  if(existsSync(remote))throw new Error('已有提交记录，必须跟踪原任务，禁止重复生成');
  const owner=db.prepare('SELECT pid FROM worker_lease WHERE id=1').get() as {pid:number}|undefined;
  if(!owner)throw new Error('本地队列未启动');
  try{process.kill(owner.pid,0);}catch{throw new Error('本地队列实例已关闭，先恢复原任务');}
  if(waitingForTextBudget(projectId))throw new Error('本项目的文本预算门禁尚未完成，视频保持排队');
  const claimed=db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=? AND project_id=? AND kind='video' AND status='queued' AND (SELECT COUNT(*) FROM jobs WHERE kind='video' AND status='running') < ? RETURNING *")
    .get(now(),jobId,projectId,concurrencyLimits().video) as Job|undefined;
  if(!claimed)throw new Error('现有任务已被领取或视频并发已满，未重复启动');
  try {await perform(claimed);setJob(jobId,'completed');}
  catch(error){
    if(!existsSync(remote)){mkdirSync(path.dirname(remote),{recursive:true});writeFileSync(remote,JSON.stringify({status:'not_submitted',updatedAt:now()}));}
    setJob(jobId,'failed',error instanceof Error?error.message:String(error));throw error;
  } finally { if(owner.pid===process.pid)wake(); }
}

function runQueue(): void {
  if (active) return;
  active = true;
  async function execute(job: Job) {
    try { await perform(job); setJob(job.id, 'completed'); }
    catch (error) {
      if (job.kind === 'video' && job.snapshot) {
        const file = mediaPath(path.join('generated', job.episode_id, job.segment_id, `${job.id}.mp4.remote.json`));
        if (!existsSync(file)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ status: 'not_submitted', updatedAt: now() })); }
      }
      setJob(job.id, error instanceof AdapterCancelledError ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
    } finally { wake(); }
  }
  try {
    acquireWorker();
    const limits = concurrencyLimits();
    const blocked = (db.prepare("SELECT DISTINCT project_id FROM jobs WHERE status='queued' AND kind IN ('image','video')")
      .all() as {project_id: string}[]).filter(row => waitingForTextBudget(row.project_id)).map(row => row.project_id);
    const lanes: Array<{kinds: Job['kind'][]; limit: number; blocked: string[]}> = [
      {kinds: ['image'], limit: limits.image, blocked},
      {kinds: ['video'], limit: limits.video, blocked},
      {kinds: ['anchor', 'prompt'], limit: 1, blocked: []},
    ];
    for (const lane of lanes) {
      const count = Number(db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status='running' AND kind IN (${lane.kinds.map(() => '?').join(',')})`)
        .get(...lane.kinds)?.n || 0);
      for (let slot = count; slot < lane.limit; slot++) {
        const job = nextJob(lane.kinds, lane.blocked, lane.limit);
        if (!job) break;
        void execute(job);
      }
    }
    // Also notices budget changes and jobs finished by an explicit external launcher.
    if (!retryTimer && db.prepare("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").get()) {
      retryTimer = setTimeout(() => { retryTimer = undefined; wake(); }, 1000);
      retryTimer.unref();
    }
  } finally { active = false; }
}

async function perform(job: Job): Promise<void> {
  if (!job.snapshot) throw new Error('旧队列缺少冻结输入，需重新核对后建立任务');
    const frozen = generationSpec(job.project_id,job.id) as { project: Project; hash: string; references: ReturnType<typeof referenceHashes>; preparedPrompt?:ReturnType<typeof preparedVideoPrompt>; candidate?:{batchId:string;candidateId:string;keepSelection:true;feedback?:string}; image?:{assetId:string;stateId:string;role:string;sourceImageId?:string;references?:import('./asset-image-references.js').ImageReference[]} };
    const project = frozen.project;
    if(job.kind==='image' && frozen.image) {
      await generateAssetImage(job.project_id,frozen.image.assetId,frozen.image.stateId,frozen.image.role,{project,candidateId:job.id,batchId:frozen.candidate?.batchId,feedback:frozen.candidate?.feedback},frozen.image);
      return;
    }
  const episode = project.episodes.find(item => item.id === job.episode_id);
  const segment = episode?.segments.find(item => item.id === job.segment_id);
  if (!episode || !segment) throw new Error('任务对应片段不存在');
  if (job.kind === 'video' && episode.auditApprovedHash !== approvalHash(episode)) throw new Error('五层核对状态已变化');
  const source = contentHash(episode, segment);
  const live = getProject(job.project_id), liveEpisode = live.episodes.find(item => item.id === episode.id);
  const liveSegment = liveEpisode?.segments.find(item => item.id === segment.id);
  if (!liveEpisode || !liveSegment || !(job.kind === 'video' ? generationSignatureMatches(live, liveEpisode, liveSegment, frozen.hash) : contentHash(liveEpisode, liveSegment) === frozen.hash))
    throw new Error('排队后输入已变化，冻结任务取消；未提交生成');
  if (job.kind === 'video' && JSON.stringify(referenceHashes(project, episode, segment)) !== JSON.stringify(frozen.references))
    throw new Error('参考图文件内容已变化；未提交生成');
  let content: string | undefined, media: string | undefined;
  if (job.kind === 'anchor') {
    const characters = segmentReferences(project, episode, segment).filter(ref => ref.kind === 'character');
    content = anchorSvg(segment, characters.length > 0 &&
      characters.every(ref => /[蛇蟒]/u.test(`${ref.identity} ${ref.appearance}`)), characters.length);
  }
  else if (job.kind === 'prompt') {
    for (const effectId of segment.effectIds) {
      if (effectVersion(effectId) !== segment.effectVersions[effectId]) throw new Error('特效目录已变化，请重新核对绑定');
    }
    let attachmentRefs:ReturnType<typeof videoReferences>=[];try{attachmentRefs=videoReferences(project,episode,segment);}catch{/* prompts can precede reviewed asset selection */}
    content = composePrompt(episode, segment, segment.effectIds.map(effectId =>
      `正式事件/反应依据“${segment.effectEvidence[effectId]}”：${visualDescription(effectId)}`),
      segmentReferences(project, episode, segment),attachmentRefs,project.labelStyle);
  } else if (job.kind === 'video') media = await generateVideo(job.id, project, episode, segment,frozen.candidate?.feedback,frozen.candidate?.batchId,frozen.preparedPrompt,frozen.hash);
  else throw new Error('未知任务类型');
  const artifact: Artifact = { id: id(), jobId: job.id,specId:job.id, kind: job.kind as ArtifactKind, createdAt: now(), sourceHash: source,
    ...(job.kind === 'video' ? { generationHash: frozen.hash, referenceHashes: frozen.references, modelPromptHash: frozen.preparedPrompt?.hash } : {}),
    ...(job.kind === 'prompt' ? { promptTemplateVersion: PROMPT_TEMPLATE_VERSION } : {}),
    ...(frozen.candidate?{batchId:frozen.candidate.batchId,candidateId:job.id}:{}),
    ...(content ? { content } : {}), ...(media ? { mediaPath: media } : {}),
    ...(job.kind === 'video' && process.env.MANJU_VIDEO_ADAPTER_DEMO === '1' ? { demo: true } : {}),
    ...(job.kind === 'video' ? { modelName: project.videoModel?.name || '本地适配器',
      modelId: project.videoModel?.modelId || '' } : {}) };
  if (artifact.kind === 'video' && media) {
    const file = mediaPath(media), measured = await probe(file), stat = statSync(file);
    artifact.technical = { ...measured, warnings: [], size: stat.size, modifiedAt: stat.mtimeMs };
  }
  updateProject(job.project_id, current => {
    const currentEpisode = current.episodes.find(item => item.id === job.episode_id);
    const currentSegment = currentEpisode?.segments.find(item => item.id === job.segment_id);
    if (!currentEpisode || !currentSegment) throw new Error('片段已移除，生成结果与冻结版本保留在任务记录及素材目录，未自动绑定');
    let same=contentHash(currentEpisode,currentSegment)===source;
    try {if(job.kind==='video')same= same && generationSignatureMatches(current,currentEpisode,currentSegment,frozen.hash) && JSON.stringify(referenceHashes(current,currentEpisode,currentSegment))===JSON.stringify(frozen.references);}catch{same=false;}
    artifact.retainedAsOldVersion=!same;
    currentSegment.artifacts.push(artifact);
    if (same && !frozen.candidate?.keepSelection && !currentSegment.selected[artifact.kind] &&
      !(artifact.kind === 'prompt' && currentSegment.promptSelectionPaused)) currentSegment.selected[artifact.kind] = artifact.id;
    if (artifact.kind === 'prompt' && currentSegment.selected.prompt === artifact.id) currentEpisode.auditApprovedHash = undefined;
  });
}

async function generateVideo(jobId: string, project: Project, episode: Episode, segment: Segment,feedback?:string,batchId?:string,
  frozenPrompt?:ReturnType<typeof preparedVideoPrompt>, frozenHash?: string): Promise<string> {
  const prepared=preparedVideoPrompt(project,episode,segment,feedback);
  if(frozenPrompt && (frozenPrompt.hash!==prepared.hash || frozenPrompt.content!==prepared.content))throw new Error('冻结的完整提交提示词已变化；未提交生成');
  const adapter = project.videoModel?.adapterPath || process.env.MANJU_VIDEO_ADAPTER;
  if (!adapter) throw new Error('未配置视频模型适配器');
  const folder = mediaPath(path.join('generated', episode.id, segment.id));
  mkdirSync(folder, { recursive: true });
  const output = path.join(folder, `${jobId}.mp4`);
  const request = path.join(folder, `${jobId}.json`);
  const references = videoReferences(project, episode, segment).map(ref => {
    if (!ref.mediaPath) throw new Error(`资产“${ref.name}”缺少当前状态的参考图`);
    const file = mediaPath(ref.mediaPath);
    if (!existsSync(file)) throw new Error(`资产“${ref.name}”的参考图文件丢失`);
    return { ...ref, filePath: file };
  });
  writeFileSync(request, JSON.stringify({ projectId:project.id,...(batchId?{batchId}:{}),prompt: prepared.content,
    promptHash:prepared.hash,promptFormat:prepared.format,
    generationHash: frozenHash || generationSignature(project, episode, segment), referenceHashes: referenceHashes(project, episode, segment),
    durationSec: segment.durationSec,
    episodeId: episode.id, segmentId: segment.id, outputPath: output,
    aspectRatio: project.aspectRatio || '16:9', references,
    referenceOrder: ['character:main', 'scene', 'prop'],
    model: { name: project.videoModel?.name || '', id: project.videoModel?.modelId || '',
      capabilities: project.videoModel?.capabilities || knownVideoCapabilities(project.videoModel?.modelId || '') },
    visualStyle: episode.visualStyle || { name: '', description: '' } }, null, 2));
  const executable = path.resolve(adapter);
  const command = /\.(?:mjs|cjs|js)$/i.test(executable) ? process.execPath : executable;
  const args = command === process.execPath ? [executable, request, output] : [request, output];
  writeFileSync(`${output}.remote.json`, JSON.stringify({ status: 'submitting', startedAt: now() }));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { terminateChild(child); reject(new Error('视频适配器超时；远端状态未知，禁止重复提交')); }, adapterTimeout(40 * 60_000));
    let stderr = '';
    child.stderr.on('data', data => stderr += data.toString().slice(0, 500));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`视频适配器失败：${stderr.slice(-500)}`)); });
  });
  const media = await probe(output);
  const beat = beatFor(episode, segment);
  validateGeneratedMedia(media, segment.durationSec, project.aspectRatio || '16:9', Boolean(beat.dialogue.length || beat.os.length), expectedResolution(project));
  if ((beat.dialogue.length || beat.os.length) && !media.hasAudio)
    throw new Error('视频模型结果缺少对白/OS所需的声音轨');
  if (!statSync(output).size) throw new Error('视频适配器未产生有效文件');
  return relativeMedia(output);
}

export function recoverJobs(): void {
  acquireWorker();
  db.prepare("UPDATE adapter_tasks SET status='failed',error='实例重启：排队任务尚未提交，可重新发起',updated_at=? WHERE status='queued'").run(now());
  db.prepare("UPDATE adapter_tasks SET status='remote_unknown',error='实例重启，先核对供应商任务状态再重试',updated_at=? WHERE status='running'").run(now());
  const running = db.prepare("SELECT * FROM jobs WHERE status='running'").all() as unknown as Job[];
  for (const job of running) {
    const episode = getProject(job.project_id).episodes.find(item => item.id === job.episode_id);
    const completed = episode?.segments.find(item => item.id === job.segment_id)?.artifacts
      .some(item => item.jobId === job.id) || (job.kind==='image' && getProject(job.project_id).assets?.some(asset=>asset.images.some(image=>image.candidateId===job.id)));
    if (completed) setJob(job.id, 'completed');
    else if (job.kind === 'video' || job.kind==='image') setJob(job.id, 'failed',
      '服务重启：先核对或找回远端视频，不能自动重复付费');
    else setJob(job.id, 'queued');
  }
  wake();
}
