import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
const directory=fs.mkdtempSync(path.resolve('.test-temp/candidate-lock-'));process.env.MANJU_DATA_DIR=directory;
const store=await import('../dist-server/server/store.js'),{tickCandidates}=await import('../dist-server/server/candidates.js');
const batch=(id,status)=>({id,projectId:'offline-fixture',input:{kind:'image',count:1,feedback:''},hash:'fixture',preview:{},items:[{id:id+'-item',status}],createdAt:new Date().toISOString(),cancelled:true});
function insert(value){store.db.prepare('INSERT INTO candidate_batches VALUES(?,?,?,?)').run(value.id,value.projectId,JSON.stringify(value),value.createdAt);}
function read(id){return JSON.parse(store.db.prepare('SELECT payload FROM candidate_batches WHERE id=?').get(id).payload);}
test('unchanged completed batches do not write during background polling',async()=>{
 const value=batch('completed-history','completed');insert(value);store.db.exec('PRAGMA query_only=ON');
 try{await assert.doesNotReject(tickCandidates());assert.deepEqual(read(value.id),value);}finally{store.db.exec('PRAGMA query_only=OFF');}
});
test('a competing SQLite writer defers the tick, preserves stored state, and releases the busy flag',async()=>{
 const value=batch('orphaned-cancelled','running');insert(value);const blocker=new DatabaseSync(path.join(directory,'studio.db'));store.db.exec('PRAGMA busy_timeout=30');blocker.exec('BEGIN IMMEDIATE');
 try{await assert.doesNotReject(tickCandidates());assert.deepEqual(read(value.id),value);}finally{blocker.exec('ROLLBACK');blocker.close();}
 await tickCandidates();assert.equal(read(value.id).items[0].status,'failed');assert.match(read(value.id).items[0].error,/未自动补跑/);assert.equal(store.jobsFor(value.projectId).length,0);
});
