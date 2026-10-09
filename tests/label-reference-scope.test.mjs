import test from'node:test';import assert from'node:assert/strict';import{makeProject,makeEpisode,makeBeat,makeSegment,scriptHash,auditEpisode}from'../dist-server/shared/model.js';
test('identity labels do not summon absent props, while physical actions still require references',()=>{
 const p=makeProject('scope','standard'),e=makeEpisode(1,'hall'),b={...makeBeat(),event:'证人站在厅内侧后方。',reaction:'证人保持安静。',dialogue:[],os:[],floatLabels:['证人｜账页证人'],systemPanels:[]},s=makeSegment(b,1);s.shotContractVersion=2;s.assetBindings=[];s.subshots=[{id:'one',startSec:0,endSec:15,action:'证人站在厅内侧后方。',framing:'POV',assetIds:[],lineRefs:{dialogue:[],os:[],floatLabels:[0],systemPanels:[]}}];e.scriptBeats=[b];e.segments=[s];e.scriptLockedHash=scriptHash(e);p.episodes=[e];p.assets=[{id:'paper',kind:'prop',name:'账页',identity:'单张纸',states:[],images:[]}];
 assert.equal(auditEpisode(e,p).some(x=>x.includes('“账页”却未绑定')),false);
 b.event='证人把账页摊在面前。';e.scriptLockedHash=scriptHash(e);assert.equal(auditEpisode(e,p).some(x=>x.includes('“账页”却未绑定')),true);
});
