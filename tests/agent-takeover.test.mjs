import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ensureAgentService } from '../scripts/agent-service.mjs';
import { installAgent } from '../scripts/install-agent.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
async function harness(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'manju-takeover-')), port = await freePort();
  const env = { ...process.env, MANJU_PORT: String(port), MANJU_DATA_DIR: path.join(folder, 'data'),
    MANJU_BACKUP_DIR: path.join(folder, 'backups'), MANJU_JIANYING_DRAFTS_DIR: path.join(folder, 'drafts') };
  const base = `http://127.0.0.1:${port}`;
  const serviceLog = path.join(folder, 'service.log');
  let server;
  const launch = () => {
    server = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.appendFileSync(serviceLog, `launch pid=${server.pid}\n`);
    server.stdout.on('data', data => fs.appendFileSync(serviceLog, data));
    server.stderr.on('data', data => fs.appendFileSync(serviceLog, data));
    server.once('exit', (code, signal) => fs.appendFileSync(serviceLog, `exit code=${code} signal=${signal}\n`));
  };
  const stop = async () => { if (server?.exitCode === null) await new Promise(r => { server.once('exit', r); server.kill(); }); };
  t.after(stop);
  async function call(route, body, headers = {}) {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await res.json(); if (!res.ok) throw Error(value.error); return value;
  }
  async function wait(route, predicate) {
    for (let i = 0; i < 120; i++) {
      try { const v = await call(route); if (predicate(v)) return v; } catch {}
      await new Promise(r => setTimeout(r, 60));
    }
    throw Error(`Timeout ${route}; service exit=${server.exitCode}; ${fs.readFileSync(serviceLog, 'utf8').slice(-1500)}`);
  }
  launch(); await wait('/api/health', h => h.ok);
  let serial = 0;
  const command = async (id, fields) => call(`/api/projects/${id}/agent/command`, {
    requestId: `test-command-${++serial}`, expectedHash: (await call(`/api/projects/${id}/agent`)).stateHash, ...fields });
  const review = async (id, taskId, action, extra = {}) => {
    const context = await call(`/api/projects/${id}/agent`);
    return command(id, { command: 'action', taskId, action,
      review: { notes: '测试核验：逐项对照本集原文与当前草稿，保留剧情、声音及人物反应。', stateHash: context.stateHash, ...extra } });
  };
  return { call, wait, command, review, folder, env, base,
    restart: async () => { await stop(); launch(); await wait('/api/health', h => h.ok); } };
}

test('接管默认规则持久化、连续章节覆盖、完整阅读证据、核验身份与30秒锁稿', async t => {
  const h = await harness(t);
  const input = { requestId: 'project-defaults-001', name: '接管默认规则测试' };
  let context = await h.call('/api/agent/projects', input);
  const id = context.project.id, route = `/api/projects/${id}`;
  assert.equal(context.rules.segmentDurationSec, 30); assert.equal(context.rules.maxChapters, 3);
  assert.equal((await h.call('/api/agent/projects', input)).project.id, id);
  await assert.rejects(h.call('/api/agent/projects', { ...input, name: '不同请求' }), /已改变/);
  const source = Array.from({ length: 7 }, (_, i) => `第${i + 1}章 门外来客\n林舟听到敲门声，推开门。他问清来意，让同伴进屋，再回头确认门外安全。${'同伴点头，林舟放下心来。'.repeat(5)}\n`).join('');
  await h.command(id, { command: 'action', action: { type: 'project.source', sourceText: source } });
  await assert.rejects(h.command(id, { command: 'action', action: { type: 'project.planChapterGroups', chapterEnds: [4, 7] } }), /1–3/);
  await assert.rejects(h.command(id, { command: 'action', action: { type: 'project.planChapterGroups', chapterEnds: [3, 6] } }), /全部章节/);
  await h.command(id, { command: 'action', action: { type: 'project.planChapterGroups', chapterEnds: [2, 5, 7] } });
  await h.command(id, { command: 'action', action: { type: 'project.createEpisodes' } });
  context = await h.call(route + '/agent');
  assert.equal(context.project.episodes.map(e => e.sourceText).join(''), source);
  assert.deepEqual(context.project.episodePlan.ranges.map(r => r.chapters.length), [2, 3, 2]);
  const ep = context.project.episodes[0];
  const task = await h.call(route + '/agent/task', { requestId: 'review-task-001', agent: 'offline-test',
    statement: '仅核验第1集并准备草稿，不调用模型生成。', confirmed: true, episodeIds: [ep.id] });
  await assert.rejects(h.command(id, { command: 'action', taskId: task.id, action: { type: 'episode.confirmSource', episodeId: ep.id } }), /核验记录/);
  await assert.rejects(h.review(id, task.id, { type: 'episode.confirmSource', episodeId: ep.id }, {
    sourceHash: context.sourceHashes[ep.id], readStart: 0, readEnd: ep.sourceText.length - 1 }), /完整原文/);
  await assert.rejects(h.review(id, task.id, { type: 'episode.confirmSource', episodeId: context.project.episodes[1].id }), /范围/);
  const confirmed = await h.review(id, task.id, { type: 'episode.confirmSource', episodeId: ep.id }, {
    sourceHash: context.sourceHashes[ep.id], readStart: 0, readEnd: ep.sourceText.length });
  assert.equal(confirmed.result.review.reviewerKind, 'agent'); assert.equal(confirmed.result.review.reviewer, 'offline-test');
  await h.command(id, { command: 'action', taskId: task.id, action: { type: 'episode.update', episodeId: ep.id,
    highlightReport: '章节范围：第1–2章。起因：敲门。行动：开门问明来意。反应：同伴点头，林舟放心。结果：同伴进屋。未采用素材：无。' } });
  await h.review(id, task.id, { type: 'episode.confirmHighlight', episodeId: ep.id });
  const beat = { sourceQuote: '林舟听到敲门声，推开门。', event: '林舟听到敲门声，推开门。', reaction: '同伴点头，林舟放心。',
    dialogue: ['林舟：进来吧。'], os: ['林舟：原来是她。'], floatLabels: ['门外'], systemPanels: [] };
  await h.command(id, { command: 'action', taskId: task.id, action: { type: 'episode.writeScript', episodeId: ep.id, beats: [beat] } });
  const locked = await h.review(id, task.id, { type: 'script.lock', episodeId: ep.id });
  assert.ok(locked.context.project.episodes[0].segments.every(s => s.durationSec === 30));
  assert.deepEqual(locked.context.project.episodes[0].scriptBeats[0].dialogue, beat.dialogue);
  await assert.rejects(h.command(id, { command: 'action', taskId: task.id, action: { type: 'episode.writeScript', episodeId: ep.id, beats: [beat] } }), /锁定/);
  await h.call('/api/production-defaults', { maxChapters: 2, fixedChapters: 2 });
  await h.restart();
  assert.equal((await h.call('/api/agent')).defaults.maxChapters, 2);
  assert.equal((await h.call(route + '/agent')).rules.maxChapters, 3);
  assert.equal((await h.call('/api/agent/projects', { requestId: 'project-defaults-002', name: '新偏好' })).rules.maxChapters, 2);
});

test('任务面板暂停跨集持久化、阻断新额度绕过、恢复不清零，控制请求幂等', async t => {
  const h = await harness(t);
  const initial = await h.call('/api/agent/projects', { requestId: 'project-pause-001', name: '暂停任务验收', mode: 'douyin-story' });
  const id = initial.project.id, route = `/api/projects/${id}`;
  await h.call(route + '/actions', { type: 'project.model', kind: 'text', name: '本地mock', modelId: 'fixture.text', adapterPath: path.join(root, 'tests/fixtures/text-adapter.mjs') });
  for (let i = 0; i < 2; i++) await h.command(id, { command: 'action', action: { type: 'episode.add' } });
  let context = await h.call(route + '/agent');
  const episodes = context.project.episodes;
  for (const e of episodes) {
    await h.call(route + '/actions', { type: 'episode.update', episodeId: e.id, sourceText: '林舟听到敲门声，开门看见同伴。他问清来意，同伴点头，他让她进屋并关门。'.repeat(5) });
    await h.call(route + '/actions', { type: 'episode.confirmSource', episodeId: e.id });
  }
  const grant = { agent: 'offline-test', statement: '只使用本地mock验证两集暂停，合计一次模拟文本提交。', confirmed: true,
    episodeIds: episodes.map(e => e.id), delivery: 'package', allowGeneration: true, acceptUnknownCost: true, limits: { text: 1 } };
  const task = await h.call(route + '/agent/task', { ...grant, requestId: 'pause-grant-001' });
  const flows = [];
  for (const e of episodes) flows.push((await h.command(id, { command: 'start', episodeId: e.id, taskId: task.id })).result);
  const control = (operation, requestId) => h.call(`${route}/agent/task/${task.id}/control`, { operation, requestId }, { origin: h.base });
  await assert.rejects(h.call(`${route}/agent/task/${task.id}/control`, { operation: 'resume', requestId: 'outside-control-001' }), /软件任务面板/);
  await control('pause', 'pause-control-001');
  let dashboard = await h.call(route + '/agent/dashboard');
  assert.equal(dashboard.tasks[0].status, 'paused');
  assert.ok(dashboard.workflows.every(w => w.status === 'paused' && w.taskId === task.id));
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flows[0].id, taskId: task.id }), /已暂停/);
  await assert.rejects(h.call(`${route}/workflows/${flows[0].id}/resume`, {}), /已暂停/);
  await assert.rejects(h.review(id, task.id, { type: 'episode.confirmSource', episodeId: episodes[0].id }), /已暂停/);
  const renewal = await h.call(route + '/agent/task', { ...grant, requestId: 'pause-new-grant-001' });
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flows[0].id, taskId: renewal.id }), /绕过暂停/);
  await assert.rejects(h.command(id, { command: 'start', episodeId: episodes[0].id, taskId: renewal.id }), /绕过暂停/);
  await h.restart(); dashboard = await h.call(route + '/agent/dashboard');
  assert.equal(dashboard.tasks.find(t => t.id === task.id).status, 'paused');
  await control('resume', 'resume-control-001');
  assert.equal((await control('pause', 'pause-control-001')).replayed, true);
  dashboard = await h.call(route + '/agent/dashboard');
  assert.equal(dashboard.tasks.find(t => t.id === task.id).status, 'active');
  assert.equal(dashboard.tasks.find(t => t.id === task.id).remaining.text, 1);
  await assert.rejects(control('resume', 'pause-control-001'), /请求内容不能改变/);
  await assert.rejects(h.call(`${route}/workflows/${flows[0].id}/authorize`, { hash: flows[0].step.hash, confirmed: true }, { origin: h.base }), /原任务额度/);
  await h.command(id, { command: 'continue', workflowId: flows[0].id, taskId: task.id });
  await h.wait(route + '/agent/dashboard', d => d.workflows.find(w => w.id === flows[0].id).status === 'waiting_review');
  // Another episode changed the project snapshot; refresh the second flow
  // before checking its shared task's exhausted quota.
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flows[1].id, taskId: task.id }), /输入已变化/);
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flows[1].id, taskId: task.id }), /上限|额度/);
  await control('pause', 'pause-after-submit-001'); await h.restart();
  await control('resume', 'resume-after-submit-001');
  dashboard = await h.call(route + '/agent/dashboard');
  assert.equal(dashboard.tasks.find(t => t.id === task.id).used.text, 1);
  assert.equal(dashboard.tasks.find(t => t.id === task.id).remaining.text, 0);
  await control('revoke', 'revoke-control-001');
  dashboard = await h.call(route + '/agent/dashboard');
  assert.equal(dashboard.tasks.find(t => t.id === task.id).status, 'revoked');
  assert.ok(dashboard.workflows.every(w => w.status === 'cancelled'));
  await assert.rejects(control('resume', 'revoked-resume-001'), /撤回/);
});

test('首次连接提供本机准备检查，任务面板不包含完整原文或模型预览', async t => {
  const h = await harness(t), manifest = await h.call('/api/agent');
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.readiness.draftReady, true);
  assert.equal(manifest.readiness.generationReady, false);
  assert.ok(manifest.readiness.missing.includes('图片模型'));
  const context = await h.call('/api/agent/projects', { requestId: 'project-ready-001', name: '准备检查', mode: 'douyin-story' });
  const route = `/api/projects/${context.project.id}`;
  await h.call(route + '/actions', { type: 'project.model', kind: 'video', name: '8秒模型', modelId: 'fixture.video', adapterPath: path.join(root, 'tests/fixtures/video-adapter.mjs'), capabilities: { maxDurationSec: 8 } });
  const ready = await h.call(`/api/agent/readiness?projectId=${context.project.id}`);
  assert.equal(ready.checks.find(c => c.key === 'duration').ready, false);
  assert.ok(ready.missing.includes('30秒片段'));
  assert.equal(ready.checks.find(c => c.key === 'source').ready, false);
  const dashboard = await h.call(route + '/agent/dashboard');
  assert.deepEqual(dashboard.tasks, []); assert.deepEqual(dashboard.deliverables, []);
  assert.ok(!JSON.stringify(dashboard).includes('sourceText'));
  assert.ok(!JSON.stringify(dashboard).includes('protectedKey'));
  assert.ok(!JSON.stringify(dashboard).includes('preview'));
});

test('任务额度控制自动续跑：未知费用、重复请求、上限、撤回、重启与旧哈希', async t => {
  const h = await harness(t);
  let context = await h.call('/api/agent/projects', { requestId: 'project-budget-001', name: '额度测试', mode: 'douyin-story' });
  const id = context.project.id, route = `/api/projects/${id}`;
  await h.call(route + '/actions', { type: 'project.model', kind: 'text', name: '本地mock', modelId: 'fixture.text', adapterPath: path.join(root, 'tests/fixtures/text-adapter.mjs') });
  await h.command(id, { command: 'action', action: { type: 'episode.add' } });
  context = await h.call(route + '/agent'); const ep = context.project.episodes[0];
  const source = '林舟推开门，看见同伴在门外。他问清来意，让她进屋，确认门外安全后关上门。'.repeat(4);
  await h.command(id, { command: 'action', action: { type: 'episode.update', episodeId: ep.id, sourceText: source } });
  const baseTask = { agent: 'offline-test', statement: '仅测试第1集生产包流程，最多模拟文本提交一次。', confirmed: true,
    episodeIds: [ep.id], delivery: 'package', allowGeneration: true, limits: { text: 1, image: 0, video: 0 } };
  await assert.rejects(h.call(route + '/agent/task', { ...baseTask, requestId: 'invalid-video-001', limits: { video: 1 } }), /视频/);
  const unknown = await h.call(route + '/agent/task', { ...baseTask, requestId: 'unknown-cost-001' });
  context = await h.call(route + '/agent');
  await h.review(id, unknown.id, { type: 'episode.confirmSource', episodeId: ep.id }, {
    sourceHash: context.sourceHashes[ep.id], readStart: 0, readEnd: source.length });
  const started = await h.command(id, { command: 'start', episodeId: ep.id, taskId: unknown.id });
  const flowId = started.result.id;
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flowId, taskId: unknown.id }), /费用未知/);
  const amount = await h.call(route + '/agent/task', { ...baseTask, requestId: 'amount-limit-001', maxAmount: 1, currency: '积分' });
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flowId, taskId: amount.id }), /金额上限/);
  const grantInput = { ...baseTask, requestId: 'mock-grant-001', acceptUnknownCost: true };
  const task = await h.call(route + '/agent/task', grantInput);
  context = await h.call(route + '/agent');
  const submission = { requestId: 'submit-highlight-001', expectedHash: context.stateHash, command: 'continue', workflowId: flowId, taskId: task.id };
  await h.call(route + '/agent/command', submission);
  const replay = await h.call(route + '/agent/command', submission); assert.equal(replay.replayed, true);
  await h.wait(route + '/agent', c => c.workflows[0].status === 'waiting_review');
  assert.equal((await h.call(route + '/agent/task', grantInput)).used.text, 1);
  await h.command(id, { command: 'action', taskId: task.id, action: { type: 'episode.applyHighlightCandidate', episodeId: ep.id } });
  await h.review(id, task.id, { type: 'episode.confirmHighlight', episodeId: ep.id });
  await h.command(id, { command: 'continue', workflowId: flowId, taskId: task.id });
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flowId, taskId: task.id }), /上限|额度/);
  const renewal = await h.call(route + '/agent/task', { ...grantInput, requestId: 'mock-renewal-001',
    statement: '明确追加一次模拟文本提交，沿用本集生产包流程。' });
  await h.command(id, { command: 'continue', workflowId: flowId, taskId: renewal.id });
  await h.wait(route + '/agent', c => c.workflows[0].status === 'waiting_review');
  context = await h.call(route + '/agent');
  assert.equal(context.workflows[0].used.text, 2);
  assert.equal(context.tasks.find(t => t.id === task.id).used.text, 1);
  assert.equal(context.tasks.find(t => t.id === renewal.id).used.text, 1);
  await assert.rejects(h.call(route + '/agent/command', { ...submission, requestId: 'stale-command-001' }), /状态已变化/);
  await h.command(id, { command: 'pause', workflowId: flowId });
  await h.restart(); context = await h.call(route + '/agent');
  assert.equal(context.workflows[0].status, 'paused'); assert.equal(context.tasks.find(t => t.id === task.id).used.text, 1);
  await h.command(id, { command: 'revoke', taskId: task.id });
  await assert.rejects(h.command(id, { command: 'continue', workflowId: flowId, taskId: task.id }), /撤回/);
  await h.command(id, { command: 'cancel', workflowId: flowId });
  assert.equal((await h.call(route + '/agent')).workflows[0].status, 'cancelled');
});

test('已有剧情状态的资产先生成并核验基础图，再生成状态图，不浪费任务额度', async t => {
  const h = await harness(t);
  let context = await h.call('/api/agent/projects', { requestId: 'project-state-001', name: '状态图接管', mode: 'douyin-story' });
  const id = context.project.id, route = `/api/projects/${id}`;
  const act = async action => h.call(route + '/actions', action);
  await act({ type: 'project.model', kind: 'image', name: '本地mock', modelId: 'fixture.image', adapterPath: path.join(root, 'tests/fixtures/character-sheet-adapter.mjs') });
  await act({ type: 'episode.add' }); context = await h.call(route + '/agent'); const ep = context.project.episodes[0];
  const source = '林舟开门进入雨中，衣袖被雨淋湿。他停下，回头看向同伴。'.repeat(5);
  await act({ type: 'episode.update', episodeId: ep.id, sourceText: source });
  await act({ type: 'episode.confirmSource', episodeId: ep.id });
  await act({ type: 'episode.update', episodeId: ep.id, highlightReport: '章节范围：本集。起因：开门。行动：林舟入雨中。反应：停下回头。结果：衣袖被雨淋湿。未采用：无。' });
  await act({ type: 'episode.confirmHighlight', episodeId: ep.id });
  await act({ type: 'episode.writeScript', episodeId: ep.id, beats: [{ event: '林舟开门进入雨中，衣袖被雨淋湿。', reaction: '他停下，回头看向同伴。', sourceQuote: '林舟开门进入雨中，衣袖被雨淋湿。', dialogue: [], os: [], floatLabels: [], systemPanels: [] }] });
  await act({ type: 'script.lock', episodeId: ep.id });
  await act({ type: 'asset.add', kind: 'character', name: '林舟', identity: '黑发青年', voice: '青年男声' });
  context = await h.call(route + '/agent'); const asset = context.project.assets[0], seg = context.project.episodes[0].segments[0];
  await act({ type: 'asset.state', assetId: asset.id, label: '雨湿衣袖', appearance: '原衣袖被雨淋湿', trigger: '衣袖被雨淋湿', startEpisode: 1, startSegment: 1 });
  context = await h.call(route + '/agent'); const state = context.project.assets[0].states[0];
  await act({ type: 'segment.assets', episodeId: ep.id, segmentId: seg.id, bindings: [{ assetId: asset.id, stateId: state.id }] });
  const task = await h.call(route + '/agent/task', { requestId: 'state-images-001', agent: 'offline-test',
    statement: '仅使用本地mock测试基础图与状态图顺序，最多两次模拟图片提交。', confirmed: true, episodeIds: [ep.id],
    delivery: 'package', allowGeneration: true, acceptUnknownCost: true, limits: { image: 2 } });
  context=await h.call(route+'/agent');const episode=context.project.episodes[0];
  await h.review(id,task.id,{type:'episode.storyReview',episodeId:ep.id,entries:episode.scriptBeats.map(beat=>({beatId:beat.id,sourceStart:0,sourceEnd:source.length,highlightIds:episode.highlightItems.map(item=>item.id),notes:'逐句确认开门、入雨、衣袖湿及回头反应完整覆盖原文高光。',checks:{highlight:true,event:true,reaction:true,speech:true,labels:true}}))});
  const flow = (await h.command(id, { command: 'start', episodeId: ep.id, taskId: task.id })).result;
  assert.equal(flow.step.input.stateId, '');
  assert.equal(flow.step.input.role, 'turnaround');
  await h.command(id, { command: 'continue', workflowId: flow.id, taskId: task.id });
  context = await h.wait(route + '/agent', c => c.workflows[0].status === 'waiting_review');
  assert.equal(context.workflows[0].step.key, 'character-sheet-review:' + asset.id);
  const image = context.project.assets[0].images[0]; assert.equal(image.stateId, undefined);
  await h.review(id, task.id, { type: 'asset.imageReview', assetId: asset.id, imageId: image.id, status: 'approved',
    checks: { identity: true, state: true, shape: true, clothing: true } });
  await h.command(id, { command: 'continue', workflowId: flow.id, taskId: task.id });
  context=await h.wait(route+'/agent',c=>c.workflows[0].status==='waiting_budget');
  assert.equal(context.workflows[0].step.input.stateId,state.id);
  assert.equal(context.workflows[0].step.input.role,'turnaround');
  await h.command(id, { command: 'continue', workflowId: flow.id, taskId: task.id });
  context=await h.wait(route+'/agent',c=>c.project.assets[0].images.length===2&&c.workflows[0].status==='waiting_review');
  assert.equal(context.project.assets[0].images.filter(i=>i.derivedFrom).length,0);
  const stateImage=context.project.assets[0].images.find(i=>i.stateId===state.id);
  assert.equal(stateImage.role,'turnaround');assert.equal(stateImage.layout,'three-view-portrait');
  assert.equal(stateImage.referenceImages[0].imageId,image.id);
  assert.equal(context.tasks[0].used.image, 2);
  assert.equal(context.project.assets[0].images.filter(i => i.stateId === state.id).length, 1);
  assert.equal(context.jobs.filter(j => j.kind === 'image' && j.status === 'failed').length, 0);
});

test('接口提供当前版本官方技能和教程，不读取历史副本',async t=>{
  const h=await harness(t),manifest=await h.call('/api/agent'),version=JSON.parse(fs.readFileSync(path.join(root,'release.json'))).version;
  assert.equal(manifest.softwareVersion,version);assert.equal(manifest.resourcesVersion,version);
  assert.equal(manifest.skill,path.join(root,'dist-server/bundled/wanling-manju/SKILL.md'));
  const guide=await fetch(h.base+'/api/agent/tutorial');assert.equal(guide.status,200);assert.match(guide.headers.get('content-type'),/text\/markdown/);
  assert.equal(await guide.text(),fs.readFileSync(path.join(root,'docs/新手制作全流程.md'),'utf8'));
  const response=await fetch(h.base+'/api/agent/skill?client=codex'),zip=Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200);assert.ok(zip.includes(Buffer.from('references/workflow-guide.md')));assert.ok(zip.includes(Buffer.from('先完成逐节点原文语义')));
});

test('技能安装保护同名目录，三个客户端包带本机入口', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'manju-skill-'));
  for (const client of ['codex', 'workbuddy', 'trae']) {
    const destination = path.join(folder, client), installed = installAgent(client, root, destination);
    assert.ok(fs.existsSync(path.join(installed.skillDirectory, 'SKILL.md')));
    assert.equal(fs.readFileSync(path.join(installed.skillDirectory,'SKILL.md'),'utf8'),fs.readFileSync(path.join(root,'dist-server/bundled/wanling-manju/SKILL.md'),'utf8'));
    assert.equal(fs.readFileSync(path.join(installed.skillDirectory,'references/workflow-guide.md'),'utf8'),fs.readFileSync(path.join(root,'docs/新手制作全流程.md'),'utf8'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed.skillDirectory,'installation.json'))).version,JSON.parse(fs.readFileSync(path.join(root,'release.json'))).version);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed.skillDirectory, 'installation.json'))).root, root);
    assert.equal(fs.readFileSync(installed.zip).readUInt32LE(0), 0x04034b50);
    assert.equal(JSON.parse(fs.readFileSync(installed.mcpConfig)).mcpServers['wanling-manju'].args[0], path.join(root, 'scripts/agent-mcp.mjs'));
    assert.equal(installAgent(client, root, destination).skillDirectory, installed.skillDirectory);
  }
  const foreign = path.join(folder, 'foreign'); fs.mkdirSync(path.join(foreign, 'wanling-manju'), { recursive: true });
  const marker = path.join(foreign, 'wanling-manju', 'SKILL.md'); fs.writeFileSync(marker, 'retain');
  assert.throws(() => installAgent('codex', root, foreign), /同名技能/); assert.equal(fs.readFileSync(marker, 'utf8'), 'retain');
});

test('自动启动并发请求复用同一实例，拒绝另一安装目录的端口', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'manju-autostart-')), port = await freePort();
  const keys = ['MANJU_PORT', 'MANJU_DATA_DIR', 'MANJU_BACKUP_DIR', 'MANJU_JIANYING_DRAFTS_DIR'];
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { MANJU_PORT: String(port), MANJU_DATA_DIR: path.join(folder, 'data'), MANJU_BACKUP_DIR: path.join(folder, 'backups'), MANJU_JIANYING_DRAFTS_DIR: path.join(folder, 'drafts') });
  let pid;
  t.after(() => { if (pid) try { process.kill(pid); } catch {} for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; } });
  const connections = await Promise.all([ensureAgentService(root), ensureAgentService(root)]);
  assert.equal(connections.filter(c => !c.reused).length, 1); pid = connections.find(c => c.pid)?.pid;
  assert.ok(pid); assert.equal((await ensureAgentService(root)).reused, true);
  const installed = installAgent('codex', root, path.join(folder, 'skills'));
  const cli = spawn(process.execPath, [path.join(installed.skillDirectory, 'scripts/run.mjs'), 'connect'],
    { cwd: folder, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; cli.stdout.on('data', b => stdout += b); cli.stderr.on('data', b => stderr += b);
  assert.equal(await new Promise(r => cli.once('close', r)), 0, stderr);
  assert.equal(JSON.parse(stdout).application, 'wanling-manju');
  const mcp = spawn(process.execPath, [path.join(root, 'scripts/agent-mcp.mjs')],
    { cwd: folder, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; mcp.stdout.on('data', b => output += b);
  mcp.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_connect', arguments: {} } }) + '\n');
  assert.equal(await new Promise(r => mcp.once('close', r)), 0);
  assert.equal(JSON.parse(JSON.parse(output).result.content[0].text).installationRoot, root);
  const foreign = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ application: 'wanling-manju', installationRoot: folder, dataDirectory: folder })); });
  await new Promise(r => foreign.listen(0, '127.0.0.1', r));
  try { process.env.MANJU_PORT = String(foreign.address().port); await assert.rejects(ensureAgentService(root), /其他安装目录|另一份数据/); }
  finally { await new Promise(r => foreign.close(r)); }
});
