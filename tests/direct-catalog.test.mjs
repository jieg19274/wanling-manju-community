import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('只保存 API Key，并实时分页读取文本、图片、视频模型', async t => {
  if (process.platform !== 'win32') { t.skip('Windows 用户密钥保护'); return; }
  const folder = await mkdtemp(path.join(tmpdir(), 'manju-catalog-test-'));
  const key = 'test-direct-catalog-key';
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end('{}'); return; }
    res.end(req.url === '/v1/models' ? JSON.stringify({ data: [
      { id: 'gpt-6-astra' }, { id: 'gpt-image-2.5-sunburst' },
    ], has_more: true, last_id: 'page-one' }) : JSON.stringify({ data: [
      { id: 'seedance-2.5-deal' }, { id: 'new-motion', output_modalities: ['video'], capabilities: { min_duration_sec: 5, max_duration_sec: 30, fixed_duration_sec: 30, max_references: 8, max_prompt_chars: 2400, native_audio: false, reference_audio: true, reference_video: false, resolutions: ['1920x1080'], aspect_ratios: ['16:9'] } },
      { id: 'unknown-model' },
    ], has_more: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.MANJU_DATA_DIR = folder;
  process.env.MANJU_DIRECT_API_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const provider = await import('../dist-server/server/direct-provider.js');
    assert.equal(provider.directStatus().configured, false);
    assert.equal(provider.globalModels().text.modelId,'claude-opus-5-5');
    assert.equal(provider.globalModels().image.modelId,'gpt-image-2.5-sunburst');
    assert.equal(provider.globalModels().video.modelId,'专享sd2.5(30图10音/4-30秒/720p)');
    provider.saveDirectConfig({ apiKey: key, baseUrl: 'https://ignored.example/v1',
      uploadUrl: 'https://ignored.example/upload' });
    assert.deepEqual(provider.directStatus(), { configured: true, hasKey: true, catalogMode: 'local' });
    const stored = JSON.parse(await readFile(path.join(folder, 'direct-provider.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored), ['protectedKey']);
    assert.notEqual(stored.protectedKey, key);
    const catalog = await provider.fetchDirectModels();
    assert.equal(catalog.models.find(item => item.id === 'gpt-6-astra').kind, 'text');
    assert.equal(catalog.models.find(item => item.id === 'gpt-image-2.5-sunburst').kind, 'image');
    assert.equal(catalog.models.find(item => item.id === 'seedance-2.5-deal').kind, 'video');
    assert.equal(catalog.models.find(item => item.id === 'new-motion').kind, 'video');
    const caps=catalog.models.find(item=>item.id==='new-motion').declaredCapabilities;
    assert.equal(caps.nativeAudio,false);assert.equal(caps.referenceAudio,true);assert.equal(caps.referenceVideo,false);
    assert.equal(caps.minDurationSec,5);assert.equal(caps.maxDurationSec,30);assert.equal(caps.fixedDurationSec,30);
    assert.equal(caps.maxReferences,8);assert.equal(caps.maxPromptChars,2400);assert.deepEqual(caps.resolutions,['1920x1080']);assert.deepEqual(caps.aspectRatios,['16:9']);
    assert.equal(catalog.models.find(item => item.id === 'unknown-model').kind, 'other');
    assert.deepEqual(seen.map(item => item.url), ['/v1/models', '/v1/models?after=page-one']);
    assert.ok(seen.every(item => item.authorization === `Bearer ${key}`));
    const store = await import('../dist-server/server/store.js');
    const { makeProject } = await import('../dist-server/shared/model.js');
    const existing = store.insertProject(makeProject('已有项目', 'standard'));
    provider.saveGlobalModel({ kind: 'text', modelId: 'gpt-6-astra' });
    assert.equal(store.getProject(existing.id).textModel.modelId, '');
    assert.equal(store.getProject(existing.id).textModel.adapterPath, '');
    assert.equal(provider.applyGlobalModels(makeProject('新项目', 'standard')).textModel.modelId, 'gpt-6-astra');
    provider.saveDirectConfig({ apiKey: '' });
    assert.equal(provider.globalModels().text.modelId, 'gpt-6-astra');
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.MANJU_DATA_DIR;
    delete process.env.MANJU_DIRECT_API_BASE_URL;
  }
});
