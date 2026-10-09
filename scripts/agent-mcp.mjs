import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureAgentService } from './agent-service.mjs';
import { trialEnv } from './trial-env.mjs';
import fs from 'node:fs';
const root = path.resolve(import.meta.dirname, '..');
await ensureAgentService(root);
const env = fs.existsSync(path.join(root, 'tsconfig.server.json')) ? process.env : trialEnv(root);
const child = spawn(process.execPath, [path.join(root, 'dist-server/server/mcp.js')],
  { cwd: root, env, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
