import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {longJsonRequest} from '../adapters/long-http.mjs';

test('waits for delayed completion headers and retains full response',async()=>{
  const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({echo:JSON.parse(body),complete:true}));},100);
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const r=await longJsonRequest(new URL(`http://127.0.0.1:${server.address().port}/chat`),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"sample":"完整原文"}',timeoutMs:1000});
    assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.raw),{echo:{sample:'完整原文'},complete:true});
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('deadline stops one request without automatic resubmission',async()=>{
  let calls=0;const server=http.createServer(()=>calls++);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    await assert.rejects(longJsonRequest(new URL(`http://127.0.0.1:${server.address().port}/chat`),{method:'POST',headers:{},timeoutMs:60}),/远端状态未明/);
    assert.equal(calls,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('redirect response is returned without following another destination',async()=>{
  let calls=0;const server=http.createServer((req,res)=>{calls++;res.writeHead(302,{Location:'/other'});res.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const r=await longJsonRequest(new URL(`http://127.0.0.1:${server.address().port}/chat`),{method:'POST',headers:{},timeoutMs:1000});
    assert.equal(r.status,302);assert.equal(r.ok,false);assert.equal(calls,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
