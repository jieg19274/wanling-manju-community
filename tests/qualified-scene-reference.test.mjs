import test from 'node:test';
import assert from 'node:assert/strict';
import {makeProject,makeEpisode,makeBeat,makeSegment,auditEpisode} from '../dist-server/shared/model.js';
import {assetInputHash} from '../dist-server/shared/generation.js';
test('qualified current prop covers generic library name but not a separate document or visual-plan-only claim',()=>{
 const p=makeProject('scope','standard'),e=makeEpisode(8,'night'),b={...makeBeat(),event:'案上红封急报，随后查看急报路线',reaction:'',dialogue:[],os:[]},s=makeSegment(b,1);
 const generic={id:'report',kind:'prop',name:'急报',identity:'earlier unrelated report',voice:'',states:[],images:[]},specific={...generic,id:'red-report',name:'红封急报',identity:'current red report'};
 p.assets=[generic,specific];p.episodes=[e];e.scriptBeats=[b];e.segments=[s];s.shotContractVersion=2;s.assetBindings=[{assetId:specific.id,imageId:'main'}];s.subshots=[];
 specific.images=[{id:'main',role:'main',mediaPath:'report.png',inputHash:assetInputHash(p,specific.id),review:{status:'approved'}}];
 const missing=()=>auditEpisode(e,p).some(i=>i.includes('“急报”')&&i.includes('却未绑定'));
 assert.equal(missing(),false);b.event+='；另一份急报放在旁边';assert.equal(missing(),true);
 b.event='查看急报';s.visualPlan='红封急报';assert.equal(missing(),true);
 b.event='红封急报';s.subshots=[{id:'shot',startSec:0,endSec:30,framing:'POV',location:'',action:b.event,evidence:b.event,priorState:'',result:'',endFrame:'',assetIds:[generic.id],lineRefs:{dialogue:[],os:[],floatLabels:[],systemPanels:[]}}];assert.equal(missing(),true);
});
test('qualified bound scene covers generic name only in the actual authoritative scene',()=>{
 const garden='\u540e\u82b1\u56ed',road='\u5764\u5b81\u5bab\u5916\u00b7'+garden+'\u5bab\u9053';
 const p=makeProject('scope','standard'),e=makeEpisode(5,'night'),b={...makeBeat(),event:road,reaction:'',dialogue:[],os:[]},s=makeSegment(b,1);
 const generic={id:'garden',kind:'scene',name:garden,identity:'generic',voice:'',states:[],images:[]},specific={...generic,id:'palace-road',name:road,identity:'specific'};
 p.assets=[generic,specific];p.episodes=[e];e.scriptBeats=[b];e.segments=[s];s.shotContractVersion=2;s.assetBindings=[{assetId:specific.id,imageId:'main'}];s.subshots=[];
 specific.images=[{id:'main',role:'main',mediaPath:'scene.png',inputHash:assetInputHash(p,specific.id),review:{status:'approved'}}];
 const missing=()=>auditEpisode(e,p).some(i=>i.includes(garden)&&i.includes('\u5374\u672a\u7ed1'));
 assert.equal(missing(),false);
 b.event='\u738b\u5e9c'+garden;assert.equal(missing(),true);
 b.event=road;s.assetBindings=[];assert.equal(missing(),true);
});
