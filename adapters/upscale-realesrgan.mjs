import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [requestFile, outputFile] = process.argv.slice(2);
if (!requestFile || !outputFile) throw new Error('用法：node upscale-realesrgan.mjs <request.json> <output.mp4>');
const request = JSON.parse(await readFile(requestFile, 'utf8'));
const source = path.resolve(request.sourcePath), output = path.resolve(outputFile);
if (!existsSync(source)) throw new Error('超分源视频不存在');
if (request.scale !== 2) throw new Error('此适配器只支持真实 2 倍动漫超分');

if(!process.env.MANJU_REALESRGAN_DIR)throw Error('未指定旧版超分目录，请使用软件自动识别的超分组件');
const toolDir = path.resolve(process.env.MANJU_REALESRGAN_DIR);
const executable = path.join(toolDir, process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan');
const models = path.join(toolDir, 'models');
for (const file of [executable, path.join(models, 'realesr-animevideov3-x2.bin'),
  path.join(models, 'realesr-animevideov3-x2.param')]) if (!existsSync(file)) throw new Error(`超分模型文件缺失：${file}`);

async function command(exe, args, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (process.env.MANJU_UPSCALE_LOW_PRIORITY === '1' && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* keep normal priority if unsupported */ }
    }
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(exe)} 超时`)); }, timeoutMs);
    child.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-3000));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} 失败：${stderr}`)); });
  });
}

async function inspect(file) {
  const info = await new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
  const video = info.streams.find(item => item.codec_type === 'video');
  const [numerator, denominator = 1] = String(video?.avg_frame_rate || '').split('/').map(Number);
  const fps = numerator / denominator, duration = Number(info.format.duration);
  if (!video?.width || !video.height || !Number.isFinite(fps) || fps < 1 || fps > 120 || !(duration > 0))
    throw new Error('源视频帧率、尺寸或时长无效');
  return { width: video.width, height: video.height, fps, duration,
    audio: info.streams.some(item => item.codec_type === 'audio') };
}

const original = await inspect(source);
mkdirSync(path.dirname(output), { recursive: true });
const prefix = path.join(path.dirname(output), '.manju-upscale-work-');
const work = mkdtempSync(prefix), inputFrames = path.join(work, 'input'), outputFrames = path.join(work, 'output');
mkdirSync(inputFrames); mkdirSync(outputFrames);
try {
  await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-vsync', '0', path.join(inputFrames, '%08d.png')], 30 * 60_000);
  const frames = readdirSync(inputFrames).filter(name => name.endsWith('.png'));
  if (!frames.length) throw new Error('视频拆帧结果为空');
  await command(executable, ['-i', inputFrames, '-o', outputFrames, '-m', models,
    '-n', 'realesr-animevideov3', '-s', '2', '-t', '128', '-j', '1:1:1', '-f', 'png'], 24 * 60 * 60_000);
  if (frames.some(name => !existsSync(path.join(outputFrames, name)))) throw new Error('超分缺帧');
  await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(original.fps),
    '-i', path.join(outputFrames, '%08d.png'), '-i', source, '-map', '0:v:0', '-map', '1:a?',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-t', String(original.duration), '-movflags', '+faststart', output], 60 * 60_000);
  const result = await inspect(output);
  if (result.width !== original.width * 2 || result.height !== original.height * 2
    || Math.abs(result.duration - original.duration) > Math.max(0.12, 2 / original.fps)
    || result.audio !== original.audio || !statSync(output).size) throw new Error('超分结果的画面、时长或原声不一致');
} finally {
  if (work.startsWith(prefix) && path.dirname(work) === path.dirname(prefix))
    rmSync(work, { recursive: true, force: true });
}
