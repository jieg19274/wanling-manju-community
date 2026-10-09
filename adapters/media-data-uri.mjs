import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const mimeByExtension = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

export function mediaDataUri(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('本地参考文件为空');
  if (!Object.values(mimeByExtension).includes(mime)) throw new Error(`不支持的参考文件类型：${mime}`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export async function fileDataUri(filePath, maxBytes = 500 * 1024 * 1024) {
  const mime = mimeByExtension[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error(`不支持的参考文件格式：${path.extname(filePath)}`);
  const info = await stat(filePath);
  if (!info.isFile() || !info.size) throw new Error('本地参考文件为空');
  if (info.size > maxBytes) throw new Error('本地参考文件超过上传大小上限');
  const bytes = await readFile(filePath);
  if (bytes.length > maxBytes) throw new Error('本地参考文件超过上传大小上限');
  return mediaDataUri(bytes, mime);
}
