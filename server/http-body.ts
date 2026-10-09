import type { IncomingMessage } from 'node:http';
import { MAX_JSON_BODY_BYTES } from '../shared/source-limits.js';

export class RequestBodyError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    req.resume();
    throw new RequestBodyError('请求必须为 JSON');
  }
  // Drain rejected bodies without destroying the socket, so the client can
  // read the error response even when the upload has not finished.
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let size = 0, rejected = false;
    const chunks: Buffer[] = [];
    const tooLarge = () => {
      rejected = true; chunks.length = 0;
      reject(new RequestBodyError('请求内容过大，请减少单次提交内容；完整原文最多支持 700 万字符。', 413));
    };
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) tooLarge();
      else chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks, size)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new RequestBodyError('请求传输中断，请重新连接软件后再保存。')));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) tooLarge();
  });
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new RequestBodyError('请求文字不是有效的 UTF-8 编码，请使用 UTF-8 TXT 或重新粘贴全文。'); }
  let parsed: unknown;
  try { parsed = JSON.parse(value || '{}'); }
  catch { throw new RequestBodyError('请求格式错误，请重新提交。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RequestBodyError('请求格式错误');
  return parsed as Record<string, unknown>;
}
