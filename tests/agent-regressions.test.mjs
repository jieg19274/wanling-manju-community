import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'manju-agent-regressions-'));
Object.assign(process.env, { MANJU_DATA_DIR: path.join(folder, 'data'), MANJU_BACKUP_DIR: path.join(folder, 'backups'),
  MANJU_JIANYING_DRAFTS_DIR: path.join(folder, 'drafts'), MANJU_DIRECT_API_BASE_URL: 'http://127.0.0.1:1' });
await import('./network-guard.mjs');
const { createAgentProject, agentCommand, agentContext, agentTaskControl } = await import('../dist-server/server/agent-api.js');
const { createAgentTask, agentTask, agentTasks, pauseAgentTask, resumeAgentTask, revokeAgentTask, reserveAgentSubmission } = await import('../dist-server/server/agent-tasks.js');
const { startWorkflow, getWorkflow, workflowsFor, workflowsForTask, controlWorkflow, advanceWorkflow } = await import('../dist-server/server/agent-workflow.js');
const { updateProject, db } = await import('../dist-server/server/store.js');
const { applyAction } = await import('../dist-server/server/actions.js');
after(() => db.close());
let serial = 0;
const requestId = () => `regression-request-${++serial}`;
const wait = async predicate => {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('本地模拟执行未到达检查点');
};
function setup(t, { delayed = false, fails = false } = {}) {
  const project = createAgentProject({ requestId: requestId(), name: '隔离 Agent 回归', mode: 'douyin-story' }).project;
  const act = action => updateProject(project.id, p => applyAction(p, action));
  const dir = path.join(folder, project.id); fs.mkdirSync(dir);
  const marker = path.join(dir, 'started'), release = path.join(dir, 'release'), adapter = path.join(dir, 'text.mjs');
  fs.writeFileSync(adapter, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');` +
    (delayed ? `while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));` : '') +
    (fails ? `throw Error('本地模拟失败');` : `await import(${JSON.stringify(pathToFileURL(path.join(root, 'tests/fixtures/text-adapter.mjs')).href)});`));
  act({ type: 'project.model', kind: 'text', modelId: 'fixture.local', name: '本地模拟', adapterPath: adapter });
  act({ type: 'episode.add' });
  const episode = agentContext(project.id).project.episodes[0];
  act({ type: 'episode.update', episodeId: episode.id,
    sourceText: '林舟听到敲门声，开门看见同伴。他问清来意，同伴点头，他让她进屋并关门。'.repeat(5) });
  act({ type: 'episode.confirmSource', episodeId: episode.id });
  const grant = { agent: 'offline-regression', statement: '只在隔离目录使用本地模拟验证 Agent，不调用付费模型。', confirmed: true,
    episodeIds: [episode.id], delivery: 'package', allowGeneration: true, acceptUnknownCost: true, limits: { text: 2 } };
  let flowId;
  t.after(async () => {
    fs.writeFileSync(release, 'release');
    if (flowId) await wait(() => getWorkflow(project.id, flowId).history.every(h => h.status !== 'running'));
  });
  return { project, episode, act, grant, marker, release,
    task: () => createAgentTask(project.id, { ...grant, requestId: requestId() }),
    command: fields => agentCommand(project.id, { requestId: requestId(), expectedHash: agentContext(project.id).stateHash, ...fields }),
    input: fields => ({ requestId: requestId(), expectedHash: agentContext(project.id).stateHash, ...fields }),
    setFlow: id => { flowId = id; } };
}

test('requestId 重放返回同形结果和最新 context，不重复提交或占用额度', async t => {
  const h = setup(t, { delayed: true }), task = h.task();
  const input = h.input({ command: 'start', episodeId: h.episode.id, taskId: task.id });
  const first = await agentCommand(h.project.id, input); h.setFlow(first.result.id);
  const replay = await agentCommand(h.project.id, input);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first.result); assert.equal(replay.result.id, first.result.id);
  const submit = h.input({ command: 'continue', workflowId: first.result.id, taskId: task.id });
  const submitted = await agentCommand(h.project.id, submit);
  // Compare the HTTP/receipt JSON contract (undefined fields are not sent).
  const submittedResult = JSON.parse(JSON.stringify(submitted.result));
  assert.deepEqual((await agentCommand(h.project.id, submit)).result, submittedResult);
  await wait(() => fs.existsSync(h.marker)); fs.writeFileSync(h.release, 'complete');
  await wait(() => getWorkflow(h.project.id, first.result.id).history[0].status === 'completed');
  updateProject(h.project.id, p => { p.name = '更新后的 context'; });
  const completedReplay = await agentCommand(h.project.id, submit);
  assert.deepEqual(completedReplay.result, submittedResult);
  assert.equal(completedReplay.context.stateHash, agentContext(h.project.id).stateHash);
  assert.equal(completedReplay.context.project.name, '更新后的 context');
  assert.equal(agentTask(h.project.id, task.id).used.text, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM adapter_tasks WHERE project_id=?').get(h.project.id).n, 1);
  await assert.rejects(agentCommand(h.project.id, { ...submit, command: 'cancel' }), /同一请求内容不能改变/);
});

test('延迟模型执行中绑定 B，结果完成仍保留 B，暂停 B 能控制原工作流', async t => {
  const h = setup(t, { delayed: true }), a = h.task(), b = h.task();
  const flow = (await h.command({ command: 'start', episodeId: h.episode.id, taskId: a.id })).result; h.setFlow(flow.id);
  await h.command({ command: 'continue', workflowId: flow.id, taskId: a.id });
  await wait(() => fs.existsSync(h.marker));
  const bound = await h.command({ command: 'continue', workflowId: flow.id, taskId: b.id });
  assert.equal(bound.result.taskId, b.id); assert.equal(getWorkflow(h.project.id, flow.id).taskId, b.id);
  fs.writeFileSync(h.release, 'complete');
  await wait(() => getWorkflow(h.project.id, flow.id).history[0].status === 'completed');
  const complete = getWorkflow(h.project.id, flow.id);
  assert.equal(complete.taskId, b.id); assert.equal(complete.status, 'waiting_review');
  assert.equal(complete.history[0].taskId, a.id); assert.equal(complete.used.text, 1);
  assert.equal(agentTask(h.project.id, a.id).used.text, 1); assert.equal(agentTask(h.project.id, b.id).used.text, 0);
  await agentTaskControl(h.project.id, b.id, { requestId: requestId(), operation: 'pause' });
  assert.equal(getWorkflow(h.project.id, flow.id).status, 'paused');
});

for (const operation of ['pause', 'revoke', 'cancel']) for (const fails of [false, true]) {
  test(`执行期间${operation}，异步${fails ? '失败' : '成功'}不恢复控制状态或重复提交`, async t => {
    const h = setup(t, { delayed: true, fails }), a = h.task(), b = h.task();
    const flow = (await h.command({ command: 'start', episodeId: h.episode.id, taskId: a.id })).result; h.setFlow(flow.id);
    await h.command({ command: 'continue', workflowId: flow.id, taskId: a.id }); await wait(() => fs.existsSync(h.marker));
    await h.command({ command: 'continue', workflowId: flow.id, taskId: b.id });
    if (operation === 'cancel') await h.command({ command: 'cancel', workflowId: flow.id });
    else await agentTaskControl(h.project.id, b.id, { requestId: requestId(), operation });
    fs.writeFileSync(h.release, 'complete');
    await wait(() => getWorkflow(h.project.id, flow.id).history[0].status === (fails ? 'failed' : 'completed'));
    await advanceWorkflow(h.project.id, flow.id);
    const final = getWorkflow(h.project.id, flow.id);
    assert.equal(final.taskId, b.id); assert.equal(final.status, operation === 'pause' ? 'paused' : 'cancelled');
    assert.equal(final.history.length, 1); assert.equal(final.history[0].taskId, a.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM adapter_tasks WHERE project_id=?').get(h.project.id).n, 1);
    assert.equal(agentTask(h.project.id, a.id).used.text, 1);
  });
}

test('超过100条任务：旧授权查询、额度、控制、requestId 幂等和项目隔离仍有效', async t => {
  const h = setup(t), input = { ...h.grant, requestId: requestId() }, oldest = createAgentTask(h.project.id, input);
  for (let i = 0; i < 105; i++) h.task();
  assert.equal(agentTasks(h.project.id).length, 100); assert.ok(!agentTasks(h.project.id).some(v => v.id === oldest.id));
  assert.equal(agentTask(h.project.id, oldest.id).id, oldest.id);
  assert.equal(createAgentTask(h.project.id, input).id, oldest.id);
  assert.throws(() => createAgentTask(h.project.id, { ...input, limits: { text: 3 } }), /授权内容不能改变/);
  reserveAgentSubmission(h.project.id, oldest.id, h.episode.id, 'text', 1);
  pauseAgentTask(h.project.id, oldest.id); assert.throws(() => agentTask(h.project.id, oldest.id), /暂停/);
  await agentTaskControl(h.project.id, oldest.id, { requestId: requestId(), operation: 'resume' });
  assert.equal(agentTask(h.project.id, oldest.id).used.text, 1);
  await agentTaskControl(h.project.id, oldest.id, { requestId: requestId(), operation: 'pause' });
  resumeAgentTask(h.project.id, oldest.id); const revoked = revokeAgentTask(h.project.id, oldest.id);
  assert.throws(() => agentTask(h.project.id, oldest.id), /撤回/);
  assert.equal(createAgentTask(h.project.id, input).revokedAt, revoked.revokedAt);
  const foreign = setup(t); assert.throws(() => pauseAgentTask(foreign.project.id, oldest.id), /不存在/);
});

test('超过100条工作流：旧流程查询、启动复用、continue、共享任务暂停和撤回不漏记录', async t => {
  const h = setup(t), task = h.task();
  const old = startWorkflow(h.project.id, { episodeId: h.episode.id, taskId: task.id, delivery: 'package' });
  // Multiple episodes may share one grant. Seed display history without paid work.
  for (let i = 0; i < 105; i++) {
    const flow = { ...structuredClone(old), id: `old-flow-${i}`, episodeId: `other-episode-${i}`,
      createdAt: '2099-01-01T00:00:00.000Z', taskId: task.id, status: 'waiting_review' };
    if (i === 0) { delete flow.taskId; flow.history = [{ key: 'legacy', at: '2020-01-01', taskId: task.id, status: 'completed', kind: 'text', label: '旧回执', submissions: 1 }]; }
    db.prepare('INSERT INTO agent_workflows VALUES(?,?,?,?,?)').run(flow.id, h.project.id, flow.episodeId, JSON.stringify(flow), flow.createdAt);
  }
  assert.equal(workflowsFor(h.project.id).length, 100); assert.ok(!workflowsFor(h.project.id).some(v => v.id === old.id));
  assert.equal(getWorkflow(h.project.id, old.id).id, old.id);
  assert.equal(startWorkflow(h.project.id, { episodeId: h.episode.id, taskId: task.id, delivery: 'package' }).id, old.id);
  const bound = await h.command({ command: 'continue', workflowId: old.id, taskId: task.id });
  h.setFlow(old.id); assert.equal(bound.result.id, old.id);
  await wait(() => getWorkflow(h.project.id, old.id).history[0]?.status === 'completed');
  await controlWorkflow(h.project.id, old.id, 'pause');
  assert.equal(workflowsForTask(h.project.id, task.id).length, 106);
  assert.ok(workflowsForTask(h.project.id, task.id).every(v => v.status === 'paused'));
  const newTask = h.task(); await assert.rejects(h.command({ command: 'continue', workflowId: old.id, taskId: newTask.id }), /绕过暂停/);
  await h.command({ command: 'revoke', taskId: task.id });
  assert.ok(workflowsForTask(h.project.id, task.id).every(v => v.status === 'cancelled'));
  const foreign = setup(t); assert.throws(() => getWorkflow(foreign.project.id, old.id), /不存在/);
});

test('导出 await 各阶段保留最新绑定、暂停与撤回状态', async () => {
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', path.join(root, 'tests/fixtures/agent-export-races.mjs')],
    { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
  assert.equal(await new Promise(r => child.once('close', r)), 0, errors + output);
  assert.deepEqual(JSON.parse(output.trim()).passed, ['rebind-during-preflight', 'pause-during-mp4', 'revoke-during-draft', 'cancel-during-preflight', 'draft-failure-after-rebind']);
});
