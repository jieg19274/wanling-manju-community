import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';
const dir=fs.mkdtempSync(path.resolve('.test-temp/asset-response-'));process.env.MANJU_DATA_DIR=dir;
const model=await import('../dist-server/shared/model.js'),store=await import('../dist-server/server/store.js'),{suggestAssets}=await import('../dist-server/server/assist.js');
test('completed asset response can recover sourceQuote evidence without paid retry; stale and foreign responses rejected',async()=>{
 const p=model.makeProject('recovery','standard'),e=model.makeEpisode(1,'source');p.episodes=[e];p.textModel={name:'mock',modelId:'mock',adapterPath:path.resolve('tests/fixtures/video-adapter.mjs')};
 e.sourceText='苏怜月端着酒杯来到你面前。';e.scriptBeats=[{...model.makeBeat(),sourceQuote:e.sourceText,event:'苏怜月端酒来到主角面前。',reaction:'主角按杯沿。'}];e.scriptLockedHash=model.scriptHash(e);store.insertProject(p);
 const request={task:'asset-extract',projectId:p.id,model:'mock',beats:e.scriptBeats,existingAssets:[]},file=path.join(dir,'returned.json'),id=model.id();fs.writeFileSync(file,JSON.stringify({assets:[{kind:'character',name:'苏怜月',identity:'琴师',voice:'清晰女声',evidence:e.sourceText}]}));
 store.db.prepare('INSERT INTO adapter_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,p.id,'asset-extract','saved',JSON.stringify({adapter:p.textModel.adapterPath,request}),'completed',file,null,model.now(),model.now());
 const count=store.db.prepare('SELECT COUNT(*) n FROM adapter_tasks').get().n;assert.deepEqual(await suggestAssets(p.id,e.id,id),{assets:1});assert.equal(store.getProject(p.id).episodes[0].assetCandidate.entries[0].evidence,e.sourceText);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM adapter_tasks').get().n,count);
 await assert.rejects(suggestAssets(p.id,e.id,'foreign'));
 store.updateProject(p.id,x=>x.textModel.modelId='changed');await assert.rejects(suggestAssets(p.id,e.id,id),/differs/);
});
