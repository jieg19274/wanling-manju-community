import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const [requestFile, outputFile] = process.argv.slice(2);
const request = JSON.parse(await readFile(requestFile, 'utf8'));
if (request.task === 'health') {
  await writeFile(outputFile, JSON.stringify({ ok: true, detail: '视频适配器可运行' }));
  process.exit(0);
}
const duration = Number(request.durationSec) || 30;
await new Promise((resolve, reject) => {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=navy:s=320x180:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputFile],
    { windowsHide: true, stdio: 'ignore' });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('技术视频生成失败')));
});
