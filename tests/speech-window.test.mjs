import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateSpeechEvidence} from '../dist-server/shared/speech-contract.js';

const expected=[
 {id:'os0',kind:'os',text:'姜小满：再来十抽……就十抽。',startSec:0,endSec:3},
 {id:'d0',kind:'dialogue',text:'姜小满：……我只是想抽个卡。',startSec:8,endSec:13},
 {id:'d1',kind:'dialogue',text:'戚少商：借我……躲一躲。',startSec:13,endSec:19},
 {id:'os1',kind:'os',text:'姜小满：这……能抽？',startSec:19,endSec:24},
 {id:'d2',kind:'dialogue',text:'姜小满：先活过今晚再说！',startSec:24,endSec:30},
];
const actual=[[.88,3.16],[12.2,14.02],[17.93,20.35],[22.91,25.01],[28.4,29.74]].map(([startSec,endSec],i)=>({id:expected[i].id,heard:true,speaker:true,startSec,endSec}));
test('a complete line may start after the character reaction inside its assigned shot and finish across the cut',()=>{
 assert.equal(validateSpeechEvidence(expected,actual,30).length,5);
});
test('speech in the previous or following shot is still rejected',()=>{
 for(const startSec of [7.5,13.3])assert.throws(()=>validateSpeechEvidence(expected,actual.map((e,i)=>i===1?{...e,startSec}:e),30),/时间偏移/);
});
test('missing, unheard, wrong-speaker or overlong speech cannot pass',()=>{
 assert.throws(()=>validateSpeechEvidence(expected,actual.slice(1),30),/逐句/);
 for(const field of ['heard','speaker'])assert.throws(()=>validateSpeechEvidence(expected,actual.map((e,i)=>i===2?{...e,[field]:false}:e),30),/声音验收/);
 assert.throws(()=>validateSpeechEvidence(expected,actual.map((e,i)=>i===4?{...e,endSec:30.5}:e),30),/声音验收/);
});
