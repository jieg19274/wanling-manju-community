import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

async function run(adapter, request, env, folder) {
  const input = path.join(folder, `${adapter}-${Math.random()}.json`);
  const output = path.join(folder, `${adapter}-${Math.random()}.out`);
  await writeFile(input, JSON.stringify(request));
  const child = spawn(process.execPath, [path.resolve('adapters', `mumu-${adapter}.mjs`), input, output],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += String(chunk); });
  const code = await new Promise(resolve => child.on('close', resolve));
  return { code, error, output, bytes: code === 0 ? await readFile(output) : null };
}

test('木木工坊适配器只用本机会话，保留视频提示词与参考图顺序', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'manju-mumu-test-'));
  const token = 'a'.repeat(43);
  const requests = [];
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/static/image.png') { res.writeHead(200).end(image); return; }
    if (url.pathname === '/static/video.mp4') { res.writeHead(200).end(Buffer.from('video bytes')); return; }
    if (req.headers['x-manjuflow-session'] !== token ||
      req.headers.cookie !== `manjuflow_local_session=${token}`) { res.writeHead(403).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ path: url.pathname, body: parsed, control: req.headers['x-manjuflow-control'] });
    const data = url.pathname.endsWith('/models') ? [
      { kind: 'text', name: '文本', models: ['text-model'], ready: true },
      { kind: 'image', name: '图片', models: ['image-model'], ready: true },
      { kind: 'video', name: '视频', models: ['video-model'], ready: true,
        capabilities: { 'video-model': { prompt: { max_unicode_code_points: 1000 } } } },
    ] : url.pathname.endsWith('/text') ? { content: JSON.stringify({ highlightReport: '原文报告' }) }
      : url.pathname === '/api/v1/images' ? { id: 1 }
      : url.pathname === '/api/v1/images/1' ? { status: 'completed', local_path: 'image.png' }
      : url.pathname.endsWith('/reference-upload-plan') ? { required: true, token: 'upload-plan', destination: 'https://imageproxy.zhongzhuan.chat' }
      : url.pathname.endsWith('/reference-upload') ? { ready: true }
      : url.pathname === '/api/v1/videos' ? { id: 2 }
      : url.pathname === '/api/v1/videos/2' ? { status: 'completed', prompt: '完整正式提示词', local_path: 'video.mp4' }
      : null;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const env = { MANJU_MUMU_BASE_URL: `http://127.0.0.1:${address.port}`,
      MANJU_MUMU_SESSION_TOKEN: token, MANJU_MUMU_STORAGE_ROOT: folder };
    const text = await run('text', { task: 'highlight-report', model: 'text-model', sourceText: '原文' }, env, folder);
    assert.equal(text.code, 0, text.error);
    assert.equal(JSON.parse(text.bytes).highlightReport, '原文报告');
    const picture = await run('image', { task: 'asset-image', model: 'image-model', asset: { name: '主角' } }, env, folder);
    assert.equal(picture.code, 0, picture.error);
    assert.equal(picture.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const ref = path.join(folder, 'ref.png'); await writeFile(ref, image);
    const repaired=await run('image',{task:'asset-image',model:'image-model',asset:{kind:'character',name:'主角',referenceRole:'turnaround'},references:[{path:ref,promptUse:'待修正原图，仅保留正确部分'}],instruction:'三视图＋大头照，第四格正面头部近照'},env,folder);
    assert.equal(repaired.code,0,repaired.error);
    const imageRequest=requests.filter(item=>item.path==='/api/v1/images').at(-1).body;
    assert.equal(imageRequest.reference_images.length,1);assert.equal(imageRequest.aspect_ratio,'3:2');assert.match(imageRequest.prompt,/正面大头近照/);assert.match(imageRequest.prompt,/待修正原图/);
    assert.deepEqual(await readFile(path.join(folder,imageRequest.reference_images[0])),image);
    const video = await run('video', { model: { id: 'video-model' }, prompt: '完整正式提示词', durationSec: 5,
      aspectRatio: '16:9', references: [{ filePath: ref }],
      anchorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' }, env, folder);
    assert.equal(video.code, 0, video.error);
    assert.equal(video.bytes.toString(), 'video bytes');
    const submitted = requests.find(item => item.path === '/api/v1/videos');
    assert.equal(submitted.body.prompt, '完整正式提示词');
    assert.equal(submitted.body.reference_image_urls.length, 1);
    assert.equal(requests.find(item => item.path.endsWith('/reference-upload')).control, '1');
    const prior = requests.length;
    const oversized = await run('video', { model: { id: 'video-model' }, prompt: 'a'.repeat(1001), durationSec: 5 }, env, folder);
    assert.notEqual(oversized.code, 0);
    assert.match(oversized.error, /请拆分片段/);
    assert.equal(requests.length, prior + 1); // 仅只读模型查询，没有上传或付费提交
  } finally { await new Promise(resolve => server.close(resolve)); }
});
