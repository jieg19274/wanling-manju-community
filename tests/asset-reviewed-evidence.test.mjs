import test from 'node:test';import assert from 'node:assert/strict';import{reviewedAssetEvidence}from'../dist-server/shared/asset-evidence.js';
test('state recovery must cite its own locked beat and keeps the rejected model wording',()=>{
 const first='你扣住持刀手腕推向石栏，刀尖被迫朝下。',third='李承安双手交刀，单膝跪下。',original='李承安没有再刺，双手交刀，单膝跪下。';
 assert.deepEqual(reviewedAssetEvidence(original,third,third),{evidence:third,modelEvidence:original});assert.throws(()=>reviewedAssetEvidence(original,first,third));assert.throws(()=>reviewedAssetEvidence(original,third,'李承安逃离宫道。'));
});
test('reviewed punctuation correction is an exact existing excerpt and retains original model evidence',()=>{
 const source='转场至坤宁宫外后花园宫道，你沿灯火走出、身后宫门合拢，一名黑衣刺客扑出。',model='转场至坤宁宫外后花园宫道，你沿灯火走出、身后宫门合拢。',literal='转场至坤宁宫外后花园宫道，你沿灯火走出、身后宫门合拢';
 assert.throws(()=>reviewedAssetEvidence(model,source));assert.deepEqual(reviewedAssetEvidence(model,source,literal),{evidence:literal,modelEvidence:model});assert.throws(()=>reviewedAssetEvidence(model,source,'宫道上皇后出现'));
});
