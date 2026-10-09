import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'upscale-settings-'));
process.env.MANJU_DATA_DIR=path.join(root,'data');
const {saveUpscaleSettings,upscaleSettings}=await import('../dist-server/server/upscale-settings.js');
const tool=path.join(root,'中文 工具');
fs.mkdirSync(tool,{recursive:true});
fs.writeFileSync(path.join(tool,'upscale-tool.json'),JSON.stringify({id:'wanling-universal-upscaler',protocolVersion:1,entry:'cli.mjs',version:'1.2.3'}));
fs.writeFileSync(path.join(tool,'cli.mjs'),'console.log(JSON.stringify({protocolVersion:1,ready:true}));');
fs.writeFileSync(path.join(tool,'core.mjs'),'// fixture');
for(const file of ['tools/node/node.exe','tools/ffmpeg/bin/ffmpeg.exe','tools/ffmpeg/bin/ffprobe.exe','tools/realesrgan/realesrgan-ncnn-vulkan.exe','tools/realesrgan/models/realesr-animevideov3-x2.bin','tools/realesrgan/models/realesr-animevideov3-x2.param']){
  const target=path.join(tool,file);fs.mkdirSync(path.dirname(target),{recursive:true});
  if(file.endsWith('node.exe'))fs.copyFileSync(process.execPath,target);else fs.writeFileSync(target,'fixture');
}
test('external tool path survives a fresh process and invalid edits preserve the saved setting',async()=>{
  const saved=await saveUpscaleSettings({toolDirectory:tool});assert.ok(saved.ready);assert.equal(saved.version,'1.2.3');
  await assert.rejects(saveUpscaleSettings({toolDirectory:path.join(root,'missing')}),/完整独立工具/);
  await assert.rejects(saveUpscaleSettings({toolDirectory:'relative'}),/完整目录/);
  assert.equal(upscaleSettings().toolDirectory,tool);
  const moduleUrl=new URL('../dist-server/server/upscale-settings.js',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`const {upscaleSettings}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(upscaleSettings()));`],{env:process.env,windowsHide:true,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const reloaded=JSON.parse(child.stdout.trim());assert.equal(reloaded.toolDirectory,tool);assert.ok(reloaded.ready);
});
test('incompatible tool protocol is rejected and restoring automatic recognition is persistent',async()=>{
  fs.writeFileSync(path.join(tool,'upscale-tool.json'),JSON.stringify({id:'wanling-universal-upscaler',protocolVersion:2,entry:'cli.mjs'}));
  assert.equal(upscaleSettings().ready,false);await assert.rejects(saveUpscaleSettings({toolDirectory:tool}),/完整独立工具/);
  const disconnected=await saveUpscaleSettings({toolDirectory:''});assert.equal(disconnected.ready,false);assert.equal(upscaleSettings().toolDirectory,'');
});
test('storage backup and restore preserve external tool settings without copying account files',()=>{
  const data=path.join(root,'data'),snapshot=path.join(root,'snapshot'),restored=path.join(root,'restored');
  fs.writeFileSync(path.join(data,'upscale-settings.json'),JSON.stringify({toolDirectory:tool}));
  fs.writeFileSync(path.join(data,'provider-account.json'),'test-only account marker');
  const script=new URL('../scripts/storage-maintenance.mjs',import.meta.url);
  const args=['backup',data,snapshot];
  for(const invocation of [args,['restore',snapshot,restored]]){
    const r=spawnSync(process.execPath,[script.pathname.replace(/^\//,'').split('/').map(decodeURIComponent).join('/'),...invocation],{windowsHide:true,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
  assert.equal(fs.readFileSync(path.join(restored,'upscale-settings.json'),'utf8'),fs.readFileSync(path.join(data,'upscale-settings.json'),'utf8'));
  assert.equal(fs.existsSync(path.join(snapshot,'provider-account.json')),false);assert.equal(fs.existsSync(path.join(restored,'provider-account.json')),false);
});
