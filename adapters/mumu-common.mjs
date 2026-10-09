import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = new URL(process.env.MANJU_MUMU_BASE_URL || 'http://127.0.0.1:5699');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  || base.username || base.password || base.pathname !== '/') {
  throw new Error('木木工坊 API 仅允许本机 HTTP 地址');
}
const token = process.env.MANJU_MUMU_SESSION_TOKEN || '';

export function input() {
  if (!process.argv[2] || !process.argv[3]) throw new Error('用法：适配器 <request.json> <output-file>');
  return JSON.parse(readFileSync(process.argv[2], 'utf8'));
}

export function output(value) { writeFileSync(process.argv[3], JSON.stringify(value)); }

export async function api(route, { method = 'GET', body, control = false, timeoutMs = 30000 } = {}) {
  if (token.length < 32) throw new Error('木木工坊联动尚未启动；请使用“启动 Manju Studio（木木 API）”');
  const url = new URL(`/api/v1${route}`, base);
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-manjuflow-session': token,
      cookie: `manjuflow_local_session=${encodeURIComponent(token)}`,
      ...(control ? { 'x-manjuflow-control': '1' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`木木工坊 API 返回非 JSON（HTTP ${response.status}）`); }
  if (!response.ok || data.success !== true) {
    const message = String(data?.error?.message || `HTTP ${response.status}`).slice(0, 400);
    throw new Error(`木木工坊 API：${message}`);
  }
  return data.data;
}

export async function modelCatalog(kind, model) {
  const rows = await api('/integrations/manju-studio/models');
  const found = rows.find(row => row.kind === kind && row.ready && row.models.includes(model));
  if (!found) throw new Error(`木木工坊没有已启用的 ${kind} 模型 ${model}`);
  return found;
}

export async function downloadLocalMedia(localPath, maxBytes = 256 * 1024 * 1024) {
  const relative = String(localPath || '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('木木工坊返回的素材路径无效');
  const url = new URL(`/static/${relative.split('/').map(encodeURIComponent).join('/')}`, base);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`读取木木工坊素材失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw new Error('木木工坊素材为空或超出大小上限');
  return bytes;
}

export async function waitFor(kind, id, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const item = await api(`/${kind}/${encodeURIComponent(id)}`);
    if (item.status === 'completed') return item;
    if (item.status === 'failed' || item.status === 'cancelled')
      throw new Error(`木木工坊任务 ${id} 失败：${String(item.error_msg || item.status).slice(0, 350)}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`木木工坊任务 ${id} 仍未完成；先在木木工坊核对远端任务，禁止直接重复付费提交`);
}

export async function stageReference(filePath, bytes) {
  const storage = process.env.MANJU_MUMU_STORAGE_ROOT;
  if (!storage || !path.isAbsolute(storage)) throw new Error('未配置木木工坊素材目录');
  const data = bytes || await readFile(filePath);
  if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('参考图为空或超过 20 MB');
  const ext = bytes ? '.png' : path.extname(filePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('参考图格式不支持');
  const digest = createHash('sha256').update(data).digest('hex');
  const relative = `integrations/manju-studio/${digest}${ext}`;
  const target = path.join(storage, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return relative;
}
