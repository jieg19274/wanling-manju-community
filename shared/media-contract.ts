import type { Project } from './model.js';
export function expectedResolution(project: Project): string | undefined {
  if (project.videoModel?.capabilities?.outputResolution) return project.videoModel.capabilities.outputResolution;
  if (!/(?:^|[\\/])direct-video\.mjs$/iu.test(project.videoModel?.adapterPath || '')) return undefined;
  const hd = /720p/iu.test(project.videoModel?.modelId || ''), portrait = project.aspectRatio === '9:16';
  return portrait ? hd ? '720x1280' : '1080x1920' : hd ? '1280x720' : '1920x1080';
}
export function validateGeneratedMedia(media: { duration: number; width: number; height: number; hasAudio: boolean }, duration: number, ratio: string, spoken: boolean, resolution?: string): void {
  if (duration !== 30) throw new Error('生成片段必须固定30秒');
  if (!Number.isFinite(media.duration) || Math.abs(media.duration - duration) > 0.15) throw new Error('输出时长不符合固定30秒合同');
  const expected = ratio === '9:16' ? 9 / 16 : ratio === '1:1' ? 1 : 16 / 9;
  if (!media.width || !media.height || Math.abs(media.width / media.height - expected) > 0.02) throw new Error('输出分辨率或画幅不符合合同');
  if (resolution && `${media.width}x${media.height}` !== resolution) throw new Error('输出分辨率不符合生成请求');
  if (spoken && !media.hasAudio) throw new Error('输出缺少对白/OS原声');
}
