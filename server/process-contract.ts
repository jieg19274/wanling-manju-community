import {spawnSync,type ChildProcess} from 'node:child_process';
export function adapterTimeout(defaultMs:number) {
  const requested=Number(process.env.MANJU_ADAPTER_TIMEOUT_MS);
  return Number.isFinite(requested) && requested>=50 && requested<=defaultMs ? requested : defaultMs;
}
export function terminateChild(child:ChildProcess) {
  if(process.platform==='win32' && child.pid) spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000});
  if(child.exitCode===null)child.kill();
}
