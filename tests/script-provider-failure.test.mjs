import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('fresh Opus script requests preserve work on HTTP 503, report unresolved attempts and complete a separate ready request',async t=>{
  if(process.platform!=='win32'){t.skip('Windows 用户密钥保护');return;}
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'manju-script-provider-'));
  process.env.MANJU_DATA_DIR=folder;delete process.env.MANJU_BATCH_BUDGET_PROFILE;
  await import('./network-guard.mjs');
  const seen=[];let failing=true;
  const quote='隔离测试人物打开门并确认同伴安全。';
  const answer={beats:[{sourceQuote:quote,event:quote,reaction:'同伴点头回应。',dialogue:['人物：请进。'],os:['人物：终于安全了。'],floatLabels:['门厅'],systemPanels:['状态：安全']}]};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const bytes of req)raw+=bytes;
    seen.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.setHeader('x-request-id','offline-script-request');
    if(failing){res.writeHead(503).end(JSON.stringify({error:{message:'No available channel for requested model'}}));return;}
    res.end(JSON.stringify({model:'claude-opus-5-5',choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.MANJU_DIRECT_API_BASE_URL=`http://127.0.0.1:${server.address().port}/v1`;
  const model=await import('../dist-server/shared/model.js');
  const provider=await import('../dist-server/server/direct-provider.js');
  const store=await import('../dist-server/server/store.js');
  const {suggestScript}=await import('../dist-server/server/assist.js');
  try{
    provider.saveDirectConfig({apiKey:'offline-script-test-key'});
    const p=provider.applyGlobalModels(model.makeProject('默认模型与503隔离回归','standard')),e=model.makeEpisode(1,'剧本');
    e.sourceText=quote+'同伴点头回应。';e.sourceReviewedHash=model.sourceHash(e);
    e.highlightReport='隔离核对：先开门确认同伴安全，再点头回应。';e.highlightReviewedHash=model.highlightHash(e);
    e.scriptBeats=[{...model.makeBeat(),...answer.beats[0]}];
    e.scriptCandidate={sourceHash:model.sourceHash(e),highlightHash:model.highlightHash(e),beats:structuredClone(e.scriptBeats)};
    p.episodes=[e];store.insertProject(p);const before=JSON.stringify(store.getProject(p.id).episodes[0]);
    assert.equal(p.textModel.modelId,'claude-opus-5-5');
    await assert.rejects(suggestScript(p.id,e.id),error=>{assert.match(error.message,/HTTP 503/);assert.match(error.message,/claude-opus-5-5/);return true;});
    assert.equal(seen.length,1);assert.equal(seen[0].model,'claude-opus-5-5');assert.equal(JSON.stringify(store.getProject(p.id).episodes[0]),before);
    const failed=store.db.prepare('SELECT * FROM adapter_tasks WHERE project_id=?').all(p.id);assert.equal(failed.length,1);
    const receipt=JSON.parse(fs.readFileSync(failed[0].output_path+'.provider-http-receipt.json','utf8'));
    assert.equal(receipt.status,503);assert.equal(receipt.model,'claude-opus-5-5');assert.equal(receipt.requestId,'offline-script-request');
    await assert.rejects(suggestScript(p.id,e.id),/上次相同模型请求的状态尚未确认/);assert.equal(seen.length,1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM adapter_tasks WHERE project_id=?').get(p.id).n,1);
    const next=provider.applyGlobalModels(model.makeProject('另一条已准备请求','standard'));
    const nextEpisode={...structuredClone(e),id:model.id()};next.episodes=[nextEpisode];store.insertProject(next);
    failing=false;await suggestScript(next.id,nextEpisode.id);
    const completed=store.getProject(next.id).episodes[0];assert.equal(seen.length,2);assert.ok(seen.every(r=>r.model==='claude-opus-5-5'));
    assert.deepEqual(completed.scriptBeats,e.scriptBeats);assert.equal(completed.scriptCandidate.beats[0].event,quote);
    assert.deepEqual(completed.scriptCandidate.beats[0].dialogue,answer.beats[0].dialogue);assert.deepEqual(completed.scriptCandidate.beats[0].os,answer.beats[0].os);
    assert.equal(JSON.stringify(store.getProject(p.id).episodes[0]),before);
  }finally{await new Promise(resolve=>server.close(resolve));store.db.close();}
});
