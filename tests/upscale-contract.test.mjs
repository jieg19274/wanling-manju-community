import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,copyFileSync,readdirSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
const root=mkdtempSync(path.join(os.tmpdir(),'manju-upscale-'));process.env.MANJU_DATA_DIR=path.join(root,'data');
const {upscaleIfNeeded}=await import('../dist-server/server/export.js');
const {probe}=await import('../dist-server/server/media.js');
const source=path.join(root,'source.mp4');
let result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=96x54:r=5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',source],{windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
function adapter(mode) {
  const file=path.join(root,`upscale-${mode}.mjs`),size=mode==='small'?'96x54':mode==='ratio'?'240x108':'192x108',duration=mode==='short'?'1':'2';
  writeFileSync(file,`import{spawnSync}from'node:child_process';const args=['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=${size}:r=5',...${JSON.stringify(mode==='mute'?[]:['-f','lavfi','-i','sine=frequency=440:sample_rate=48000'])},'-t','${duration}','-c:v','libx264',...${JSON.stringify(mode==='mute'?[]:['-c:a','aac'])},process.argv[3]];const p=spawnSync('ffmpeg',args,{windowsHide:true});process.exitCode=p.status;`);return file;
}
test('upscale rejects changed duration, missing original audio, wrong dimensions and distorted aspect ratio',async()=>{
  for(const mode of ['short','mute','small','ratio']) {process.env.MANJU_UPSCALE_ADAPTER=adapter(mode);await assert.rejects(upscaleIfNeeded(source,true,false),/超分结果/);}
});
test('valid upscale cache is reused and corrupt cache is retained before regeneration',async()=>{
  process.env.MANJU_UPSCALE_ADAPTER=adapter('valid');const output=await upscaleIfNeeded(source,true,false);assert.ok(existsSync(output));
  assert.equal(await upscaleIfNeeded(source,true,false),output);copyFileSync(source,output);
  assert.equal(await upscaleIfNeeded(source,true,false),output);assert.ok(readdirSync(path.dirname(output)).some(file=>file.includes('.invalid-')));
  const media=await probe(output);assert.equal(media.width,192);assert.equal(media.height,108);assert.ok(media.hasAudio);
});
test('upscale watchdog stops a stuck adapter without publishing a cache result',async()=>{
  const file=path.join(root,'upscale-stuck.mjs');writeFileSync(file,'setInterval(()=>{},1000);');process.env.MANJU_UPSCALE_ADAPTER=file;process.env.MANJU_ADAPTER_TIMEOUT_MS='100';
  try {await assert.rejects(upscaleIfNeeded(source,true,false),/超时/);}finally{delete process.env.MANJU_ADAPTER_TIMEOUT_MS;}
});
