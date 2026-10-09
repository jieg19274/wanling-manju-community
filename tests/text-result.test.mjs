import test from 'node:test';import assert from 'node:assert/strict';import{parseTextResult}from'../adapters/text-result.mjs';
test('semantic bare-list compatibility preserves entries without approving them',()=>{
 const entries=[{beatId:'a',sourceStart:0,sourceEnd:4,notes:'missing proof',highlightIds:[]}];
 assert.deepEqual(parseTextResult(JSON.stringify(entries),'semantic-review'),{entries,warnings:[]});
 assert.deepEqual(parseTextResult(JSON.stringify(entries),'script-beats'),entries);
 assert.throws(()=>parseTextResult('[truncated','semantic-review'));
 assert.deepEqual(parseTextResult('```json\n{"entries":[]}\n```','semantic-review'),{entries:[]});
});
