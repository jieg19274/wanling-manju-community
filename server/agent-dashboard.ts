import { existsSync } from 'node:fs';
import path from 'node:path';
import { db, getProject } from './store.js';
import { directStatus, globalModels } from './direct-provider.js';
import { runtimePreflight } from './maintenance.js';
import { productionDefaults } from './production-defaults.js';
import { agentTasks, agentTaskStatus } from './agent-tasks.js';
import { workflowsFor } from './agent-workflow.js';
import { productionRules } from '../shared/production-rules.js';
import { digest, modelSegmentDuration, type ScriptBeat } from '../shared/model.js';
import type { AgentDashboard, AgentReadiness } from '../shared/agent-dashboard.js';
import { scriptReadiness } from '../shared/script-readiness.js';
import { agentModelRequests } from './agent-model-requests.js';

let runtime: { at: number; ready: boolean } | undefined;
export function agentReadiness(projectId?: string): AgentReadiness {
  const project = projectId ? getProject(projectId) : undefined;
  const defaults = globalModels();
  const models = project ? { text: project.textModel, image: project.imageModel, video: project.videoModel } : defaults;
  const provider = directStatus(), checks: AgentReadiness['checks'] = [];
  checks.push({ key: 'software', label: '软件连接', ready: true, message: '已连接本机万灵漫剧。' });
  if (project) checks.push({ key: 'source', label: '原文章节', ready: Boolean(project.sourceCorpus?.trim() || project.episodes.some(e => e.sourceText.trim().length >= 50)),
    message: project.archivedAt ? '项目已回收，须先恢复。' : '导入完整原文后，Agent 按项目规则制作。' });
  for (const kind of ['text', 'image', 'video'] as const) {
    const model = models[kind], direct = /direct-(text|image|video)\.mjs$/u.test(model?.adapterPath || '');
    const ready = Boolean(model?.modelId && model.adapterPath && existsSync(path.resolve(model.adapterPath)) && (!direct || provider.hasKey));
    const sameDefault = model?.modelId === defaults[kind].modelId && model?.adapterPath === defaults[kind].adapterPath;
    const scope = project ? '本项目实际使用' : '新项目默认';
    const state = ready ? '本机配置已就绪。' : direct && !provider.hasKey ? '请在软件设置中填写模型密钥。' : '请在项目模型设置中选择模型并确认适配器路径。';
    checks.push({ key: kind, label: ({ text: '文本模型', image: '图片模型', video: '视频模型' })[kind], ready,
      message: `${scope}：${model?.modelId || '尚未选择'}。${state}${project && !sameDefault ? `新项目默认为 ${defaults[kind].modelId}，本项目尚未切换。` : ''}`,
      modelId: model?.modelId, modelHash: digest(model ?? null), defaultModelId: defaults[kind].modelId, defaultModelHash: digest(defaults[kind]),
      canUseDefault: Boolean(project && !project.archivedAt && !sameDefault && provider.hasKey && existsSync(defaults[kind].adapterPath)) });
  }
  let durationReady = false;
  try { if (models.video) durationReady = modelSegmentDuration({} as ScriptBeat, models.video) === 30; } catch { /* Report the capability mismatch without submitting anything. */ }
  checks.push({ key: 'duration', label: '30秒片段', ready: durationReady, message: durationReady ? '所选模型的本机时长配置符合30秒规则。' : '所选视频模型不支持30秒或尚未配置，请更换模型。' });
  if (!runtime || Date.now() - runtime.at > 60_000) runtime = { at: Date.now(), ready: runtimePreflight().ready };
  checks.push({ key: 'runtime', label: '视频合成工具', ready: runtime.ready, message: runtime.ready ? 'FFmpeg 与 FFprobe 可用。' : '成片检查与合成需要 FFmpeg 和 FFprobe。' });
  const required = new Set(['text', 'image', ...(models.video ? ['duration'] : []), ...(productionRules(project?.productionRules || productionDefaults()).delivery === 'video' ? ['video', 'duration', 'runtime'] : [])]);
  return { ...(project ? { projectId: project.id } : {}), checks, draftReady: !project?.archivedAt,
    generationReady: !project?.archivedAt && checks.filter(c => required.has(c.key) || c.key === 'source').every(c => c.ready),
    missing: checks.filter(c => !c.ready && (required.has(c.key) || c.key === 'source')).map(c => c.label),
    note: '这是本机配置检查，未调用收费模型。提交前仍须核验本次任务额度、费用与实际模型能力。' };
}
export function agentDashboard(projectId: string): AgentDashboard {
  const project = getProject(projectId), flows = workflowsFor(projectId);
  const episode = (id: string) => project.episodes.find(e => e.id === id);
  const deliverables: AgentDashboard['deliverables'] = [];
  for (const flow of flows) {
    const result = flow.exportResult as { package?: { folder?: string }; mp4?: { filePath?: string; url?: string }; draftDir?: string } | undefined;
    for (const [kind, file, url] of [ ['package', result?.package?.folder], ['mp4', result?.mp4?.filePath, result?.mp4?.url], ['draft', result?.draftDir] ] as const) {
      if (!file) continue;
      deliverables.push({ workflowId: flow.id, episodeId: flow.episodeId, episodeNumber: episode(flow.episodeId)?.number || 0,
        kind, path: file, available: existsSync(file), ...(url?.startsWith('/media/') ? { url } : {}) });
    }
  }
  const reviews: AgentDashboard['reviews'] = [];
  for (const row of db.prepare('SELECT request_id,status,payload FROM agent_receipts WHERE project_id=? ORDER BY rowid DESC LIMIT 100').all(projectId)) {
    const payload = JSON.parse(String(row.payload)), review = payload.review;
    if (review?.reviewerKind !== 'agent') continue;
    reviews.push({ requestId: String(row.request_id), status: String(row.status), reviewer: String(review.reviewer), notes: String(review.notes).slice(0, 1000),
      at: String(review.reviewedAt), taskId: review.taskId, action: payload.result?.applied });
    if (reviews.length === 20) break;
  }
  return { projectId, projectName: project.name, archived: Boolean(project.archivedAt), rules: productionRules(project.productionRules), readiness: agentReadiness(projectId),
    scriptRecovery: project.episodes.map(scriptReadiness).filter(e => e.hasExistingScript && e.state !== 'locked'),
    modelRequests: agentModelRequests(projectId),
    tasks: agentTasks(projectId).map(task => ({ ...task, status: agentTaskStatus(task, project),
      remaining: { text: Math.max(0, task.limits.text - task.used.text), image: Math.max(0, task.limits.image - task.used.image), video: Math.max(0, task.limits.video - task.used.video) },
      episodes: task.episodeIds.map(id => ({ id, number: episode(id)?.number || 0, title: episode(id)?.title || '分集已不存在' })) })),
    workflows: flows.map(flow => ({ id: flow.id, taskId: flow.taskId, episodeId: flow.episodeId, episodeNumber: episode(flow.episodeId)?.number || 0,
      status: flow.status, step: { label: flow.step.label, message: flow.step.message, tab: flow.step.tab, segmentId: flow.step.segmentId, model: flow.step.model }, error: flow.error,
      lastAttempt: [...flow.history].reverse().find(h => ['text','image','video'].includes(h.kind)),
      completedSteps: flow.history.filter(h => h.status === 'completed').length, updatedAt: flow.updatedAt })), deliverables, reviews };
}
