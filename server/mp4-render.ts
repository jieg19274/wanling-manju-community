import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { terminateChild } from './process-contract.js';
import { probe } from './media.js';

export type RenderClip = {
  file: string; sourceStartUs: number; durationUs: number; speed: number;
  width: number; height: number; hasAudio: boolean; segmentId: string; preview: boolean;
};

async function ffmpeg(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { terminateChild(child); reject(new Error('MP4 合成超时，未发布成片')); }, 45 * 60_000);
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`MP4 合成失败：${stderr.slice(-600)}`));
    });
  });
}

function tempo(speed: number) {
  const factors: number[] = [];
  while (speed > 2) { factors.push(2); speed /= 2; }
  while (speed < 0.5) { factors.push(0.5); speed /= 0.5; }
  return [...factors, speed].map(n => `atempo=${n}`).join(',');
}

// Receives the same audited timeline used by the editing draft exporter.
// No generated voices, subtitles, music or effects are substituted here.
export async function renderMp4(clips: RenderClip[], workDir: string) {
  if (!clips.length) throw new Error('没有可合成的片段');
  for (const clip of clips) {
    if (![clip.sourceStartUs, clip.durationUs, clip.speed, clip.width, clip.height].every(Number.isFinite)
      || clip.sourceStartUs < 0 || clip.durationUs <= 0 || clip.speed < 0.1 || clip.speed > 4
      || clip.width < 2 || clip.height < 2) throw new Error('合成片段的时间、倍速或尺寸无效');
  }
  const canvas = clips.find(clip => !clip.preview) || clips[0];
  const width = Math.floor(canvas.width / 2) * 2, height = Math.floor(canvas.height / 2) * 2;
  mkdirSync(workDir, { recursive: true });
  let expectedDuration = 0;
  for (const [index, clip] of clips.entries()) {
    const start = clip.sourceStartUs / 1e6, sourceDuration = clip.durationUs / 1e6;
    const duration = sourceDuration / clip.speed;
    expectedDuration += duration;
    const input = ['-i', clip.file];
    if (!clip.hasAudio) input.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    const video = `trim=start=${start}:duration=${sourceDuration},setpts=(PTS-STARTPTS)/${clip.speed},` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
    const audio = clip.hasAudio
      ? `atrim=start=${start}:duration=${sourceDuration},asetpts=PTS-STARTPTS,${tempo(clip.speed)},apad,atrim=duration=${duration}`
      : `atrim=duration=${duration},asetpts=PTS-STARTPTS`;
    await ffmpeg([...input, '-map', '0:v:0', '-map', clip.hasAudio ? '0:a:0' : '1:a:0',
      '-vf', video, '-af', audio, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '18', '-threads', '2', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', path.join(workDir, `${index}.mp4`)]);
  }
  // Only generated numeric filenames enter the concat file, never source paths.
  const list = path.join(workDir, 'clips.ffconcat');
  writeFileSync(list, 'ffconcat version 1.0\n' + clips.map((_, i) => `file '${i}.mp4'`).join('\n'));
  const output = path.join(workDir, 'finished.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy', '-movflags', '+faststart', output]);
  const result = await probe(output);
  if (result.width !== width || result.height !== height || !result.hasAudio
    || Math.abs(result.duration - expectedDuration) > 0.15 + clips.length / 20)
    throw new Error('成片的尺寸、声音轨或合成时长不一致，未发布成片');
  return { file: output, ...result, expectedDuration };
}
