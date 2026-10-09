import test from 'node:test';import assert from 'node:assert/strict';
import {staticCharacterAnchor,shotSpeech,speechWindowIssues,characterReferenceBoundary,screenTextBoundary,visibleInformationBlock,visibleInformationIssues} from '../dist-server/shared/prompt-contract.js';
import {makeBeat,makeSegment,makeEpisode,composePrompt,selectedPromptContractIssues,contentHash,validMentionOnly,makeProject,videoReferences} from '../dist-server/shared/model.js';
import {assetInputHash} from '../dist-server/shared/generation.js';
test('historical action fragments cannot become reusable character anchors',()=>{
 assert.equal(staticCharacterAnchor('绣娘，清秀女子，被纨绔攥住手腕，绣篮翻倒在地。'),'绣娘，清秀女子，');
});
test('saved prompt missing actual shot-scope rules is blocked without changing retained artifacts',()=>{
 const b={...makeBeat(),event:'侍女递帖',dialogue:['侍女：请看请帖。'],os:[]},s=makeSegment(b,3),e=makeEpisode(1,'saved');e.scriptBeats=[b];e.segments=[s];
 const old={id:'old',kind:'prompt',content:composePrompt(e,s).replace(/^【逐镜参考范围】[^\n]+/mu,''),sourceHash:contentHash(e,s)};s.artifacts=[old];s.selected.prompt='old';const snapshot=JSON.stringify(old);
 assert.ok(selectedPromptContractIssues(e,s).some(x=>x.includes('逐镜参考范围')));assert.equal(JSON.stringify(old),snapshot);
 const fresh={...old,id:'fresh',content:composePrompt(e,s)};s.artifacts.push(fresh);s.selected.prompt='fresh';assert.ok(!selectedPromptContractIssues(e,s).some(x=>x.includes('逐镜参考范围')));assert.equal(JSON.stringify(old),snapshot);
});
test('cross-shot speech continues once and insufficient onset window is detected',()=>{
 const b={...makeBeat(),dialogue:['侍女：王爷，苏姑娘请您去醉仙楼。她说，王公子的胆子，有人撑。'],os:['你·OS：儿子敢抢，老子敢护。今晚，看谁先低头。']},s=makeSegment(b,3);
 const shots=[{startSec:15,endSec:20,lineRefs:{dialogue:[0],os:[],floatLabels:[],systemPanels:[]}},{startSec:20,endSec:24,lineRefs:{dialogue:[],os:[],floatLabels:[],systemPanels:[]}},{startSec:24,endSec:30,lineRefs:{dialogue:[],os:[0],floatLabels:[],systemPanels:[]}}];
 assert.match(shotSpeech(b,shots,1,'dialogue',s),/承接前镜.*24秒/);assert.doesNotMatch(shotSpeech(b,shots,1,'dialogue',s),/无（/);
 assert.deepEqual(speechWindowIssues(b,shots,30),[]);assert.ok(speechWindowIssues(b,[...shots.slice(0,1),{...shots[2],startSec:18}],30).length);
 const e=makeEpisode(1,'cross-shot');e.scriptBeats=[b];e.segments=[s];s.subshots=shots.map((shot,i)=>({...shot,id:String(i),framing:'POV',action:'递请帖'}));
 assert.match(composePrompt(e,s),/【对白】无新台词；承接前镜已开始的对白，最迟24秒前结束/);
});
test('compiled prompt separates shot scope and removes obsolete anchor actions without removing formal plot',()=>{
 const b={...makeBeat(),event:'前段被纨绔攥住手腕，本段已经松开；侍女递请帖。',dialogue:['侍女：王爷请看请帖。'],os:[]},s=makeSegment(b,3),e=makeEpisode(1,'test');e.scriptBeats=[b];e.segments=[s];
 const prompt=composePrompt(e,s,[],[{assetId:'ax',name:'阿绣',kind:'character',identity:'绣娘，被纨绔攥住手腕',voice:'女声'}]);
 assert.match(prompt,/逐镜参考范围/);assert.match(prompt,/本段已经松开/);assert.doesNotMatch(prompt,/【角色锚点】阿绣；绣娘，被/);assert.match(prompt,/侍女：王爷请看请帖。/);
});
test('visible information declares all four categories and preserves every locked label and system line',()=>{
 const b={...makeBeat(),floatLabels:['人物：陆贤·流放罪奴','场景：驿站','时间：翌日','设定：身份被揭示','未分类但已锁定的原句'],systemPanels:['任务奖励：10抽卡点。']};
 const block=visibleInformationBlock(b);
 for(const label of ['人物浮签','场景浮签','时间浮签','设定/系统浮签'])assert.ok(block.includes(label));
 for(const line of [...b.floatLabels,...b.systemPanels])assert.ok(block.includes(line));
 assert.deepEqual(visibleInformationIssues(b,block),[]);
 const empty=visibleInformationBlock({...b,floatLabels:[],systemPanels:[]});
 assert.match(empty,/人物浮签（模型直出）：无/);assert.match(empty,/场景浮签（模型直出）：无/);
 assert.match(empty,/时间浮签（模型直出）：无/);assert.match(empty,/设定\/系统浮签：无/);
});

test('screen boundary retains formal scene, time and setting labels without allowing dialogue subtitles',()=>{
 const boundary=screenTextBoundary();
 for(const text of ['人物浮签','场景浮签','时间浮签','设定/系统浮签','系统面板'])assert.ok(boundary.includes(text));
 assert.ok(boundary.includes('禁止自动添加对白字幕、OS字幕'));
 const b={...makeBeat(),dialogue:['甲：先问。','乙：再答。'],os:['甲：然后想。']},s=makeSegment(b,1),e=makeEpisode(1,'sequential');e.scriptBeats=[b];e.segments=[s];
 const prompt=composePrompt(e,s);
 assert.ok(prompt.includes('两个人物问答按各自明确时间先后进行，不同时抢话'));
 assert.ok(!prompt.includes('有台词的镜头只能从该子镜起点开始'));
});

test('an explicitly reviewed prop mention needs source evidence and cannot hide a bound or shot-used prop',()=>{
 const b={...makeBeat(),event:'陆提出搭赠稻种，尚未取得。'},s=makeSegment(b,2),a={id:'seed',name:'稻种',kind:'prop',identity:'普通种'};
 s.mentionOnlyAssets=[{assetId:a.id,sourceEvidence:'搭赠稻种',reason:'当前只讨论搭赠条件，稻种实体未取出。'}];
 assert.ok(validMentionOnly(s,b,a));
 s.assetBindings=[{assetId:a.id}];assert.ok(!validMentionOnly(s,b,a));
 s.assetBindings=[];s.subshots=[{assetIds:[a.id]}];assert.ok(!validMentionOnly(s,b,a));
});

test('a within-segment state change passes both complete sheets and rejects an unreviewed prior image',()=>{
 const p=makeProject('transition','comic-drama'),e=makeEpisode(1,'unlock'),b={...makeBeat(),event:'陆先戴镣，再开镣。'},s=makeSegment(b,9);
 e.scriptBeats=[b];e.segments=[s];p.episodes=[e];
 const a={id:'lu',kind:'character',name:'陆贤',identity:'同一病弱陆贤',voice:'青年男声',states:[{id:'after',label:'解镣',appearance:'空腕',trigger:'再开镣',startEpisode:1,startSegment:9}],images:[]};p.assets=[a];
 for(const [id,stateId] of [['before',undefined],['current','after']])a.images.push({id,stateId,role:'turnaround',layout:'three-view-portrait',mediaPath:id+'.png',review:{status:'approved'},inputHash:assetInputHash(p,a.id,stateId)});
 s.assetBindings=[{assetId:a.id,stateId:'after',imageId:'current',priorReference:{imageId:'before',untilSec:7,sourceEvidence:'再开镣'}}];
 const refs=videoReferences(p,e,s);assert.deepEqual(refs.map(r=>r.imageId),['before','current']);assert.ok(refs.every(r=>r.referenceLayout==='three-view-portrait'));assert.match(refs[0].temporalScope,/同一个角色/);
 a.images[0].review.status='rejected';assert.throws(()=>videoReferences(p,e,s),/变化前参考无效/);
});
test('current input hash cannot make a legacy reference or incomplete visible-information prompt pass; artifacts remain unchanged',()=>{
 const b={...makeBeat(),event:'陆贤跪着读规则。',floatLabels:['人物：陆贤·罪奴'],systemPanels:['奖励：20抽卡点。']},s=makeSegment(b,3),e=makeEpisode(1,'legacy contracts');e.scriptBeats=[b];e.segments=[s];
 const fresh=composePrompt(e,s),old={id:'legacy',kind:'prompt',sourceHash:contentHash(e,s),content:fresh.replace(characterReferenceBoundary(),'【参考图使用】人物头部特写只锁定头部身份。').replace(visibleInformationBlock(b),'【可见信息层】\n浮签（模型直出）：'+b.floatLabels[0]+'\n系统面板（模型直出）：'+b.systemPanels[0])};
 s.artifacts=[old];s.selected.prompt=old.id;const before=JSON.stringify(old),issues=selectedPromptContractIssues(e,s);
 assert.ok(issues.some(x=>x.includes('完整四视图参考合同')));assert.equal(issues.filter(x=>x.includes('明示项')).length,4);assert.equal(JSON.stringify(old),before);
 const next={...old,id:'fresh',content:fresh};s.artifacts.push(next);s.selected.prompt=next.id;
 assert.ok(!selectedPromptContractIssues(e,s).some(x=>/明示项|完整四视图参考合同|可见信息层遗漏/u.test(x)));assert.equal(JSON.stringify(old),before);
 const missing=visibleInformationIssues(b,fresh.replace('系统面板（模型直出或空面板后期精确覆盖）：'+b.systemPanels[0],''));
 assert.ok(missing.some(x=>x.includes(b.systemPanels[0])));
});
