import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestJson} from '../dist-server/shared/local-api.js';

test('network failure reports how to restart the local service and never replays the operation',async()=>{
  const calls=[];
  const request=async(path,options)=>{calls.push({path,method:options?.method||'GET'});throw new TypeError('Failed to fetch');};
  await assert.rejects(requestJson('/api/projects/project/actions',{method:'POST',body:'source'},request),/无法连接本机服务.*桌面快捷方式/);
  assert.deepEqual(calls,[{path:'/api/projects/project/actions',method:'POST'},{path:'/api/health',method:'GET'}]);
});
test('lost response with a healthy server asks to verify the result instead of claiming it failed to save',async()=>{
  const calls=[];
  const request=async(path,options)=>{calls.push({path,method:options?.method||'GET'});if(path==='/api/health')return Response.json({ok:true});throw new TypeError('Failed to fetch');};
  await assert.rejects(requestJson('/api/projects/project/actions',{method:'POST'},request),/确认保存结果/);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('backend rejection preserves its useful message without a health probe',async()=>{
  let calls=0;
  await assert.rejects(requestJson('/api/projects/project/actions',{method:'POST'},async()=>{calls++;return Response.json({error:'原文超过单次 700 万字符限制'},{status:400});}),/700 万字符/);
  assert.equal(calls,1);
});
test('unreadable response diagnoses connection once and a failed health request does not recurse',async()=>{
  let calls=0;
  await assert.rejects(requestJson('/api/projects',{method:'GET'},async(path)=>{calls++;return path==='/api/health'?Response.json({ok:true}):new Response('<html>unexpected</html>');}),/未收到.*完整响应/);
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(requestJson('/api/health',{},async()=>{calls++;throw Error('offline');}),/无法连接本机服务/);
  assert.equal(calls,1);
});
