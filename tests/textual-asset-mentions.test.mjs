import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onlyTextualAssetMention} from '../dist-server/shared/asset-mentions.js';
import {makeBeat,makeSegment} from '../dist-server/shared/model.js';
test('来信署名和台词中的目的地不召唤新人物或场景；实际出场仍要求参考图',()=>{
 const beat={...makeBeat(),event:'侍女奉上林小姐的请帖，你停在“望月楼”的落款上。',reaction:'你接帖并停目于望月楼落款。',dialogue:['侍女：请去望月楼。'],os:[]};
 const segment={...makeSegment(beat,1),visualPlan:'落款仅为“望月楼”，街道空间不变。',subshots:[{location:'商业街',action:'查看请帖望月楼落款',assetIds:[]}]};
 const person={id:'person',name:'林小姐',kind:'character'},scene={id:'scene',name:'望月楼',kind:'scene'};
 assert.equal(onlyTextualAssetMention(beat,segment,person),true);assert.equal(onlyTextualAssetMention(beat,segment,scene),true);
 assert.equal(onlyTextualAssetMention({...beat,event:beat.event+'林小姐走到身旁。'},segment,person),false);
 assert.equal(onlyTextualAssetMention({...beat,dialogue:['林小姐：请进。']},segment,person),false);
 assert.equal(onlyTextualAssetMention(beat,{...segment,subshots:[{location:'望月楼内',action:'递信',assetIds:[]}]},scene),false);
 assert.equal(onlyTextualAssetMention({...beat,event:beat.event+'随后进入望月楼。'},segment,scene),false);
 assert.equal(onlyTextualAssetMention(beat,{...segment,subshots:[{location:'商业街',action:'递信',assetIds:['person']}]},person),false);
 assert.equal(onlyTextualAssetMention({...beat,event:'你听到林小姐的名字。',reaction:''},segment,person),false);
});
