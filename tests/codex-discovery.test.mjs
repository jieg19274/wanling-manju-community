import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {codexCommand} from '../dist-server/server/codex-rpc.js';

test('Windows仅安装桌面版Codex时找到当前受管运行时，保持显式配置优先', {skip:process.platform!=='win32'}, ()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-codex-discovery-'));
  const keys=['APPDATA','LOCALAPPDATA','PATH','MANJU_CODEX_EXECUTABLE'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const executable=(relative,time)=>{
    const file=path.join(folder,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');
    if(time)fs.utimesSync(file,time,time);return file;
  };
  try{
    Object.assign(process.env,{APPDATA:path.join(folder,'roaming'),LOCALAPPDATA:path.join(folder,'local'),PATH:path.join(folder,'empty-path')});
    delete process.env.MANJU_CODEX_EXECUTABLE;
    assert.equal(codexCommand(),undefined);
    const older=executable('local/OpenAI/Codex/bin/old-build/codex.exe',new Date('2026-01-01'));
    assert.deepEqual(codexCommand(),{file:older,args:[]});
    fs.mkdirSync(path.join(folder,'local/OpenAI/Codex/bin/incomplete-build'),{recursive:true});
    const latest=executable('local/OpenAI/Codex/bin/current-build/codex.exe',new Date('2026-10-01'));
    assert.deepEqual(codexCommand(),{file:latest,args:[]});
    const override=executable('explicit/codex.exe');process.env.MANJU_CODEX_EXECUTABLE=override;
    assert.deepEqual(codexCommand(),{file:override,args:[]});
    process.env.MANJU_CODEX_EXECUTABLE=path.join(folder,'missing/codex.exe');
    assert.equal(codexCommand(),undefined);
  }finally{
    for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
