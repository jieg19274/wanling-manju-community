import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Release preparation only. The user launcher never downloads or installs tools.
const root = path.resolve('portable-tools');
const cache = path.resolve('.test-temp/runtime-download');
await fs.mkdir(cache, {recursive:true});
await fs.mkdir(root, {recursive:true});
async function download(url, file, hash) {
  let bytes;
  try { bytes = await fs.readFile(file); } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash) {
    const response = await fetch(url, {signal:AbortSignal.timeout(300000)});
    if (!response.ok) throw Error(`Download HTTP ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw Error('Release checksum mismatch: '+url);
    await fs.writeFile(file, bytes);
  }
  console.log('Verified '+path.basename(file));
}
const index = await fetch('https://nodejs.org/download/release/latest-v24.x/SHASUMS256.txt').then(r=>{if(!r.ok)throw Error(r.status);return r.text()});
const nodeMatch = index.match(/^([a-f0-9]{64})\s+(node-v24\.[\d.]+-win-x64\.zip)$/m);
if (!nodeMatch) throw Error('No Node 24 Windows release');
const version=nodeMatch[2].match(/node-(v[\d.]+)-/)[1];
const nodeUrl=`https://nodejs.org/download/release/${version}/${nodeMatch[2]}`;
const nodeZip=path.join(cache,nodeMatch[2]);
await download(nodeUrl,nodeZip,nodeMatch[1]);
const release=JSON.parse(await fs.readFile(path.join(cache,'release.json'),'utf8'));
const asset=release.assets.find(a=>a.name==='ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip');
if (!asset?.digest?.startsWith('sha256:')) throw Error('Missing FFmpeg release digest');
const ffZip=path.join(cache,asset.name);
const useLocal=process.argv.includes('--use-local-ffmpeg');
if(!useLocal)await download(asset.browser_download_url,ffZip,asset.digest.slice(7));
const extract=path.join(cache,'extracted');
await fs.mkdir(extract,{recursive:true});
for(const zip of [nodeZip,...(useLocal?[]:[ffZip])]) {
  if(!await fs.stat(path.join(extract,path.basename(zip,'.zip'))).catch(()=>undefined))execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:MANJU_ARCHIVE -DestinationPath $env:MANJU_EXTRACT -Force'],{env:{...process.env,MANJU_ARCHIVE:zip,MANJU_EXTRACT:extract},windowsHide:true});
}
const nodeSource=path.join(extract,nodeMatch[2].slice(0,-4));
await fs.mkdir(path.join(root,'node'),{recursive:true});
for(const file of ['node.exe','LICENSE'])await fs.copyFile(path.join(nodeSource,file),path.join(root,'node',file));
const installed=useLocal?await fs.realpath(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Command ffmpeg -ErrorAction Stop).Source'],{encoding:'utf8',windowsHide:true}).trim().replace(/^\uFEFF/,'')):undefined;
const ffSource=installed?path.dirname(path.dirname(installed)):path.join(extract,asset.name.slice(0,-4));
if(useLocal&&(!installed.includes('Gyan.FFmpeg.Essentials')||!await fs.stat(path.join(ffSource,'LICENSE')).catch(()=>undefined)))throw Error('Unverified local FFmpeg package');
await fs.cp(ffSource,path.join(root,'ffmpeg'),{recursive:true});
const provenance={preparedAt:new Date().toISOString(),node:{version,url:nodeUrl,sha256:nodeMatch[1]},ffmpeg:useLocal?{version:execFileSync(installed,['-version'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/)[0],source:'Existing Windows WinGet Gyan.FFmpeg.Essentials package',buildRepository:'https://www.gyan.dev/ffmpeg/builds/',sha256:createHash('sha256').update(await fs.readFile(installed)).digest('hex'),distributionMaterialsVerified:false}:{release:release.name,commit:release.target_commitish,url:asset.browser_download_url,sha256:asset.digest.slice(7),buildRepository:'https://github.com/BtbN/FFmpeg-Builds',distributionMaterialsVerified:false}};
await fs.writeFile(path.join(root,'provenance.json'),JSON.stringify(provenance,null,2));
console.log('Portable tools prepared: '+root);
