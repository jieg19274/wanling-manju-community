import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fileDataUri } from '../adapters/media-data-uri.mjs';

test('本地图片、音频和视频可直接编码为模型入参', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'manju-media-uri-'));
  for (const [name, mime] of [['ref.png', 'image/png'], ['ref.mp3', 'audio/mpeg'], ['ref.mp4', 'video/mp4']]) {
    const file = path.join(folder, name);
    await writeFile(file, Buffer.from('local media'));
    assert.equal(await fileDataUri(file), `data:${mime};base64,${Buffer.from('local media').toString('base64')}`);
  }
});

async function adapter(kind, task, folder) {
  const input = path.join(folder, `${kind}-request.json`), output = path.join(folder, `${kind}-output`);
  await writeFile(input, JSON.stringify(task));
  const child = spawn(process.execPath, [path.resolve('adapters', `direct-${kind}.mjs`), input, output],
    { env: { ...process.env, MANJU_DATA_DIR: folder,
      MANJU_DIRECT_API_BASE_URL: process.env.MANJU_DIRECT_TEST_URL }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', bytes => { error += String(bytes); });
  const code = await new Promise(resolve => child.on('close', resolve));
  return { code, error, bytes: code === 0 ? await readFile(output) : null };
}

test('新软件直连适配器独立调用模型接口，保留完整视频提示词', async t => {
  if (process.platform !== 'win32') { t.skip('Windows 用户密钥保护'); return; }
  const folder = await mkdtemp(path.join(tmpdir(), 'manju-direct-test-'));
  const key = 'test-secret-direct-key';
  const script = "Add-Type -AssemblyName System.Security; $raw = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $protected = [Security.Cryptography.ProtectedData]::Protect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))";
  const protectedKey = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: key, encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.ok(protectedKey);
  const requests = [];
  const generatedImage=await sharp({create:{width:32,height:32,channels:3,background:'#123456'}}).png().toBuffer();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
    let body = '';
    for await (const bytes of req) body += bytes;
    requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/v1/videos/job-1/content') {
      res.writeHead(307, { Location: `http://127.0.0.1:${server.address().port}/video.mp4` }).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    const value = req.url === '/v1/models' ? { data: [{ id: 'text-model' }, { id: 'image-model' }, { id: 'video-model' }] }
      : req.url === '/v1/chat/completions' ? { choices: [{ finish_reason: 'stop', message: { content: '{"highlightReport":"依据原文"}' } }] }
      : req.url === '/v1/images/generations' ? (JSON.parse(body).model === 'image-async' ? {task_id:'original-image'} : { data: [{ b64_json: generatedImage.toString('base64') }] })
      : req.url === '/v1/images/generations/tasks/original-image' ? {status:'completed',data:[{b64_json:generatedImage.toString('base64')}]}
      : req.url === '/v1/videos' ? { id: 'job-1' }
      : req.url === '/v1/videos/job-1' ? { status: 'completed' }
      : null;
    if (req.url === '/video.mp4') { res.end('video bytes'); return; }
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.MANJU_DIRECT_TEST_URL = `http://127.0.0.1:${server.address().port}/v1`;
    await writeFile(path.join(folder, 'direct-provider.json'), JSON.stringify({
      protectedKey,
    }));
    const health = await adapter('text', { task: 'health', model: 'text-model' }, folder);
    assert.equal(health.code, 0, health.error);
    const text = await adapter('text', { task: 'highlight-report', model: 'text-model', sourceText: '完整原文' }, folder);
    assert.equal(text.code, 0, text.error);
    assert.equal(JSON.parse(text.bytes).highlightReport, '依据原文');
    const prompt = '完整正式提示词，保留对白和内心 OS';
    const reference = path.join(folder, 'reference.png');
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f0f0f0' } })
      .png().toFile(reference);
    const picture=await adapter('image',{task:'asset-image',model:'image-model',asset:{kind:'character',name:'主角',referenceRole:'turnaround'},references:[{path:reference,promptUse:'待修正原图'}],instruction:'三视图＋大头照'},folder);
    assert.equal(picture.code,0,picture.error);
    const imagePost=requests.find(item=>item.path==='/v1/images/generations').body;
    assert.equal(imagePost.size,'1536x1024');assert.equal(imagePost.images.length,1);assert.match(imagePost.images[0],/^data:image\/jpeg;base64,/);assert.match(imagePost.prompt,/正面大头近照/);
    const changed=await adapter('image',{task:'asset-image',model:'image-model',asset:{kind:'character',referenceRole:'turnaround'},references:[{path:reference,fileHash:'wrong-frozen-hash'}]},folder);
    assert.notEqual(changed.code,0);assert.match(changed.error,/文件已变化/);assert.equal(requests.filter(item=>item.path==='/v1/images/generations').length,1);
    const deferred=await adapter('image',{task:'asset-image',model:'image-async',asset:{kind:'character',referenceRole:'turnaround'},deferPolling:true},folder);
    assert.equal(deferred.code,0,deferred.error);assert.equal(JSON.parse(deferred.bytes).deferredTaskId,'original-image');
    assert.equal(requests.filter(item=>item.path==='/v1/images/generations/tasks/original-image').length,0);
    const recoveredImage=await adapter('image',{task:'recover-image',model:'image-async',remoteTaskId:'original-image'},folder);
    assert.equal(recoveredImage.code,0,recoveredImage.error);assert.deepEqual(recoveredImage.bytes,generatedImage);
    assert.equal(requests.filter(item=>item.path==='/v1/images/generations').length,2);
    assert.equal(requests.filter(item=>item.path==='/v1/images/generations/tasks/original-image').length,1);
    const video = await adapter('video', { model: { id: 'video-model' }, prompt,
      durationSec: 30, aspectRatio: '16:9', references: [{ filePath: reference }],
      anchorSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }, folder);
    assert.equal(video.code, 0, video.error);
    assert.equal(video.bytes.toString(), 'video bytes');
    const posted = requests.find(item => item.path === '/v1/videos');
    assert.equal(posted.body.prompt, prompt);
    assert.equal(posted.body.generate_audio, true);
    assert.equal(posted.body.model, 'video-model');
    assert.equal(posted.body.duration, 30);
    assert.equal(posted.body.seconds, '30');
    assert.equal(posted.body.size, '1920x1080');
    assert.equal(posted.body.images.length, 1);
    assert.match(posted.body.images[0], /^data:image\/png;base64,/);
    assert.ok(Buffer.from(posted.body.images[0].split(',')[1], 'base64').length > 0);
    assert.equal(JSON.parse(await readFile(path.join(folder, 'video-output.remote.json'))).id, 'job-1');
    const fixedDuration = await adapter('video', { model: { id: '全能sd2.5',
      capabilities: { maxDurationSec: 30, fixedDurationSec: 30 } }, prompt, durationSec: 30, aspectRatio: '16:9' }, folder);
    assert.equal(fixedDuration.code, 0, fixedDuration.error);
    assert.equal(requests.filter(item => item.path === '/v1/videos').at(-1).body.seconds, '30');
    const hd = await adapter('video', { model: { id: '专享sd2.5(30图10音/4-30秒/720p)' }, prompt,
      durationSec: 30, aspectRatio: '16:9' }, folder);
    assert.equal(hd.code, 0, hd.error);
    assert.equal(requests.filter(item => item.path === '/v1/videos').at(-1).body.size, '1280x720');
    const paidPosts = requests.filter(item => item.path === '/v1/videos').length;
    const tooShort = await adapter('video', { model: { id: '全能sd2.5' }, prompt,
      durationSec: 20, aspectRatio: '16:9' }, folder);
    assert.notEqual(tooShort.code, 0);
    assert.equal(requests.filter(item => item.path === '/v1/videos').length, paidPosts);
    const recovered = await adapter('video', { task: 'recover', model: { id: '全能sd2.5' },
      remoteTaskId: 'job-1' }, folder);
    assert.equal(recovered.code, 0, recovered.error);
    assert.equal(requests.filter(item => item.path === '/v1/videos').length, paidPosts);
    const outOfRange = await adapter('video', { model: { id: '全能sd2.5' }, prompt,
      durationSec: 31, aspectRatio: '16:9' }, folder);
    assert.notEqual(outOfRange.code, 0);
    assert.match(outOfRange.error, /固定\s*30\s*秒/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
