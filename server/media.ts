import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.js';

export const mediaRoot = path.join(dataDir, 'media');
mkdirSync(mediaRoot, { recursive: true });

export function mediaPath(relative: string): string {
  const resolved = path.resolve(mediaRoot, relative);
  if (!resolved.toLowerCase().startsWith((mediaRoot + path.sep).toLowerCase())) throw new Error('素材路径不在项目目录');
  return resolved;
}

export function relativeMedia(file: string): string {
  const relative = path.relative(mediaRoot, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('素材路径不在项目目录');
  return relative.replace(/\\/g, '/');
}

export async function probe(file: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`无法读取视频：${stderr.slice(0, 300)}`)));
  });
  const info = JSON.parse(output) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  const video = info.streams?.find(stream => stream.codec_type === 'video');
  const duration = Number(info.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw new Error('视频缺少有效画面或时长');
  if (!statSync(file).size) throw new Error('视频文件为空');
  return { duration, width: video.width, height: video.height, hasAudio: Boolean(info.streams?.some(stream => stream.codec_type === 'audio')) };
}

export async function inspectVideo(file: string) {
  const basic = await probe(file);
  const warnings: string[] = [];
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-i', file, '-vf',
      'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-50dB:d=1', '-an', '-f', 'null', '-'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.on('data', data => { output = (output + data.toString()).slice(-20_000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`视频技术检查失败：${output.slice(-300)}`)));
  });
  if (/black_start:/u.test(stderr)) warnings.push('检测到连续黑画面，请人工审看是否符合剧情');
  if (/freeze_start:/u.test(stderr)) warnings.push('检测到静止画面，请人工审看是否符合剧情');
  const stat = statSync(file);
  return { ...basic, warnings, inspectedAt: new Date().toISOString(),
    size: stat.size, modifiedAt: stat.mtimeMs };
}
