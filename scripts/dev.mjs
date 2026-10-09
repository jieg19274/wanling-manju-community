import { spawn } from 'node:child_process';

const jobs = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
const stop = () => jobs.forEach(job => job.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(jobs.map(job => new Promise(resolve => job.on('exit', resolve))));
stop();
