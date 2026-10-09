import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const folder = path.resolve('.test-temp');
mkdirSync(folder, { recursive: true });
const guard = pathToFileURL(path.resolve('tests/network-guard.mjs')).href;
const selected=process.argv.slice(2);
if(selected.some(file=>!path.resolve(file).startsWith(path.resolve('tests')+path.sep) || !file.endsWith('.test.mjs'))) throw new Error('仅可选择本项目tests目录下的回归文件');
const isolatedEnv = { ...process.env };
for (const key of Object.keys(isolatedEnv)) if (key.startsWith('MANJU_') || key.startsWith('MUMU_') || key === 'NODE_OPTIONS') delete isolatedEnv[key];
const child = spawn(process.execPath, ['--test', ...(selected.length ? selected : ['tests/*.test.mjs'])], {
  windowsHide: true, stdio: 'inherit', env: { ...isolatedEnv, TEMP: folder, TMP: folder, MANJU_TEST_KEEP_FILES: '1',
    MANJU_DATA_DIR: path.join(folder, 'default-isolated-data'),
    MANJU_DIRECT_API_BASE_URL: 'http://127.0.0.1:1',
    NODE_OPTIONS: `--import=${guard}` },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
