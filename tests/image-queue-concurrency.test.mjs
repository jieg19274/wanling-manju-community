import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {imageSubmissionPermit} from '../adapters/image-rate-limit.mjs';
const directory=fs.mkdtempSync(path.resolve('.test-temp/image-queue-'));
process.env.MANJU_DATA_DIR=directory;
process.env.MANJU_IMAGE_CONCURRENCY='2';
process.env.MANJU_TEST_QUEUE_EVENTS=path.join(directory,'events.jsonl');
const {makeProject,id}=await import('../dist-server/shared/model.js');
const store=await import('../dist-server/server/store.js');
const {candidatePreview,createCandidates,tickCandidates}=await import('../dist-server/server/candidates.js');
const {wake}=await import('../dist-server/server/jobs.js');
test('native image queue runs bounded concurrent jobs, survives failure, and never repeats or selects candidates',async()=>{
  const p=makeProject('offline concurrent images','standard');
  p.imageModel={name:'offline',modelId:'offline',adapterPath:path.resolve('tests/fixtures/concurrent-image-adapter.mjs')};
  p.assets=Array.from({length:5},(_,index)=>({id:id(),kind:'character',name:index===2?'failed-fixture':'actor-'+index,identity:'same registered identity',voice:'',states:[],images:[]}));
  store.insertProject(p);
  const batches=p.assets.map(a=>{const value={kind:'image',assetId:a.id,role:'turnaround',count:1,feedback:''};const preview=candidatePreview(p.id,value);return createCandidates(p.id,{...value,hash:preview.hash,requestId:id(),confirmed:true});});
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){await tickCandidates();if(store.jobsFor(p.id).filter(j=>j.kind==='image'&&['completed','failed'].includes(j.status)).length===5)break;await new Promise(r=>setTimeout(r,25));}
  const jobs=store.jobsFor(p.id).filter(j=>j.kind==='image');assert.equal(jobs.length,5);assert.equal(jobs.filter(j=>j.status==='completed').length,4);assert.equal(jobs.filter(j=>j.status==='failed').length,1);
  const events=fs.readFileSync(process.env.MANJU_TEST_QUEUE_EVENTS,'utf8').trim().split('\n').map(JSON.parse);
  let active=0,max=0;for(const e of events){active+=e.event==='start'?1:-1;max=Math.max(max,active);}assert.equal(active,0);assert.equal(max,2);
  wake();wake();await tickCandidates();await new Promise(r=>setTimeout(r,100));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n,5);
  assert.equal(store.getProject(p.id).assets.flatMap(a=>a.images).length,4);
  assert.ok(store.getProject(p.id).assets.flatMap(a=>a.images).every(i=>i.role==='turnaround'&&!i.review));
  assert.equal(new Set(batches.flatMap(b=>b.items.map(i=>i.id))).size,5);
});
test('parallel adapter submission permits share one schedule and a damaged schedule stops before submission',async()=>{
  const folder=path.join(directory,'rate-check');const times=[];
  await Promise.all(Array.from({length:3},async()=>{await imageSubmissionPermit(folder);times.push(Date.now());}));
  times.sort();assert.ok(times[1]-times[0]>=3000);assert.ok(times[2]-times[1]>=3000);
  fs.writeFileSync(path.join(folder,'image-submission-rate/next.json'),JSON.stringify({nextAt:'invalid'}));
  await assert.rejects(imageSubmissionPermit(folder),/损坏.*未提交/);
  assert.equal(fs.existsSync(path.join(folder,'image-submission-rate/reservation.lock')),false);
});
