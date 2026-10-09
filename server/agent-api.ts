import path from 'node:path';
import { db, dataDir, getProject, insertProject, jobsFor, listProjects, updateProject } from './store.js';
import { applyAction } from './actions.js';
import { applyGlobalModels } from './direct-provider.js';
import { productionDefaults } from './production-defaults.js';
import { productionRules } from '../shared/production-rules.js';
import { sourceChapters } from '../shared/episode-plan.js';
import { digest, makeProject, now, sourceHash, composeStoryboard, composeImport, selectedArtifact, auditEpisode, type ProjectMode } from '../shared/model.js';
import { workflowsFor, workflowsForTask, getWorkflow, startWorkflow, controlWorkflow, authorizeWorkflow, bindWorkflowTask } from './agent-workflow.js';
import { agentTask, agentTasks, findAgentTask, createAgentTask, revokeAgentTask, pauseAgentTask, resumeAgentTask } from './agent-tasks.js';
import { agentReadiness, agentDashboard } from './agent-dashboard.js';
import { inspectVideo, mediaPath } from './media.js';
import { recoverDownloadedVideo, recoverRemoteVideo } from './jobs.js';
import {bundledAgentDirectory,bundledVersion} from './agent-package.js';
import { scriptReadiness } from '../shared/script-readiness.js';
import { agentModelRequests } from './agent-model-requests.js';

export const AGENT_ACTIONS = [
  'project.source', 'project.plan', 'project.planChapterGroups', 'project.createEpisodes', 'project.productionRules', 'project.style', 'project.aspectRatio',
  'episode.add', 'episode.addMany', 'episode.update', 'episode.confirmSource', 'episode.applyHighlightCandidate', 'episode.confirmHighlight',
  'episode.writeScript', 'episode.applyScriptCandidate', 'beat.add', 'beat.update', 'script.lock',
  'episode.segmentPlan', 'episode.applySegmentCandidate', 'episode.storyReview', 'episode.continuityReview',
  'asset.add', 'asset.update', 'asset.state', 'asset.imageReview', 'episode.applyAssetCandidate', 'episode.autoBindAssets',
  'segment.assets', 'segment.update', 'segment.mentionOnly', 'segment.writePrompt', 'segment.writeSubshots', 'segment.subshots.applyCandidate', 'segment.subshots.approve',
  'segment.effects', 'segment.select', 'segment.prompt.unselect', 'segment.prompt.archive',
  'segment.prompt.restore', 'episode.prompts.manage', 'segment.videoReview', 'audit.approve', 'episode.sampleApprove',
] as const;
const reviews = new Set(['episode.confirmSource', 'episode.confirmHighlight', 'script.lock', 'episode.storyReview',
  'episode.continuityReview', 'asset.imageReview', 'segment.subshots.approve', 'segment.videoReview', 'audit.approve', 'episode.sampleApprove']);
db.exec(`CREATE TABLE IF NOT EXISTS agent_receipts(project_id TEXT NOT NULL,request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,request_id));`);

export function agentManifest() {
  const root = process.cwd();
  return { application: 'wanling-manju', version: '0.4.0', softwareVersion:bundledVersion(root), resourcesVersion:bundledVersion(root), installationRoot: root, dataDirectory: dataDir,
    readiness: agentReadiness(),
    defaults: productionDefaults(), clients: ['codex', 'workbuddy', 'trae'],
    cli: path.join(root, 'scripts', 'agent-cli.mjs'), skill: path.join(bundledAgentDirectory(root),'SKILL.md'), tutorial:path.join(root,'dist-server/bundled/tutorials/getting-started.md'),
    actions: AGENT_ACTIONS, commands: ['action', 'start', 'continue', 'pause', 'cancel', 'inspect', 'recover', 'revoke'],
    contract: '完整原文→高光报告→锁定剧本→分镜→导入版→最终提示词；逐层核对，过载拆段；对白和OS使用角色原生声音。',
    authorization: '只保存用户明确授予的任务范围与额度；核验使用Agent身份；未知远端结果先恢复，不能自动重复付费。' };
}
export function agentContext(projectId: string, episodeId?: string) {
  const project = getProject(projectId);
  const episode = episodeId ? project.episodes.find(e => e.id === episodeId) : undefined;
  if (episodeId && !episode) throw Error('分集不存在');
  // A scoped view includes the complete source of this episode, not a summary.
  const view = episode ? { ...project, sourceCorpus: undefined, episodes: [episode] } : project;
  return { stateHash: digest(project), project: view, rules: productionRules(project.productionRules),
    connection: { installationRoot: process.cwd(), dataDirectory: dataDir, softwareVersion: bundledVersion() },
    scriptReadiness: view.episodes.map(scriptReadiness), modelRequests: agentModelRequests(projectId),
    chapters: !episode && project.sourceCorpus ? sourceChapters(project.sourceCorpus) : undefined,
    workflows: workflowsFor(projectId).filter(w => !episodeId || w.episodeId === episodeId),
    sourceHashes: Object.fromEntries(view.episodes.map(e => [e.id, sourceHash(e)])),
    layers: view.episodes.map(e => ({ episodeId: e.id, auditIssues: auditEpisode(e, project),
      segments: e.segments.map(s => ({ segmentId: s.id, storyboard: composeStoryboard(e, s),
        import: composeImport(e, s), prompt: selectedArtifact(s, 'prompt')?.content,
        videos: s.artifacts.filter(a => a.kind === 'video' && a.mediaPath).map(a => ({ artifactId: a.id, absolutePath: mediaPath(a.mediaPath!) })) })) })),
    tasks: agentTasks(projectId), jobs: jobsFor(projectId).filter(j => !episodeId || j.episode_id === episodeId),
    receipts: db.prepare('SELECT request_id,status,payload FROM agent_receipts WHERE project_id=? ORDER BY rowid DESC LIMIT 40').all(projectId),
    media: (project.assets || []).flatMap(a => a.images.map(i => ({ assetId: a.id, imageId: i.id, absolutePath: mediaPath(i.mediaPath) }))) };
}
export function createAgentProject(input: Record<string, unknown>) {
  const requestId = String(input.requestId || ''), inputHash = digest(input);
  if (!/^[-\w]{8,100}$/u.test(requestId)) throw Error('须提供稳定requestId，避免重复建项目');
  const receipt = db.prepare('SELECT input_hash,payload FROM agent_receipts WHERE project_id=? AND request_id=?').get('create', requestId);
  if (receipt) {
    if (receipt.input_hash !== inputHash) throw Error('同一创建请求内容已改变');
    return agentContext(JSON.parse(String(receipt.payload)).projectId);
  }
  const name = String(input.name || '').trim(), mode = (input.mode || 'standard') as ProjectMode;
  if (!name || name.length > 100 || !['standard', 'douyin-story'].includes(mode)) throw Error('项目名称或制作类型无效');
  const project = applyGlobalModels(makeProject(name, mode));
  project.productionRules = productionRules({ ...productionDefaults(), ...input.rules as object });
  insertProject(project, [], () => {
    db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?,?)').run('create', requestId, inputHash, 'completed', JSON.stringify({ projectId: project.id }));
  });
  return agentContext(project.id);
}

export { createAgentTask };
export async function agentTaskControl(projectId: string, taskId: string, input: Record<string, unknown>) {
  const requestId = String(input.requestId || ''), operation = String(input.operation || '');
  if (!/^[-\w]{8,100}$/u.test(requestId) || !['pause', 'resume', 'revoke'].includes(operation)) throw Error('任务操作或稳定requestId无效');
  const inputHash = digest({ ...input, taskId }), prior = db.prepare('SELECT * FROM agent_receipts WHERE project_id=? AND request_id=?').get(projectId, requestId);
  if (prior) {
    if (prior.input_hash !== inputHash) throw Error('同一任务控制请求内容不能改变');
    if (prior.status !== 'completed') throw Error('控制请求已尝试，请刷新任务面板核对当前状态');
    return { replayed: true, dashboard: agentDashboard(projectId) };
  }
  if (!findAgentTask(projectId, taskId)) throw Error('任务不存在');
  if (getProject(projectId).archivedAt) throw Error('项目已回收');
  db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?,?)').run(projectId, requestId, inputHash, 'running', JSON.stringify({ command: 'task-control', taskId, operation, startedAt: now() }));
  try {
    const task = operation === 'resume' ? resumeAgentTask(projectId, taskId) : operation === 'revoke' ? revokeAgentTask(projectId, taskId) : pauseAgentTask(projectId, taskId);
    for (const flow of workflowsForTask(projectId, taskId).filter(w => !['completed', 'cancelled'].includes(w.status))) {
      if (operation === 'resume' && flow.status !== 'paused') continue;
      await controlWorkflow(projectId, flow.id, operation === 'revoke' ? 'cancel' : operation === 'resume' ? 'resume' : 'pause');
    }
    db.prepare('UPDATE agent_receipts SET status=?,payload=? WHERE project_id=? AND request_id=?').run('completed', JSON.stringify({ command: 'task-control', operation, task, completedAt: now() }), projectId, requestId);
    return { dashboard: agentDashboard(projectId) };
  } catch (error) {
    db.prepare('UPDATE agent_receipts SET status=?,payload=? WHERE project_id=? AND request_id=?').run('failed', JSON.stringify({ command: 'task-control', taskId, operation, error: (error as Error).message }), projectId, requestId);
    throw error;
  }
}
export async function agentCommand(projectId: string, input: Record<string, unknown>) {
  const command = String(input.command || ''), requestId = String(input.requestId || '');
  if (!/^[-\w]{8,100}$/u.test(requestId)) throw Error('须提供稳定requestId');
  const inputHash = digest(input), prior = db.prepare('SELECT * FROM agent_receipts WHERE project_id=? AND request_id=?').get(projectId, requestId);
  if (prior) {
    if (prior.input_hash !== inputHash) throw Error('同一请求内容不能改变');
    if (prior.status !== 'completed') throw Error('该请求已尝试或结果未知，请查看原记录，不能自动重复执行');
    return { replayed: true, result: JSON.parse(String(prior.payload)).result, context: agentContext(projectId, input.episodeId as string | undefined) };
  }
  const project = getProject(projectId);
  if (project.archivedAt) throw Error('项目已回收');
  if (input.expectedHash !== digest(project)) throw Error('项目状态已变化，请先读取最新agent_context');
  const episodeId = typeof input.episodeId === 'string' ? input.episodeId : undefined;
  const taskId = String(input.taskId || '');
  let review: Record<string, unknown> | undefined;
  if (command === 'action') {
    const action = input.action as Record<string, unknown> | undefined;
    if (!action || !AGENT_ACTIONS.includes(action.type as typeof AGENT_ACTIONS[number])) throw Error('Agent操作未开放');
    if (taskId) agentTask(projectId, taskId);
    if (action.episodeId && taskId) agentTask(projectId, taskId, String(action.episodeId));
    if (reviews.has(String(action.type))) {
      const task = agentTask(projectId, taskId, action.episodeId as string | undefined);
      review = input.review as Record<string, unknown> | undefined;
      if (!review || typeof review.notes !== 'string' || review.notes.trim().length < 12 || review.notes.length > 4000 ||
          review.stateHash !== input.expectedHash) throw Error('须提供对应当前版本的Agent核验记录与具体依据');
      if (action.type === 'episode.confirmSource') {
        const episode = project.episodes.find(e => e.id === action.episodeId);
        if (!episode || review.sourceHash !== sourceHash(episode) || review.readStart !== 0 || review.readEnd !== episode.sourceText.length)
          throw Error('原文阅读证据须覆盖本集完整原文并匹配当前哈希');
      }
      review = { ...review, reviewerKind: 'agent', reviewer: task.agent, taskId, reviewedAt: now() };
    }
    if (['project.style', 'project.aspectRatio', 'asset.update', 'asset.state'].includes(String(action.type)) &&
        jobsFor(projectId).some(j => ['queued', 'running', 'paused'].includes(j.status))) throw Error('项目尚有活动任务，请先处理后再修改生成输入');
  } else if (!['start', 'continue', 'pause', 'cancel', 'inspect', 'recover', 'revoke'].includes(command)) throw Error('未知Agent命令');
  // Reserve even local mutations so a dropped response cannot double-apply them.
  db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?,?)').run(projectId, requestId, inputHash, 'running', JSON.stringify({ command, review, startedAt: now() }));
  try {
    let result: unknown;
    if (command === 'action') {
      updateProject(projectId, current => {
        if (digest(current) !== input.expectedHash) throw Error('输入已变化');
        applyAction(current, input.action as { type: string });
      });
      result = { applied: (input.action as { type: string }).type, review };
    } else if (command === 'start') {
      if (!episodeId) throw Error('须指定分集');
      const task = agentTask(projectId, taskId, episodeId);
      result = startWorkflow(projectId, { episodeId, taskId, limits: task.limits, delivery: task.delivery });
    } else if (['continue', 'pause', 'cancel'].includes(command)) {
      const workflowId = String(input.workflowId || '');
      const flow = getWorkflow(projectId, workflowId);
      if (command !== 'continue') result = await controlWorkflow(projectId, workflowId, command);
      else {
      const task = agentTask(projectId, taskId, flow.episodeId);
      const bound = bindWorkflowTask(projectId, workflowId, taskId);
      if (bound.status === 'waiting_budget') result = await authorizeWorkflow(projectId, workflowId,
        { hash: bound.step.hash, confirmed: true, acceptUnknownCost: task.acceptUnknownCost }, taskId);
      else if (['running', 'completed', 'cancelled'].includes(bound.status)) result = bound;
      else result = await controlWorkflow(projectId, workflowId, 'resume');
      }
    } else if (command === 'inspect') {
      agentTask(projectId, taskId, episodeId);
      const artifact = project.episodes.find(e => e.id === episodeId)?.segments.find(s => s.id === input.segmentId)?.artifacts.find(a => a.id === input.artifactId && a.kind === 'video');
      if (!artifact?.mediaPath) throw Error('视频不存在');
      const technical = await inspectVideo(mediaPath(artifact.mediaPath));
      updateProject(projectId, current => {
        if (digest(current) !== input.expectedHash) throw Error('检查期间输入变化');
        const target = current.episodes.find(e => e.id === episodeId)!.segments.find(s => s.id === input.segmentId)!.artifacts.find(a => a.id === input.artifactId)!;
        target.technical = technical; target.review = undefined;
      }); result = technical;
    } else if (command === 'recover') {
      const job = jobsFor(projectId).find(j => j.id === input.jobId);
      if (!job) throw Error('任务不存在');
      agentTask(projectId, taskId, job.episode_id);
      result = input.remote === true ? await recoverRemoteVideo(projectId, job.id) : await recoverDownloadedVideo(projectId, job.id);
    } else {
      result = revokeAgentTask(projectId, taskId);
      for (const flow of workflowsForTask(projectId, taskId).filter(w => !['completed', 'cancelled'].includes(w.status))) await controlWorkflow(projectId, flow.id, 'cancel');
    }
    const record = { command, result, review, completedAt: now() };
    db.prepare('UPDATE agent_receipts SET status=?,payload=? WHERE project_id=? AND request_id=?').run('completed', JSON.stringify(record), projectId, requestId);
    return { result, context: agentContext(projectId, episodeId) };
  } catch (error) {
    db.prepare('UPDATE agent_receipts SET status=?,payload=? WHERE project_id=? AND request_id=?').run('failed', JSON.stringify({ command, review, error: (error as Error).message, failedAt: now() }), projectId, requestId);
    throw error;
  }
}
