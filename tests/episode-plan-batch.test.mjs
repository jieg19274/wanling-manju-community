import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('百章原文按每五章分批分析，完整覆盖并生成分集', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'manju-plan-batch-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: root,
    env: { ...process.env, MANJU_PORT: String(port), MANJU_DATA_DIR: folder },
    windowsHide: true, stdio: 'ignore' });
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  }
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await request('/api/health')).ok; if (ready) break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(ready, true);
    const project = await request('/api/projects', 'POST', { name: '百章分批测试', mode: 'standard' });
    const route = `/api/projects/${project.id}`;
    // This regression explicitly tests a legacy five-chapter preference.
    await request(`${route}/actions`, 'POST', { type: 'project.productionRules',
      rules: { minChapters: 1, maxChapters: 5, fixedChapters: 5, chapterStrategy: 'fixed' } });
    await request(`${route}/actions`, 'POST', { type: 'project.model', kind: 'text',
      name: '模拟文本模型', modelId: 'fixture.text',
      adapterPath: path.join(root, 'tests', 'fixtures', 'text-adapter.mjs') });
    const source = Array.from({ length: 100 }, (_, index) =>
      `第${index + 1}章 剧情节点\n${'本章人物行动、原因与反应。'.repeat(8)}\n`).join('');
    await request(`${route}/actions`, 'POST', { type: 'project.source', sourceText: source });
    const budget=await request(`${route}/assist/plan-preview`);
    const started = await request(`${route}/assist/plan`, 'POST', {budgetHash:budget.hash});
    assert.equal(started.totalBatches, 20);
    let status;
    for (let i = 0; i < 160; i++) {
      status = await request(`${route}/assist/plan`);
      if (status.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.status, 'completed', status.error);
    assert.equal(status.completedBatches, 20);
    const finished = await request(route);
    assert.equal(finished.episodePlan.ranges.length, 20);
    assert.ok(finished.episodePlan.ranges.every(range => range.chapters.length === 5));
    assert.equal(finished.episodePlan.ranges.map(range => source.slice(range.start, range.end)).join(''), source);
    await request(`${route}/actions`, 'POST', { type: 'project.createEpisodes' });
    const episodes = (await request(route)).episodes;
    assert.equal(episodes.length, 20);
    assert.equal(episodes.map(episode => episode.sourceText).join(''), source);
  } finally {
    child.kill();
    if (!process.env.MANJU_TEST_KEEP_FILES) rmSync(folder, { recursive: true, force: true });
  }
});
