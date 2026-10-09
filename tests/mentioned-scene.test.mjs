import test from 'node:test';import assert from 'node:assert/strict';import {validMentionOnly,makeBeat} from '../dist-server/shared/model.js';
test('mentioned destination or seal does not require an unrelated scene reference, while actual shot location cannot be exempted',()=>{
 const a={id:'palace',kind:'scene',name:'坤宁宫',identity:'night palace'},b={...makeBeat(),event:'你看见坤宁宫印记，收进袖中。',reaction:'宫女传话，请去坤宁宫。',dialogue:[],os:[]},s={mentionOnlyAssets:[{assetId:a.id,sourceEvidence:'你看见坤宁宫印记',reason:'只提及印记来源与未来目的地，本段摄影机仍在宫道，不实际进入该宫。'}],assetBindings:[],subshots:[{location:'皇宫宫道',action:'接手令后收袖',assetIds:[]}]};
 assert.equal(validMentionOnly(s,b,a),true);
 assert.equal(validMentionOnly({...s,subshots:[{location:'皇宫宫道',action:'查看坤宁宫印记后收袖',assetIds:[]}]},b,a),true);
 assert.equal(validMentionOnly({...s,subshots:[{location:'坤宁宫内',action:'进入殿内',assetIds:[]}]},b,a),false);
 assert.equal(validMentionOnly({...s,subshots:[{location:'宫道',action:'镜头进入坤宁宫',assetIds:[]}]},b,a),false);
 assert.equal(validMentionOnly({...s,assetBindings:[{assetId:a.id}]},b,a),false);
 assert.equal(validMentionOnly({...s,mentionOnlyAssets:[{...s.mentionOnlyAssets[0],sourceEvidence:'不存在的坤宁宫依据'}]},b,a),false);
 assert.equal(validMentionOnly(s,b,{...a,kind:'prop'}),false);
});
