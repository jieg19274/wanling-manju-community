import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appPath,hash,verifiedManifest} from './auto-update.mjs';

export const RELAY_UPDATE_URL='https://api.mumugofe.com/docs/wanling-manju/update.json';

export function checkedPublication(source,channelDirectory){
  source=fs.realpathSync(source);channelDirectory=fs.realpathSync(channelDirectory);
  const feed=fs.readFileSync(path.join(channelDirectory,'update.json'));
  const envelope=JSON.parse(feed),profile=JSON.parse(fs.readFileSync(path.join(channelDirectory,'update-channel.json'),'utf8'));
  const manifest=verifiedManifest(source,envelope,profile);
  const release=path.join(channelDirectory,'releases',manifest.version);
  if(fs.lstatSync(release).isSymbolicLink())throw Error('发布目录不能是目录联接');
  const files=path.join(release,'files');
  if(fs.lstatSync(files).isSymbolicLink())throw Error('发布目录不能是目录联接');
  for(const file of manifest.files){
    const payload=fs.readFileSync(appPath(files,file.path));
    if(payload.length!==file.size||hash(payload)!==file.sha256)throw Error('本地发布包已被修改：'+file.path);
  }
  const signed=fs.readFileSync(path.join(release,'release-manifest.json'));
  if(!signed.equals(feed))throw Error('版本清单与发布指针不一致');
  return {version:manifest.version,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.size,0),feed,profile:{...profile,manifestUrl:RELAY_UPDATE_URL}};
}

export function stagePublication(source,channelDirectory,local){
  const checked=checkedPublication(source,channelDirectory),manifest=JSON.parse(checked.feed).manifest;
  fs.mkdirSync(local,{recursive:true});
  fs.writeFileSync(path.join(local,'update.json'),checked.feed);
  fs.writeFileSync(path.join(local,'update-channel.json'),JSON.stringify(checked.profile,null,2));
  const release=path.join(local,'releases',checked.version),files=path.join(release,'files');
  fs.mkdirSync(files,{recursive:true});
  for(const file of manifest.files){
    const target=appPath(files,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(appPath(path.join(channelDirectory,'releases',checked.version,'files'),file.path),target);
  }
  fs.writeFileSync(path.join(release,'release-manifest.json'),checked.feed);
  return checked;
}

export async function deployUpdate() {
  throw new Error('Private relay deployment is not included. Publish the verified update files to your own HTTPS hosting.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.resolve(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  const index = args.indexOf('--channel');
  const channelDirectory = path.resolve(index >= 0 ? args[index + 1] : path.join(source, 'deliverables/update-channel'));
  if (!args.includes('--check')) await deployUpdate();
  const checked = checkedPublication(source, channelDirectory);
  console.log(JSON.stringify({ok: true, version: checked.version, files: checked.files, bytes: checked.bytes}));
}
