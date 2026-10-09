import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {readJsonBody,RequestBodyError} from '../dist-server/server/http-body.js';
import {MAX_SOURCE_CHARACTERS,MAX_SOURCE_FILE_BYTES,MAX_JSON_BODY_BYTES} from '../dist-server/shared/source-limits.js';

const root=mkdtempSync(path.join(os.tmpdir(),'manju-source-save-'));
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^MANJU_|^MUMU_/i.test(key)));
const packageRoot=process.env.MANJU_TEST_PACKAGE_ROOT?path.resolve(process.env.MANJU_TEST_PACKAGE_ROOT):process.cwd();
const node=process.env.MANJU_TEST_PACKAGE_ROOT?path.join(packageRoot,'tools/node/node.exe'):process.execPath;
const child=spawn(node,[path.join(packageRoot,'dist-server/server/index.js')],{cwd:packageRoot,windowsHide:true,stdio:'ignore',env:{...env,MANJU_PORT:String(port),MANJU_DATA_DIR:path.join(root,'data'),MANJU_BACKUP_DIR:path.join(root,'backups'),MANJU_JIANYING_DRAFTS_DIR:path.join(root,'drafts'),MANJU_DIRECT_API_BASE_URL:'http://127.0.0.1:1'}});
after(async()=>{child.kill();if(child.exitCode===null)await once(child,'exit');});
const base=`http://127.0.0.1:${port}`;
async function api(route,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
for(let i=0;;i++){try{if((await api('/api/health')).data.ok)break;}catch{}if(i>200)throw Error('isolated server did not start');await new Promise(resolve=>setTimeout(resolve,30));}
const project=(await api('/api/projects',{name:'全文保存离线回归',mode:'standard'})).data;
const route=`/api/projects/${project.id}/actions`;
function splitRequest(url,payload,split,headers={}){
  return new Promise((resolve,reject)=>{
    const request=http.request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers}},response=>{
      const chunks=[];response.on('data',c=>chunks.push(c));response.on('error',reject);
      response.on('end',()=>{try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
    });request.on('error',reject);request.write(payload.subarray(0,split));setTimeout(()=>request.end(payload.subarray(split)),30);
  });
}

test('actual source save preserves Chinese and emoji across network chunks and reload',async()=>{
  const source='第一章\r\n中文😀全文边界验证\r\n保留空格  与换行\n';
  const payload=Buffer.from(JSON.stringify({type:'project.source',sourceText:source}));
  for(const char of ['中','😀']){
    const result=await splitRequest(base+route,payload,payload.indexOf(Buffer.from(char))+1,{'Content-Length':payload.length});
    assert.equal(result.status,200);assert.equal(result.data.sourceCorpus,source);
    const reloaded=await api(`/api/projects/${project.id}/view?source=1`);
    assert.equal(reloaded.data.sourceCorpus,source);
  }
});

test('valid full source with an escaped JSON body over the old 8M limit saves exactly',async()=>{
  const source='中\n'.repeat(2_700_000);
  assert.ok(source.length<MAX_SOURCE_CHARACTERS);
  assert.ok(Buffer.byteLength(source)<MAX_SOURCE_FILE_BYTES);
  assert.ok(JSON.stringify({type:'project.source',sourceText:source}).length>8_000_000);
  const result=await api(route,{type:'project.source',sourceText:source});
  assert.equal(result.status,200);assert.equal(result.data.sourceCorpus,source);
  assert.equal((await api(`/api/projects/${project.id}/view?source=1`)).data.sourceCorpus,source);
});

test('a rejected oversized source or invalid UTF-8 leaves the previous source intact',async()=>{
  const source='完整原文保持不变';await api(route,{type:'project.source',sourceText:source});
  const rejected=await api(route,{type:'project.source',sourceText:'字'.repeat(MAX_SOURCE_CHARACTERS+1)});
  assert.equal(rejected.status,400);assert.match(rejected.data.error,/700 万字符/);
  const invalid=Buffer.concat([Buffer.from('{"type":"project.source","sourceText":"'),Buffer.from([0xe4,0x22]),Buffer.from('}')]);
  const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:invalid});
  assert.equal(response.status,400);assert.match((await response.json()).error,/UTF-8/);
  assert.equal((await api(`/api/projects/${project.id}/view?source=1`)).data.sourceCorpus,source);
  assert.equal((await api('/api/health')).data.ok,true);
});

test('body limit returns readable 413 for declared and chunked overflow without stopping the service',async()=>{
  const server=http.createServer(async(req,res)=>{
    try{const value=await readJsonBody(req,1024);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
    catch(error){res.writeHead(error instanceof RequestBodyError?error.status:500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const payload=Buffer.from(JSON.stringify({text:'x'.repeat(2048)}));
    for(const headers of [{},{'Content-Length':payload.length}]){
      const result=await splitRequest(url,payload,1500,headers);
      assert.equal(result.status,413);assert.match(result.data.error,/请求内容过大/);
    }
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ok":true}'});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
    // Worst-case JSON escaping of a legal source still fits the transport cap.
    assert.ok(MAX_JSON_BODY_BYTES>MAX_SOURCE_CHARACTERS*6);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
