import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

test('重启检查覆盖没有生成队列的Codex会话、工作流和文本适配器，兼容旧数据库',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-active-check-'));
  const file=path.join(folder,'studio.db');
  const check=()=>{
    const result=spawnSync(process.execPath,['scripts/check-studio-active.cjs',file],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);return Number(result.stdout);
  };
  assert.equal(check(),0);
  const db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE jobs(status TEXT);');assert.equal(check(),0);
    db.exec("INSERT INTO jobs VALUES('queued');");assert.equal(check(),1);
    db.exec("UPDATE jobs SET status='completed';CREATE TABLE studio_runs(payload TEXT);INSERT INTO studio_runs VALUES('{\"status\":\"starting\"}');");
    assert.equal(check(),1);
    db.exec("UPDATE studio_runs SET payload='{\"status\":\"running\"}';");assert.equal(check(),1);
    db.exec("UPDATE studio_runs SET payload='{\"status\":\"interrupted\"}';CREATE TABLE agent_workflows(payload TEXT);INSERT INTO agent_workflows VALUES('{\"status\":\"running\"}');");
    assert.equal(check(),1);
    db.exec("UPDATE agent_workflows SET payload='{\"status\":\"waiting_review\"}';CREATE TABLE adapter_tasks(status TEXT);INSERT INTO adapter_tasks VALUES('running');");
    assert.equal(check(),1);
    db.exec("UPDATE adapter_tasks SET status='completed';");assert.equal(check(),0);
  }finally{db.close();}
});

test('Windows独立启动器保留中文、空格目录的完整脚本路径',{skip:process.platform!=='win32'},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju launcher 中文 '));
  const serverFile=path.join(folder,'harmless.mjs'),marker=path.join(folder,'started.json');
  fs.writeFileSync(serverFile,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv[1]));`);
  const launchLine=fs.readFileSync('scripts/start-standalone.ps1','utf8').split(/\r?\n/).find(line=>line.startsWith('Start-Process -FilePath $node -ArgumentList'));
  assert.ok(launchLine,'启动器必须包含实际进程启动指令');
  const quoted=value=>"'"+value.replaceAll("'","''")+"'";
  const script=`$ErrorActionPreference='Stop';$node=${quoted(process.execPath)};$studioRoot=${quoted(folder)};$serverFile=${quoted(serverFile)};${launchLine} -PassThru -Wait | Out-Null`;
  const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.ok(fs.existsSync(marker),'包含空格的脚本必须实际执行');
  assert.equal(JSON.parse(fs.readFileSync(marker,'utf8')),serverFile);
});
