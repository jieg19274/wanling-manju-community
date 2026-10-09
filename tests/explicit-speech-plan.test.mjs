import test from 'node:test';import assert from 'node:assert/strict';
import {makeBeat,makeEpisode,makeSegment,contentHash,composePrompt} from '../dist-server/shared/model.js';
import {speechWindowIssues,shotSpeech} from '../dist-server/shared/prompt-contract.js';
import {speechChecklist} from '../dist-server/shared/speech-contract.js';
const fixture=()=>{
 const b={...makeBeat(),dialogue:['甲：这句话跨过切镜以后还要清楚完整地说完。','乙：听清了。'],os:['甲：接下来再想。'],speechOrder:[{kind:'dialogue',index:0},{kind:'dialogue',index:1},{kind:'os',index:0}]};
 const s=makeSegment(b,2),e=makeEpisode(2,'test');e.scriptBeats=[b];e.segments=[s];
 s.subshots=[{startSec:0,endSec:5,lineRefs:{dialogue:[0],os:[],floatLabels:[],systemPanels:[]}},{startSec:5,endSec:10,lineRefs:{dialogue:[1],os:[],floatLabels:[],systemPanels:[]}},{startSec:10,endSec:15,lineRefs:{dialogue:[],os:[0],floatLabels:[],systemPanels:[]}},{startSec:15,endSec:30,lineRefs:{dialogue:[],os:[],floatLabels:[],systemPanels:[]}}].map((x,i)=>({...x,id:String(i),framing:'中景',action:'保持原事件'}));
 s.speechPlan=[{kind:'dialogue',index:0,startSec:.3,endSec:7.1},{kind:'dialogue',index:1,startSec:7.3,endSec:9},{kind:'os',index:0,startSec:10.1,endSec:12.7}];return{b,s,e};
};
test('explicit within-shot onsets preserve a cross-shot utterance and native checklist',()=>{
 const {b,s,e}=fixture();assert.deepEqual(speechWindowIssues(b,s.subshots,30,s.speechPlan),[]);
 assert.ok(speechWindowIssues(b,s.subshots,30).length,'coarse shot starts incorrectly truncate the first utterance');
 const checklist=speechChecklist(e,s);assert.equal(checklist[1].startSec,7.3);assert.equal(checklist[2].endSec,12.7);
 const prompt=composePrompt(e,s);for(const line of [...b.dialogue,...b.os])assert.ok(prompt.includes(line));assert.match(prompt,/7.3–9秒/);
 const h=contentHash(e,s);s.speechPlan[1].endSec=9.2;assert.notEqual(contentHash(e,s),h);
});
test('explicit plans reject omitted, overlapping, too-fast, misplaced or reordered speech',()=>{
 const {b,s}=fixture();const bad=[s.speechPlan.slice(0,2),s.speechPlan.map((x,i)=>i===1?{...x,startSec:6}:x),s.speechPlan.map((x,i)=>i===0?{...x,endSec:1}:x),s.speechPlan.map((x,i)=>i===1?{...x,startSec:10.2,endSec:11.8}:x),[s.speechPlan[1],s.speechPlan[0],s.speechPlan[2]]];
 for(const p of bad)assert.ok(speechWindowIssues(b,s.subshots,30,p).length);
});
