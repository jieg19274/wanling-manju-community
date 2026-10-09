import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const location = path.resolve(import.meta.dirname, '..', 'installation.json');
const root = fs.existsSync(location) ? JSON.parse(fs.readFileSync(location, 'utf8')).root :
  ['../../..','../../../..'].map(relative=>path.resolve(import.meta.dirname,relative)).find(candidate=>fs.existsSync(path.join(candidate,'scripts','agent-cli.mjs')));
if(!root)throw Error('请从软件设置下载并安装接管技能');
const script = path.join(root, 'scripts', 'agent-cli.mjs');
if (!fs.existsSync(script)) throw Error('万灵漫剧目录已移动，请在新目录重新安装接管技能');
const bundled = path.join(root, 'tools', 'node', 'node.exe');
const child = spawn(fs.existsSync(bundled) ? bundled : process.execPath, [script, ...process.argv.slice(2)],
  { cwd: root, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
