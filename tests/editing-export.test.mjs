import test from 'node:test';import assert from 'node:assert/strict';
import {editingSelection,installedDraftsRoot,installedDraftIndexRoot} from '../dist-server/server/export.js';
import path from 'node:path';
test('configured Jianying storage is independent of its registry and portable output',()=>{
 const prior=process.env.MANJU_JIANYING_INSTALLED_DRAFTS_DIR,portable=process.env.MANJU_JIANYING_DRAFTS_DIR;
 try{process.env.MANJU_JIANYING_INSTALLED_DRAFTS_DIR=path.resolve('.test-temp/actual-jianying-storage');process.env.MANJU_JIANYING_DRAFTS_DIR=path.resolve('.test-temp/portable');assert.equal(installedDraftsRoot(),path.resolve('.test-temp/actual-jianying-storage'));assert.notEqual(installedDraftIndexRoot(),installedDraftsRoot());delete process.env.MANJU_JIANYING_INSTALLED_DRAFTS_DIR;assert.equal(installedDraftsRoot(),installedDraftIndexRoot());}finally{if(prior===undefined)delete process.env.MANJU_JIANYING_INSTALLED_DRAFTS_DIR;else process.env.MANJU_JIANYING_INSTALLED_DRAFTS_DIR=prior;if(portable===undefined)delete process.env.MANJU_JIANYING_DRAFTS_DIR;else process.env.MANJU_JIANYING_DRAFTS_DIR=portable;}
});
test('editing selection preserves adoption and never rewrites pending/rejected review history',()=>{
 const accepted={id:'accepted',kind:'video',mediaPath:'a.mp4',review:{status:'rejected'},userAcceptance:{status:'accepted'}};
 const pending={id:'pending',kind:'video',mediaPath:'b.mp4'};
 const episode={segments:[{id:'s2',number:2,selected:{},artifacts:[pending]},{id:'s1',number:1,selected:{video:'accepted'},artifacts:[accepted,{id:'old',kind:'video',mediaPath:'old.mp4'}]}]};
 const before=JSON.stringify(episode),picked=editingSelection(episode,{s2:'pending'});assert.deepEqual(picked.map(x=>x.video.id),['accepted','pending']);assert.equal(JSON.stringify(episode),before);
 assert.throws(()=>editingSelection(episode),/explicitly select/);assert.throws(()=>editingSelection(episode,{s1:'old',s2:'pending'}),/adopted/);assert.throws(()=>editingSelection(episode,{foreign:'pending'}),/Unknown/);
});
test('editing output refuses demo, withdrawn and rejected candidates without human acceptance',()=>{
 for(const extra of [{demo:true},{userAcceptance:{status:'withdrawn'}},{review:{status:'rejected'}}]){
  const episode={segments:[{id:'s',number:1,selected:{},artifacts:[{id:'v',kind:'video',mediaPath:'v.mp4',...extra}]}]};assert.throws(()=>editingSelection(episode,{s:'v'}),/non-rejected/);
 }
});
