import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { trialEnv } from './trial-env.mjs';
import {launchWithUpdate} from './auto-update.mjs';

export async function ensureAgentService(root = path.resolve(import.meta.dirname, '..')) {
  root = fs.realpathSync(root);
  const portable = !fs.existsSync(path.join(root, 'tsconfig.server.json'));
  const env = portable ? trialEnv(root) : { ...process.env };
  const port = Number(env.MANJU_PORT || 5698);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('本机端口无效');
  const base = `http://127.0.0.1:${port}`;
  const data = path.resolve(env.MANJU_DATA_DIR || path.join(root, 'data'));
  const identity = async (expectedVersion) => {
    let response;
    try { response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1200), redirect: 'error' }); }
    catch { return false; }
    if (!response.ok) throw Error('端口已被其他服务使用，请检查万灵漫剧连接设置');
    const health = await response.json();
    const same = value => typeof value === 'string' && path.resolve(value).toLowerCase() === root.toLowerCase();
    if (health.application !== 'wanling-manju' || !same(health.installationRoot) ||
        typeof health.dataDirectory !== 'string' || path.resolve(health.dataDirectory).toLowerCase() !== data.toLowerCase())
      throw Error('端口连接到旧版本、其他安装目录或另一份数据；请关闭对应服务后重新启动');
    if(expectedVersion&&health.version!==expectedVersion)throw Error('新版服务版本校验失败');
    return true;
  };
  if (await identity()) return { root, base, data, reused: true };
  if (!fs.existsSync(path.join(root, 'dist-server/server/index.js'))) throw Error('软件尚未构建，请先运行npm run build');
  fs.mkdirSync(data, { recursive: true });
  const lock = portable ? path.join(root, 'runtime', 'trial-startup-lock.json') : path.join(data, 'agent-startup-lock.json');
  let ownsLock = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); ownsLock = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw Error('启动记录异常，请核对后重试');
        process.kill(owner.pid, 0);
      } catch (ownerError) {
        if (ownerError.code === 'ENOENT') continue;
        if (ownerError.code === 'ESRCH') { fs.unlinkSync(lock); continue; }
        throw ownerError;
      }
      for (let poll = 0; poll < 100; poll++) {
        if (await identity()) return { root, base, data, reused: true };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('软件仍在启动，请查看本机日志后重试');
    }
  }
  if (!ownsLock) throw Error('软件启动记录尚未释放');
  try {
  // Another launcher may have become ready before the lock was acquired.
  if (await identity()) return { root, base, data, reused: true };
  const launch=async expectedVersion=>{
    const log=path.join(data,'agent-service.log'),fd=fs.openSync(log,'a');let child;
    try{child=spawn(process.execPath,[path.join(root,'dist-server/server/index.js')],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});child.on('error',()=>{});child.unref();}
    finally{fs.closeSync(fd);}
    try{
      for(let attempt=0;attempt<100;attempt++){
        if(await identity(expectedVersion))return {root,base,data,reused:false,pid:child.pid};
        if(child.exitCode!==null||child.signalCode!==null)break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error(`本机服务未就绪，请查看 ${log}`);
    }catch(error){if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}throw error;}
  };
  return portable?await launchWithUpdate(root,launch):await launch();
  } finally {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock); } catch {}
  }
}
