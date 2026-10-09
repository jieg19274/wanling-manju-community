import {spawnSync} from 'node:child_process';
import {mkdirSync,readdirSync,existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataDir} from './store.js';
export const backupRoot=path.resolve(process.env.MANJU_BACKUP_DIR || path.join(process.cwd(),'backups'));
export function backups() {
  if(!existsSync(backupRoot))return [];
  return readdirSync(backupRoot).filter(name=>/^snapshot-[0-9]+-[a-f0-9-]+$/.test(name)).map(id=>{
    try {const manifest=JSON.parse(readFileSync(path.join(backupRoot,id,'backup_manifest.json'),'utf8'));return {id,createdAt:manifest.createdAt,mediaIncluded:manifest.mediaIncluded};}catch{return undefined;}
  }).filter(Boolean).reverse();
}
export function backupStorage(withMedia=false) {
  mkdirSync(backupRoot,{recursive:true});
  const id=`snapshot-${Date.now()}-${randomUUID()}`,target=path.join(backupRoot,id);
  const result=spawnSync(process.execPath,[path.resolve('scripts/storage-maintenance.mjs'),'backup',dataDir,target,...(withMedia?['--with-media']:[])],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(result.status!==0)throw new Error(`备份失败：${result.error?.message || result.stderr.slice(-500)}`);
  return {id,directory:target,mediaIncluded:withMedia};
}
export function restoreStorage(id:string) {
  if(!/^snapshot-[0-9]+-[a-f0-9-]+$/.test(id))throw new Error('备份ID无效');
  const target=path.join(backupRoot,`restored-${Date.now()}-${randomUUID()}`);
  const result=spawnSync(process.execPath,[path.resolve('scripts/storage-maintenance.mjs'),'restore',path.join(backupRoot,id),target],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(result.status!==0)throw new Error(`恢复失败：${result.error?.message || result.stderr.slice(-500)}`);
  return {directory:target,activeDataUnchanged:true,message:'已恢复到新目录。关闭本实例后，以MANJU_DATA_DIR指向该目录启动；素材是否齐全以备份清单为准，密钥需单独配置。'};
}
export function runtimePreflight() {
  const tools=['ffmpeg','ffprobe'].map(name=>{
    const result=spawnSync(name,['-version'],{windowsHide:true,encoding:'utf8',timeout:3000,maxBuffer:65536});
    return {name,available:result.status===0,version:result.status===0?result.stdout.split(/\r?\n/)[0]:'',error:result.status===0?'':result.error?.message || '工具无法运行'};
  });
  return {tools,ready:tools.every(tool=>tool.available),dataDirectory:dataDir,backupDirectory:backupRoot,
    draftDirectory:process.env.MANJU_JIANYING_DRAFTS_DIR || '本机剪映默认草稿目录',notes:'可在启动进程环境中指定数据、备份、剪映草稿及超分工具目录；不会修改系统全局设置。'};
}
