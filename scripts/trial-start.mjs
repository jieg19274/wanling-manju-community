import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {trialEnv} from './trial-env.mjs';
import {launchWithUpdate} from './auto-update.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 5780;
const url = `http://127.0.0.1:${port}/`;
const autoOpen = !process.argv.includes('--no-open');
const autoShortcut = !process.argv.includes('--no-shortcut');
const normalize = value => process.platform === 'win32'
  ? path.resolve(value).toLowerCase() : path.resolve(value);

async function waitForInterface(child, timeoutMs, expectedVersion) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw Error('软件启动失败，请查看启动窗口中的错误。');
    }
    try {
      const response = await fetch(url + 'api/health', { signal: AbortSignal.timeout(800) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true && health.application==='wanling-manju') {
          if (typeof health.installationRoot!=='string'||normalize(health.installationRoot)!==normalize(root)||typeof health.dataDirectory!=='string'||normalize(health.dataDirectory)!==normalize(path.join(root,'runtime/data'))) {
            throw Error('5780 正由另一份软件占用，请先关闭那份软件后再启动本包。');
          }
          if(expectedVersion&&health.version!==expectedVersion)throw Error('新版启动后的版本校验失败');
          const page = await fetch(url, { signal: AbortSignal.timeout(800) });
          if (page.ok) { await page.body?.cancel(); return; }
        }
      }
    } catch (error) {
      if (error.message.startsWith('5780 正由')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error(child ? '软件未能及时就绪，请检查启动窗口中的错误。'
    : '5780 已被其它程序占用；没有停止其它程序，请先处理端口占用。');
}

const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function ensureDesktopShortcut() {
  if (!autoShortcut || process.platform !== 'win32') return;
  try {
    await new Promise((resolve, reject) => {
      const shortcut = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(root, 'scripts', 'make-trial-shortcut.ps1'), '-OnlyIfNeeded'],
      { windowsHide: true, stdio: 'ignore' });
      shortcut.once('error', reject);
      shortcut.once('exit', code => code === 0 ? resolve() : reject(Error(`shortcut exit ${code}`)));
    });
  } catch {
    console.error('桌面快捷方式创建失败，可稍后双击包内“创建桌面快捷方式.cmd”重试。软件仍会打开。');
  }
}

async function openInterface() {
  if (!autoOpen) return;
  const command = process.platform === 'win32'
    ? powershell
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${url}'`]
    : [url];
  try {
    await new Promise((resolve, reject) => {
      const browser = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
      browser.once('error', reject);
      browser.once('exit', code => code === 0 ? resolve() : reject(Error(`browser exit ${code}`)));
    });
  } catch {
    console.error(`界面已就绪，自动打开浏览器失败。请打开 ${url}`);
  }
}

async function launch() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('试用版需要 Node.js 24 或更高版本');
  if (!fs.existsSync(path.join(root, 'node_modules/sharp/package.json'))) {
    const hasInstaller = fs.existsSync(path.join(root, '准备试用环境.cmd'));
    throw Error(hasInstaller
      ? '缺少运行依赖。请先双击“准备试用环境.cmd”，或按“安装与验收.md”安装依赖后再启动。'
      : `试用包不完整：缺少 node_modules\\sharp\\package.json。请完整解压原压缩包，保留 tools 和 node_modules 后再启动。\n当前软件目录：${root}`);
  }
  const available = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (!available) {
    await waitForInterface(undefined, 5000);
    console.log(`软件已经运行，打开现有界面：${url}`);
    await ensureDesktopShortcut();
    await openInterface();
    return;
  }
  const env = trialEnv(root);
  const startupLock = path.join(root, 'runtime', 'trial-startup-lock.json');
  let ownsStartupLock = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(startupLock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      ownsStartupLock = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ownerAlive = true;
      try {
        const owner = JSON.parse(fs.readFileSync(startupLock, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw Error('Invalid startup lock');
        process.kill(owner.pid, 0);
      } catch (lockError) {
        if (lockError.code === 'ENOENT') continue;
        if (lockError.code === 'ESRCH' || Date.now() - fs.statSync(startupLock).mtimeMs > 30000) ownerAlive = false;
      }
      if (!ownerAlive) { fs.unlinkSync(startupLock); continue; }
      await waitForInterface(undefined, 20000);
      console.log(`软件已经运行，打开现有界面：${url}`);
      await ensureDesktopShortcut();
      await openInterface();
      return;
    }
  }
  if (!ownsStartupLock) throw Error('软件正在启动，请稍后重试。');
  const releaseStartupLock = () => {
    try {
      if (JSON.parse(fs.readFileSync(startupLock, 'utf8')).pid === process.pid) fs.unlinkSync(startupLock);
    } catch {}
  };
  process.once('exit', releaseStartupLock);
  try {
  console.log(`本地试用：${url}\n启动完成后自动打开界面。关闭此启动窗口会停止服务。`);
  let child;
  const stop = () => { if (child&&child.exitCode === null && child.signalCode === null) child.kill(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  process.on('exit', stop);
  await launchWithUpdate(root,async expectedVersion=>{
    process.exitCode=undefined;
    child=spawn(process.execPath,[path.join(root,'dist-server/server/index.js')],{cwd:root,env,windowsHide:true,stdio:'inherit'});
    child.once('error',error=>{console.error(error.message);process.exitCode=1;});
    child.once('exit',code=>{process.exitCode=code??1;});
    try{await waitForInterface(child,20000,expectedVersion);}
    catch(error){stop();if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));throw error;}
  });
  await ensureDesktopShortcut();
  await openInterface();
  } finally {
    releaseStartupLock();
    process.removeListener('exit', releaseStartupLock);
  }
}

await launch().catch(error => { console.error(error.message); process.exitCode = 1; });
