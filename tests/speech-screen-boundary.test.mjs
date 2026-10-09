import test from 'node:test';
import assert from 'node:assert/strict';
import { speechTextBoundary,screenTextBoundary } from '../dist-server/shared/prompt-contract.js';
import { makeBeat,makeSegment,makeEpisode,composePrompt,selectedPromptContractIssues,contentHash } from '../dist-server/shared/model.js';
test('source-authorized mention HUD neither summons an absent character nor binds another face',()=>{
 assert.match(screenTextBoundary(),/原文指定仅被提及的身份只作为提及HUD.*不引入人物实体.*不贴在其他人物脸上/);
 assert.match(screenTextBoundary(),/身份浮签默认绑定对应可见角色/);
});
test('formal speech whitelist preserves dialogue and original OS without narrating actions',()=>{
 const b={...makeBeat(),dialogue:['苏怜月：是账。'],os:[]};
 assert.match(speechTextBoundary(b),/1句正式人物对白、0句正式内心OS/);
 assert.match(speechTextBoundary(b),/动作描述.*不得说出来/);
 assert.match(speechTextBoundary(b),/禁止新增内心独白/);
 assert.match(speechTextBoundary({...b,os:['你·OS：来得正好。']}),/原文已有OS保留/);
 assert.match(speechTextBoundary(b),/不得以静音或字幕替代/);
});
test('new prompt gates both boundaries while retained frozen history stays unchanged',()=>{
 const b={...makeBeat(),dialogue:['苏怜月：是账。'],os:[]},s=makeSegment(b,1),e=makeEpisode(2,'boundary');e.scriptBeats=[b];e.segments=[s];
 const content=composePrompt(e,s);assert.ok(content.includes(screenTextBoundary()));assert.ok(content.includes(b.dialogue[0]));
 assert.match(content,/主观镜头的身份浮签只作为HUD/);assert.match(content,/不贴在其他人物脸上/);assert.match(content,/物理道具.*按原剧情保留/);
 const old={id:'retained',kind:'prompt',content:content.replace(screenTextBoundary(),'').replace(speechTextBoundary(b),''),sourceHash:contentHash(e,s)};s.artifacts=[old];s.selected.prompt=old.id;const before=JSON.stringify(old);
 const issues=selectedPromptContractIssues(e,s);assert.ok(issues.some(x=>x.includes('屏幕文字边界')));assert.ok(issues.some(x=>x.includes('可发声文本边界')));assert.equal(JSON.stringify(old),before);
});
