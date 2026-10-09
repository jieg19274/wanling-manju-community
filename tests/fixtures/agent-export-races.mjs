import { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manju-export-races-'));
Object.assign(process.env, { MANJU_DATA_DIR: path.join(dir, 'data'), MANJU_BACKUP_DIR: path.join(dir, 'backups'), MANJU_JIANYING_DRAFTS_DIR: path.join(dir, 'drafts') });
await import('../network-guard.mjs');
const real = await import('../../dist-server/server/export.js');
let holdAt, arrived, release, draftFails;
const checkpoint = async at => { if (holdAt === at) { arrived(); await new Promise(r => { release = r; }); } };
mock.module(new URL('../../dist-server/server/export.js', import.meta.url).href, { namedExports: { ...real,
  preflightEpisode: async () => { await checkpoint('preflight'); return { issues: [] }; },
  exportEpisodeMp4: async () => { await checkpoint('mp4'); return { path: 'isolated-local-result.mp4' }; },
  exportEpisode: async () => { await checkpoint('draft'); if (draftFails) throw Error('本地草稿模拟失败'); return { draftPath: 'isolated-draft' }; }
} });
const { makeProject, makeEpisode, id, now } = await import('../../dist-server/shared/model.js');
const { db, insertProject } = await import('../../dist-server/server/store.js');
const { createAgentTask, agentTask } = await import('../../dist-server/server/agent-tasks.js');
const { getWorkflow, bindWorkflowTask, controlWorkflow } = await import('../../dist-server/server/agent-workflow.js');
const { agentTaskControl } = await import('../../dist-server/server/agent-api.js');
const passed = [];
for (const [name, phase, op, fails] of [
  ['rebind-during-preflight', 'preflight', 'rebind', false],
  ['pause-during-mp4', 'mp4', 'pause', false],
  ['revoke-during-draft', 'draft', 'revoke', false],
  ['cancel-during-preflight', 'preflight', 'cancel', false],
  ['draft-failure-after-rebind', 'draft', 'rebind', true]
]) {
  holdAt = phase; draftFails = fails;
  const marker = new Promise(r => { arrived = r; });
  const p = makeProject('隔离导出回归', 'standard'), e = makeEpisode(1, '本地模拟'); p.episodes = [e]; insertProject(p);
  const grant = { agent: 'offline-export', statement: '本地模拟导出测试，无模型提交、无真实文件导出。', confirmed: true, episodeIds: [e.id], delivery: 'video' };
  const a = createAgentTask(p.id, { ...grant, requestId: id() }), b = createAgentTask(p.id, { ...grant, requestId: id() });
  // Seed the already-authorized export step; the production callback itself
  // runs unchanged. Only local I/O is mocked, including its async boundaries.
  const flow = { id: id(), projectId: p.id, episodeId: e.id, taskId: a.id, delivery: 'video', status: 'waiting_budget',
    createdAt: now(), updatedAt: now(), limits: { text: 0, image: 0, video: 0 }, used: { text: 0, image: 0, video: 0 }, history: [],
    step: { kind: 'export', key: 'test-export', task: undefined, label: '本地导出', message: '', tab: 'export', submissions: 0, hash: 'placeholder' } };
  // authorizeWorkflow computes its real next-step contract, so use the
  // already-reserved execution entry through a source-identical fixture copy.
  const source = fs.readFileSync(new URL('../../dist-server/server/agent-workflow.js', import.meta.url), 'utf8');
  const moduleFile = path.join(dir, `workflow-${flow.id}.mjs`);
  const serverRoot = new URL('../../dist-server/server/', import.meta.url);
  const text = source.replace(/from '([^']+)'/g, (all, spec) => spec.startsWith('.') ? `from '${new URL(spec, serverRoot).href}'` : all) + '\nexport { execute as executeFixture };\n';
  fs.writeFileSync(moduleFile, text);
  const { executeFixture } = await import((await import('node:url')).pathToFileURL(moduleFile).href);
  flow.history.push({ key: flow.step.key, label: flow.step.label, at: now(), kind: 'export', status: 'running', submissions: 0, taskId: a.id });
  flow.status = 'running'; db.prepare('INSERT INTO agent_workflows VALUES(?,?,?,?,?)').run(flow.id, p.id, e.id, JSON.stringify(flow), flow.createdAt);
  const running = executeFixture(flow); await marker;
  bindWorkflowTask(p.id, flow.id, b.id);
  if (op === 'pause' || op === 'revoke') await agentTaskControl(p.id, b.id, { requestId: id(), operation: op });
  if (op === 'cancel') await controlWorkflow(p.id, flow.id, 'cancel');
  release(); await running;
  const saved = getWorkflow(p.id, flow.id);
  assert.equal(saved.taskId, b.id); assert.equal(saved.history[0].taskId, a.id); assert.equal(saved.history[0].status, 'completed');
  assert.equal(saved.status, op === 'pause' ? 'paused' : ['revoke', 'cancel'].includes(op) ? 'cancelled' : 'completed');
  assert.equal(saved.exportResult.mp4.path, 'isolated-local-result.mp4');
  if (fails) assert.match(saved.exportResult.draftError, /模拟失败/); else assert.equal(saved.exportResult.draftPath, 'isolated-draft');
  assert.equal(agentTask(p.id, a.id).used.video, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM adapter_tasks').get().n, 0); passed.push(name);
}
console.log(JSON.stringify({ passed })); db.close(); mock.restoreAll();
