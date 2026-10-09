import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const original=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'upscale-auto-'));
process.env.MANJU_DATA_DIR=path.join(root,'runtime/data');
const moduleUrl=new URL('../dist-server/server/upscale-settings.js',import.meta.url).href;
const {upscaleSettings,managedUpscaleDirectory,startUpscaleSetup,saveUpscaleSettings}=await import(moduleUrl);
const fixture=directory=>{
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'upscale-tool.json'),JSON.stringify({id:'wanling-universal-upscaler',protocolVersion:1,entry:'cli.mjs',version:'1.0.0'}));
  fs.writeFileSync(path.join(directory,'cli.mjs'),'console.log(JSON.stringify({protocolVersion:1,ready:true}));');
  fs.writeFileSync(path.join(directory,'core.mjs'),'// fixture');
  for(const name of ['tools/node/node.exe','tools/ffmpeg/bin/ffmpeg.exe','tools/ffmpeg/bin/ffprobe.exe','tools/realesrgan/realesrgan-ncnn-vulkan.exe','tools/realesrgan/models/realesr-animevideov3-x2.bin','tools/realesrgan/models/realesr-animevideov3-x2.param']){
    const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});name.endsWith('node.exe')?fs.copyFileSync(process.execPath,file):fs.writeFileSync(file,'fixture');
  }
};
test('startup recognition has no install side effects and a moved portable installation reconnects automatically',async()=>{
  process.chdir(root);
  try{
    assert.equal(upscaleSettings().ready,false);assert.equal(upscaleSettings().setup.status,'idle');
    assert.equal(fs.existsSync(managedUpscaleDirectory()),false);
    const managed=managedUpscaleDirectory();fixture(managed);
    assert.equal(upscaleSettings().ready,false,'partial installation must not become ready');
    fs.writeFileSync(path.join(managed,'setup-complete.json'),JSON.stringify({protocolVersion:2}));assert.equal(upscaleSettings().ready,false);
    fs.writeFileSync(path.join(managed,'setup-complete.json'),JSON.stringify({protocolVersion:1}));
    assert.equal(upscaleSettings().ready,true);assert.equal(upscaleSettings().mode,'auto');
    assert.equal(startUpscaleSetup().setup.status,'ready');assert.equal(fs.existsSync(path.join(managed,'downloads')),false,'ready components must not be downloaded again');
    fs.writeFileSync(path.join(managed,'upscale-tool.json'),JSON.stringify({id:'wanling-universal-upscaler',protocolVersion:1,entry:'cli.mjs',version:'1.1.0'}));assert.equal(upscaleSettings().version,'1.1.0','detect independent component updates');
    const custom=path.join(root,'other');fixture(custom);await saveUpscaleSettings({toolDirectory:custom});assert.equal(upscaleSettings().mode,'custom');
    await saveUpscaleSettings({toolDirectory:''});assert.equal(upscaleSettings().toolDirectory,managed);assert.equal(upscaleSettings().mode,'auto');
    const moved=path.join(root,'中文 移动副本');fs.mkdirSync(moved);fs.cpSync(path.join(root,'runtime'),path.join(moved,'runtime'),{recursive:true});
    const child=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(m.upscaleSettings()));`],{cwd:moved,env:{...process.env,MANJU_DATA_DIR:path.join(moved,'runtime/data')},windowsHide:true,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);const loaded=JSON.parse(child.stdout);assert.equal(loaded.ready,true);assert.equal(loaded.toolDirectory,path.join(moved,'runtime/tools/universal-upscaler'));
  }finally{process.chdir(original);}
});
test('bootstrap refuses wrong archive hashes and busy components without replacing their files',()=>{
  const bad=path.join(root,'bad.zip');fs.writeFileSync(bad,'invalid archive');
  const target=path.join(root,'guard-install');
  const script=path.join(original,'scripts/prepare-upscale.mjs');
  // Source checkouts do not bundle executable runtimes. Supply isolated test
  // fixtures so the test reaches archive verification without using an install.
  const installation=path.join(root,'bootstrap-fixture');fs.mkdirSync(installation);
  fs.cpSync(path.join(original,'extensions'),path.join(installation,'extensions'),{recursive:true});
  for(const file of ['node/node.exe','ffmpeg/bin/ffmpeg.exe','ffmpeg/bin/ffprobe.exe']){
    const destination=path.join(installation,'tools',file);fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.writeFileSync(destination,'unused fixture runtime');
  }
  const call=()=>spawnSync(process.execPath,[script,'--root',installation,'--target',target,'--archive',bad],{windowsHide:true,encoding:'utf8'});
  let child=call();assert.equal(child.status,1);assert.match(child.stdout,/校验失败/);assert.equal(fs.existsSync(path.join(target,'setup-complete.json')),false);assert.equal(fs.existsSync(path.join(target,'.setup.lock')),false);
  fs.mkdirSync(path.join(target,'runtime'));fs.writeFileSync(path.join(target,'runtime/engine.lock'),JSON.stringify({pid:process.pid}));
  fs.writeFileSync(path.join(target,'core.mjs'),'preserve sentinel');child=call();assert.equal(child.status,1);assert.match(child.stdout,/任务正在运行/);assert.equal(fs.readFileSync(path.join(target,'core.mjs'),'utf8'),'preserve sentinel');
});
