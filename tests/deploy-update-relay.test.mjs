import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {publishUpdate} from '../scripts/publish-update.mjs';
import {checkedPublication,stagePublication,RELAY_UPDATE_URL} from '../scripts/deploy-update-relay.mjs';

function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'wanling-relay-publish-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=path.join(base,'source'),channel=path.join(base,'channel'),staged=path.join(base,'staged');
  const put=(file,text)=>{const target=path.join(source,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
  put('release.json','{"version":"0.4.13","storageSchema":6}');put('package.json','{"version":"0.4.13"}');
  put('node_modules/sharp/package.json','{"version":"0.35.5"}');put('dist/index.html','public-ui');put('dist-server/server/index.js','public-server');
  fs.mkdirSync(path.join(source,'adapters'));fs.mkdirSync(path.join(source,'scripts'));
  const release=publishUpdate({source,channelDirectory:channel,keyFile:path.join(base,'private.pem'),version:'0.4.13'});
  return {base,source,channel,staged,release};
}

test('中转上传目录仅包含签名清单列出的程序，不上传额外私有文件',t=>{
  const f=fixture(t),release=path.join(f.channel,'releases/0.4.13');
  fs.writeFileSync(path.join(release,'private-key.pem'),'must-stay-local');
  fs.mkdirSync(path.join(release,'files/runtime'));fs.writeFileSync(path.join(release,'files/runtime/studio.db'),'must-stay-local');
  const result=stagePublication(f.source,f.channel,f.staged);
  assert.equal(result.version,'0.4.13');assert.equal(result.profile.manifestUrl,RELAY_UPDATE_URL);
  assert.equal(fs.existsSync(path.join(f.staged,'releases/0.4.13/private-key.pem')),false);
  assert.equal(fs.existsSync(path.join(f.staged,'releases/0.4.13/files/runtime')),false);
  assert.equal(fs.readFileSync(path.join(f.staged,'releases/0.4.13/files/dist/index.html'),'utf8'),'public-ui');
});

test('上传前拒绝无效签名及被修改的更新文件',t=>{
  const f=fixture(t),feed=path.join(f.channel,'update.json'),original=fs.readFileSync(feed);
  const envelope=JSON.parse(original);envelope.manifest.notes='tampered';fs.writeFileSync(feed,JSON.stringify(envelope));
  assert.throws(()=>checkedPublication(f.source,f.channel),/签名/);
  fs.writeFileSync(feed,original);fs.writeFileSync(path.join(f.channel,'releases/0.4.13/files/dist/index.html'),'tampered');
  assert.throws(()=>stagePublication(f.source,f.channel,f.staged),/修改/);
  assert.equal(fs.existsSync(f.staged),false);
});

test('后续打包命令默认沿用已配置的中转 HTTPS 地址',t=>{
  const f=fixture(t),next=path.join(f.base,'next-channel');
  fs.writeFileSync(path.join(f.source,'update-channel.template.json'),JSON.stringify({manifestUrl:RELAY_UPDATE_URL,publicKey:f.release.client.publicKey,enabled:true}));
  execFileSync(process.execPath,[path.resolve('scripts/publish-update.mjs'),'--source',f.source,'--channel',next,'--key',path.join(f.base,'private.pem')],{windowsHide:true,stdio:'pipe'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(next,'update-channel.json'),'utf8')).manifestUrl,RELAY_UPDATE_URL);
  assert.equal(checkedPublication(f.source,next).profile.publicKey,f.release.client.publicKey);
});
