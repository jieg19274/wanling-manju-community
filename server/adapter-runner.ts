import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest, id, now } from '../shared/model.js';
import { dataDir, db } from './store.js';
import {adapterTimeout,terminateChild} from './process-contract.js';
import {imagePool,textPool} from './concurrency.js';

const queuedAdapters = new Map<string, AbortController>();
export class AdapterCancelledError extends Error {
  constructor() { super('任务已取消，未提交模型'); this.name = 'AdapterCancelledError'; }
}

/** Only unsubmitted adapters can be cancelled; the ledger is the authority. */
export function cancelQueuedAdapter(projectId: string, taskId: string): boolean {
  const changed = db.prepare("UPDATE adapter_tasks SET status='cancelled',error=?,updated_at=? WHERE id=? AND project_id=? AND status='queued'")
    .run('任务已取消，未提交模型', now(), taskId, projectId);
  if (!changed.changes) return false;
  queuedAdapters.get(taskId)?.abort(new AdapterCancelledError());
  return true;
}

export async function runFileAdapter(adapter: string, request: object, extension: string,
  timeoutMs = 600_000): Promise<string> {
  return runAdapter(adapter, request, extension, timeoutMs,
    (request as Record<string, unknown>).task === 'asset-image' ? 'image' : undefined);
}

async function runAdapter(adapter: string, request: object, extension: string,
  timeoutMs: number, lane?: 'image' | 'text'): Promise<string> {
  const dir = path.join(dataDir, 'adapter-jobs');
  mkdirSync(dir, { recursive: true });
  const token = id(), output = path.join(dir, `${token}${extension}`), input = path.join(dir, `${token}.json`);
  const spec = request as Record<string, unknown>, fingerprint = digest({ adapter: path.resolve(adapter), request });
  const previous = db.prepare("SELECT id,status FROM adapter_tasks WHERE fingerprint=? AND status IN ('queued','running','remote_unknown') LIMIT 1").get(fingerprint);
  if(previous)throw new Error(previous.status==='remote_unknown'
    ? `上次相同模型请求的状态尚未确认（任务 ${previous.id}），请先核对服务商回执或恢复已返回结果；本次未重复提交`
    : `相同模型请求已排队或正在生成（任务 ${previous.id}），请在生成任务中查看进度；本次未重复提交`);
  const paid = spec.task !== 'health';
  const pool = lane === 'image' ? imagePool : lane === 'text' ? textPool : undefined;
  db.prepare('INSERT INTO adapter_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(token, typeof spec.projectId === 'string' ? spec.projectId : null,
    String(spec.task || 'adapter'), fingerprint, JSON.stringify({ version: 1, adapter, request }), pool ? 'queued' : 'running', output, null, now(), now());
  const executable = path.resolve(adapter);
  const command = /\.(?:mjs|cjs|js)$/i.test(executable) ? process.execPath : executable;
  const args = command === process.execPath ? [executable, input, output] : [input, output];
  const controller = pool ? new AbortController() : undefined;
  if (controller) queuedAdapters.set(token, controller);
  let release: (() => void) | undefined, submitted = false;
  try {
    if (pool) {
      release = await pool.acquire(controller!.signal);
      const claimed = db.prepare("UPDATE adapter_tasks SET status='running',updated_at=? WHERE id=? AND status='queued'").run(now(), token);
      if (!claimed.changes) {
        if (db.prepare('SELECT status FROM adapter_tasks WHERE id=?').get(token)?.status === 'cancelled') throw new AdapterCancelledError();
        throw new Error('任务已离开队列，未提交模型');
      }
      queuedAdapters.delete(token);
    }
    writeFileSync(input, JSON.stringify({ ...request, outputPath: output }, null, 2));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.once('spawn', () => { submitted = true; });
      let stderr = '', settled = false;
      const timer = setTimeout(() => { terminateChild(child); if (!settled) { settled = true;
        reject(new Error('模型适配器超时；先核对服务商任务状态，不要直接重试付费请求')); } }, adapterTimeout(timeoutMs));
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-1000); });
      child.on('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
      child.on('close', code => { clearTimeout(timer); if (!settled) { settled = true;
        code === 0 ? resolve() : reject(new Error(`模型适配器失败：${stderr.slice(-500)}`)); } });
    });
    db.prepare("UPDATE adapter_tasks SET status='completed',updated_at=? WHERE id=?").run(now(), token);
  } catch (error) {
    db.prepare("UPDATE adapter_tasks SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('queued','running')").run(paid && submitted ? 'remote_unknown' : 'failed',
      (error as Error).message, now(), token);
    throw error;
  } finally { queuedAdapters.delete(token); release?.(); }
  return output;
}

export async function runJsonAdapter<T>(adapter: string, request: object): Promise<T> {
  const file = await runAdapter(adapter, request, '.json', 600_000,
    (request as Record<string, unknown>).task !== 'health' ? 'text' : undefined);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型返回的 JSON 格式错误');
  return parsed as T;
}

/** Recover an already returned, complete text response without another model call. */
export function recoverTextResponse(projectId: string, taskId: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM adapter_tasks WHERE id=? AND project_id=?').get(taskId, projectId);
  if (!row || !['remote_unknown', 'completed'].includes(String(row.status)) ||
    !['highlight-report', 'script-beats', 'asset-extract', 'segment-plan', 'semantic-review'].includes(String(row.task)))
    throw new Error('没有可恢复的已返回文本任务');
  const saved = JSON.parse(String(row.snapshot));
  const output = String(row.output_path);
  if (path.dirname(path.resolve(output)) !== path.resolve(dataDir, 'adapter-jobs') ||
    row.fingerprint !== digest({ adapter: path.resolve(saved.adapter), request: saved.request }))
    throw new Error('文本任务路径或请求指纹不一致');
  const raw = JSON.parse(readFileSync(output + '.response.json', 'utf8'));
  if (raw.finishReason !== 'stop' || raw.model !== saved.request.model || typeof raw.message?.content !== 'string')
    throw new Error('供应商未返回完整、匹配模型的文本结果');
  const content = raw.message.content.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  let parsed: unknown, quoteRepair = false;
  try { parsed = JSON.parse(content); }
  catch {
    // Only escape unescaped ASCII quotes inside JSON strings; preserve every content character.
    let repaired = '', inside = false;
    for (let index = 0; index < content.length; index++) {
      const char = content[index];
      if (inside && char === '\\') { repaired += content.slice(index, index + 2); index++; continue; }
      if (char === '"') {
        if (!inside) inside = true;
        else if (!content.slice(index + 1).trimStart() || /^[,:}\]]/u.test(content.slice(index + 1).trimStart())) inside = false;
        else repaired += '\\';
      }
      repaired += char;
    }
    parsed = JSON.parse(repaired); quoteRepair = true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('恢复结果必须是JSON对象');
  writeFileSync(output + '.recovery.json', JSON.stringify({ taskId, providerResponseHash: digest(raw),
    recoveredResultHash: digest(parsed), quoteRepairOnly: quoteRepair, priorError: row.error,
    recoveredAt: now(), paidRequestsSubmitted: 0 }, null, 2));
  writeFileSync(output, JSON.stringify(parsed));
  db.prepare("UPDATE adapter_tasks SET status='completed',error=NULL,updated_at=? WHERE id=? AND project_id=? AND status IN ('remote_unknown','completed')")
    .run(now(), taskId, projectId);
  return parsed as Record<string, unknown>;
}
