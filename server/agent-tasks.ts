import { db, getProject } from './store.js';
import { digest, id, now, type ModelKind, type Project } from '../shared/model.js';
import { productionRules } from '../shared/production-rules.js';
import type { AgentTask, AgentTaskStatus } from '../shared/agent-task.js';
export type { AgentTask } from '../shared/agent-task.js';
db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(project_id,request_id));`);

function configuration(project: Project) {
  return digest({ models: [project.textModel, project.imageModel, project.videoModel],
    style: project.visualStyle, aspectRatio: project.aspectRatio, rules: project.productionRules });
}
export function agentTasks(projectId: string): AgentTask[] {
  getProject(projectId);
  return db.prepare('SELECT payload FROM agent_tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 100').all(projectId)
    .map(row => JSON.parse(String(row.payload)));
}
// The bounded list is a display window, never an authority lookup.
export function findAgentTask(projectId: string, taskId: string): AgentTask | undefined {
  getProject(projectId);
  const row = db.prepare('SELECT payload FROM agent_tasks WHERE project_id=? AND id=?').get(projectId, taskId);
  return row ? JSON.parse(String(row.payload)) : undefined;
}
export function agentTaskStatus(task: AgentTask, project: Project): AgentTaskStatus {
  if (task.revokedAt) return 'revoked';
  if (Date.parse(task.expiresAt) <= Date.now()) return 'expired';
  if (task.configurationHash !== configuration(project)) return 'configuration_changed';
  return task.pausedAt ? 'paused' : 'active';
}
export function agentTask(projectId: string, taskId: string, episodeId?: string, allowPaused = false) {
  const task = findAgentTask(projectId, taskId);
  if (!task || task.revokedAt || Date.parse(task.expiresAt) <= Date.now()) throw Error('任务授权不存在、已撤回或已到期');
  if (episodeId && !task.episodeIds.includes(episodeId)) throw Error('本集不在任务授权范围内');
  if (task.configurationHash !== configuration(getProject(projectId))) throw Error('模型、画风或制作规则已变化，请重新确认任务授权');
  if (task.pausedAt && !allowPaused) throw Error('任务已暂停，请在软件任务面板恢复；暂停期间不能提交生成或核验');
  return task;
}
export function pauseAgentTask(projectId: string, taskId: string) {
  const task = findAgentTask(projectId, taskId);
  if (!task) throw Error('任务不存在');
  task.pausedAt ??= now();
  db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
  return task;
}
export function resumeAgentTask(projectId: string, taskId: string) {
  const task = agentTask(projectId, taskId, undefined, true);
  delete task.pausedAt;
  db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
  return task;
}
export function createAgentTask(projectId: string, input: Record<string, unknown>) {
  const project = getProject(projectId), requestId = String(input.requestId || '');
  if (!/^[-\w]{8,100}$/u.test(requestId)) throw Error('须提供稳定的任务requestId');
  const inputHash = digest(input), row = db.prepare('SELECT payload FROM agent_tasks WHERE project_id=? AND request_id=?').get(projectId, requestId);
  const existing: AgentTask | undefined = row ? JSON.parse(String(row.payload)) : undefined;
  if (existing) {
    if (existing.inputHash !== inputHash) throw Error('同一requestId的授权内容不能改变');
    return existing;
  }
  const statement = String(input.statement || '').trim(), agent = String(input.agent || '').trim();
  if (input.confirmed !== true || statement.length < 8 || statement.length > 2000 || !agent || agent.length > 80)
    throw Error('须记录用户明确的任务授权原话及接手Agent名称');
  const episodeIds = Array.isArray(input.episodeIds) ? input.episodeIds.map(String) : [];
  if (!episodeIds.length || new Set(episodeIds).size !== episodeIds.length ||
      episodeIds.some(e => !project.episodes.some(ep => ep.id === e))) throw Error('须指定已有分集，不能授权不存在的集数');
  const delivery = input.delivery ?? productionRules(project.productionRules).delivery;
  if (delivery !== 'package' && delivery !== 'video') throw Error('交付类型无效');
  const limits = { text: 0, image: 0, video: 0 };
  for (const kind of ['text', 'image', 'video'] as const) {
    const value = Number((input.limits as Record<string, unknown> | undefined)?.[kind] ?? 0);
    if (!Number.isInteger(value) || value < 0 || value > 200) throw Error('本次提交次数上限须为0–200的整数');
    limits[kind] = value;
  }
  if (delivery === 'package' && limits.video) throw Error('生产包任务不包含视频生成额度');
  const maxAmount = input.maxAmount === undefined ? undefined : Number(input.maxAmount);
  if (maxAmount !== undefined && (!Number.isFinite(maxAmount) || maxAmount <= 0 || !String(input.currency || '').trim()))
    throw Error('金额上限须为正数并注明币种或额度单位');
  const task: AgentTask = { id: id(), projectId, requestId, inputHash, statement, agent, episodeIds, delivery,
    allowGeneration: input.allowGeneration === true, acceptUnknownCost: input.acceptUnknownCost === true,
    limits, used: { text: 0, image: 0, video: 0 }, maxAmount, currency: maxAmount === undefined ? undefined : String(input.currency),
    reservedAmount: 0, configurationHash: configuration(project), createdAt: now(),
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() };
  db.prepare('INSERT INTO agent_tasks VALUES(?,?,?,?)').run(task.id, projectId, requestId, JSON.stringify(task));
  return task;
}
export function revokeAgentTask(projectId: string, taskId: string) {
  const task = findAgentTask(projectId, taskId);
  if (!task) throw Error('任务不存在');
  task.revokedAt ??= now();
  db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
  return task;
}

// Reserve before any external submission. Unknown outcomes remain reserved;
// reusing a task or restarting the app never resets its counters.
export function reserveAgentSubmission(projectId: string, taskId: string, episodeId: string,
  kind: ModelKind, count: number, quote?: { known: boolean; maximum: number; currency: string }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const task = agentTask(projectId, taskId, episodeId);
    if (!task.allowGeneration || (kind === 'video' && task.delivery !== 'video')) throw Error('本次任务未授权此类生成');
    if (task.used[kind] + count > task.limits[kind]) throw Error('本次任务提交额度已用尽，未提交生成');
    if (task.maxAmount !== undefined) {
      if (!quote?.known || quote.currency !== task.currency) throw Error('无法确认本步费用在金额上限内，未提交生成');
      if (task.reservedAmount + quote.maximum > task.maxAmount) throw Error('本步超过任务金额上限，未提交生成');
      task.reservedAmount += quote.maximum;
    } else if (!quote?.known && !task.acceptUnknownCost) throw Error('费用未知，本次授权未接受未知费用，未提交生成');
    task.used[kind] += count;
    db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
    db.exec('COMMIT');
    return task;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
