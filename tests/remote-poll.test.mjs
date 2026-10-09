import test from 'node:test';
import assert from 'node:assert/strict';
import {pollRemoteTask} from '../adapters/remote-poll.mjs';

test('result recovery retries transient queries of the original task and never submits generation', async () => {
  let time=0, attempts=0;
  const paths=[],states=[];
  const result=await pollRemoteTask({route:'/images/generations/tasks',id:'original/task',maxMs:100000,
    now:()=>time,sleep:async ms=>{time+=ms;},onState:async state=>states.push(state),
    request:async route=>{paths.push(route);attempts++;if(attempts===1)throw Error('fetch failed');if(attempts===2)throw Error('模型接口 HTTP 503');return attempts===3?{status:'in_progress'}:{status:'completed',data:[{url:'result'}]};}});
  assert.equal(result.status,'completed');assert.equal(attempts,4);
  assert.ok(paths.every(p=>p==='/images/generations/tasks/original%2Ftask'));
  assert.deepEqual(states,['in_progress','completed']);
});
test('authorization failures and terminal provider failures stop; query timeout retains the task id', async () => {
  for(const message of ['模型接口 HTTP 401','模型接口 HTTP 403']) {
    let queries=0;
    await assert.rejects(pollRemoteTask({route:'/tasks',id:'original',maxMs:1000,request:async()=>{queries++;throw Error(message);}}),new RegExp(message));
    assert.equal(queries,1);
  }
  await assert.rejects(pollRemoteTask({route:'/tasks',id:'original',maxMs:1000,request:async()=>({status:'failed'})}),/original.*失败/);
  let time=0;
  await assert.rejects(pollRemoteTask({route:'/tasks',id:'keep-original',maxMs:1000,now:()=>time,sleep:async ms=>{time+=ms;},request:async()=>{throw Error('fetch failed');}}),/keep-original.*勿重复付费/);
  assert.equal(time,1000);
});
test('large remote batches bound simultaneous queries while every accepted task remains in flight',async()=>{
  let active=0,maximum=0;
  const results=await Promise.all(Array.from({length:24},(_,index)=>pollRemoteTask({route:'/tasks',id:'accepted-'+index,maxMs:2000,
    request:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,10));active--;return {status:'completed'};}})));
  assert.equal(results.length,24);assert.equal(maximum,8);assert.equal(active,0);
});
