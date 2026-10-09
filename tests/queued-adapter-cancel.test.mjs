import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';

mkdirSync(path.resolve('.test-temp'),{recursive:true});
const root=mkdtempSync(path.resolve('.test-temp/queued-adapter-cancel-'));
const gates=path.join(root,'release'),eventFile=path.join(root,'events.jsonl');mkdirSync(gates);
Object.assign(process.env,{MANJU_DATA_DIR:path.join(root,'data'),MANJU_BACKUP_DIR:path.join(root,'backups'),
  MANJU_TEXT_CONCURRENCY:'1',MANJU_IMAGE_CONCURRENCY:'1',MANJU_TEST_CONCURRENCY_RELEASE_DIR:gates,
  MANJU_TEST_CONCURRENCY_EVENTS:eventFile});
const model=await import('../dist-server/shared/model.js');
const store=await import('../dist-server/server/store.js');
const {runJsonAdapter,runFileAdapter}=await import('../dist-server/server/adapter-runner.js');
const {cancelQueued}=await import('../dist-server/server/jobs.js');
const adapter=path.resolve('tests/fixtures/gated-concurrency-adapter.mjs');
const project=model.makeProject('本地取消回归','standard'),other=model.makeProject('其他项目','standard');
store.insertProject(project);store.insertProject(other);after(()=>store.db.close());
const events=()=>existsSync(eventFile)?readFileSync(eventFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const starts=key=>events().filter(event=>event.event==='start'&&event.key===key).length;
const release=(lane,key)=>writeFileSync(path.join(gates,`${lane}.${encodeURIComponent(key)}`),'released');
async function wait(check){const end=Date.now()+15000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25));}assert.fail('等待本地适配器超时');}
const row=key=>store.db.prepare("SELECT * FROM adapter_tasks WHERE project_id=? AND json_extract(snapshot,'$.request.key')=? ORDER BY rowid DESC LIMIT 1").get(project.id,key);
const request=(lane,key)=>lane==='text'?runJsonAdapter(adapter,{task:'concurrency-fixture',projectId:project.id,key}):
  runFileAdapter(adapter,{task:'asset-image',projectId:project.id,key},'.png');

for(const lane of ['text','image'])test(`cancel queued ${lane} adapter immediately; preserve FIFO and allow an explicit fresh attempt`,async()=>{
  const first=`${lane}-first`,cancelled=`${lane}-cancelled`,third=`${lane}-third`;
  const pending=[request(lane,first)];
  try{
    await wait(()=>starts(first)===1);
    const second=request(lane,cancelled).then(value=>({value}),error=>({error}));pending.push(second);
    pending.push(request(lane,third));
    assert.equal(row(cancelled).status,'queued');
    assert.throws(()=>cancelQueued(other.id,row(cancelled).id),/只能取消/);
    assert.throws(()=>cancelQueued(project.id,row(first).id),/只能取消/);
    cancelQueued(project.id,row(cancelled).id);
    const outcome=await second;assert.match(outcome.error.message,/已取消/);
    assert.equal(row(cancelled).status,'cancelled');assert.equal(starts(cancelled),0);
    assert.equal(existsSync(row(cancelled).output_path),false);
    release(lane,first);await pending[0];await wait(()=>starts(third)===1);
    assert.equal(starts(cancelled),0);release(lane,third);await pending[2];
    assert.equal(row(cancelled).status,'cancelled');
    const fresh=request(lane,cancelled);pending.push(fresh);await wait(()=>starts(cancelled)===1);
    release(lane,cancelled);await fresh;assert.equal(row(cancelled).status,'completed');
  }finally{[first,cancelled,third].forEach(key=>release(lane,key));await Promise.allSettled(pending);}
});

test('cancellation after a permit is granted still prevents spawning and releases the permit',async()=>{
  const key='cancel-before-spawn',next='after-grant-cancel';
  const pending=request('text',key).then(value=>({value}),error=>({error}));
  assert.equal(row(key).status,'queued');cancelQueued(project.id,row(key).id);
  assert.match((await pending).error.message,/已取消/);
  assert.equal(row(key).status,'cancelled');assert.equal(starts(key),0);
  const fresh=request('text',next);
  try{await wait(()=>starts(next)===1);release('text',next);await fresh;}
  finally{release('text',next);await Promise.allSettled([fresh]);}
});
