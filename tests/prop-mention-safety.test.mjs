import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {makeProject,makeEpisode,makeBeat,makeSegment,lockScript,sourceHash,highlightHash,defaultSubshots,validMentionOnly,auditEpisode} from '../dist-server/shared/model.js';
mkdirSync(path.resolve('.test-temp'),{recursive:true});
const root=mkdtempSync(path.resolve('.test-temp/prop-mention-safety-'));
Object.assign(process.env,{MANJU_DATA_DIR:path.join(root,'data'),MANJU_BACKUP_DIR:path.join(root,'backups')});
const {applyAction}=await import('../dist-server/server/actions.js');
const {db}=await import('../dist-server/server/store.js');after(()=>db.close());

const asset={id:'ledger',kind:'prop',name:'账册',identity:'普通账册',voice:'',states:[],images:[]};
function fixture(event){
  const beat={...makeBeat(),event,reaction:'人物思考下一步。'},segment=makeSegment(beat,1);
  segment.mentionOnlyAssets=[{assetId:asset.id,sourceEvidence:event,reason:'只讨论账册的事，实体尚未出场。'}];
  return {beat,segment};
}
test('physical prop actions cannot be exempted even when bindings and shot asset IDs are missing',()=>{
  for(const event of ['人物抓住账册，把账册摊在桌上查看。','账册摊在桌上。','人物翻开旧账册。','人物提到账册，又拿出它。','人物准备账册，立即翻开它。',
    '人物讨论账册，伸手撕碎了它。','人物讨论在膝上躺着的账册。','人物提到桌上的账册。']){
    const {beat,segment}=fixture(event);assert.equal(validMentionOnly(segment,beat,asset),false,event);
  }
  const {beat,segment}=fixture('人物讨论账册，尚未取得。');assert.equal(validMentionOnly(segment,beat,asset),true);
  for(const field of ['action','priorState','result','endFrame','location']){
    const shot={assetIds:[],[field]:'桌上摊着账册'};
    assert.equal(validMentionOnly({...segment,subshots:[shot]},beat,asset),false,field);
  }
  assert.equal(validMentionOnly({...segment,visualPlan:'近景：手中的账册'},beat,asset),false);
});
test('explicit discussions, absent props, and another speaker mentioning a prop remain eligible',()=>{
  for(const event of ['人物提出搭赠账册，尚未取得。','人物尚未拿到账册。','账册尚未取得。']){
    const {beat,segment}=fixture(event);assert.equal(validMentionOnly(segment,beat,asset),true,event);
  }
  const {beat,segment}=fixture('人物说明条件。');beat.dialogue=['人物：账册还在别处。'];
  segment.mentionOnlyAssets[0].sourceEvidence='账册还在别处';assert.equal(validMentionOnly(segment,beat,asset),true);
  beat.dialogue=['人物：我正拿着账册。'];segment.mentionOnlyAssets[0].sourceEvidence='我正拿着账册';
  assert.equal(validMentionOnly(segment,beat,asset),false);
});
test('the action API rejects false mention declarations and keeps the missing reference audit gate',()=>{
  const project=makeProject('道具门禁回归','standard'),episode=makeEpisode(1,'本地测试');
  episode.sourceText='人物抓住账册，把账册摊在桌上查看。'.repeat(10);episode.sourceReviewedHash=sourceHash(episode);
  episode.highlightReport='人物抓住账册，将其摊在桌上，低头查看内容。';episode.highlightReviewedHash=highlightHash(episode);
  const beat={...makeBeat(),sourceQuote:episode.sourceText,event:'人物抓住账册，把账册摊在桌上查看。',reaction:'人物低头查看账册内容。'};
  episode.scriptBeats=[beat];lockScript(episode);project.episodes=[episode];project.assets=[structuredClone(asset)];
  const segment=episode.segments[0];segment.shotContractVersion=2;
  segment.subshots=defaultSubshots(beat,segment.durationSec).map(shot=>({...shot,action:beat.event,assetIds:[],location:'房间'}));
  const missing=()=>auditEpisode(episode,project).filter(issue=>issue.includes('账册')&&issue.includes('未绑定'));
  assert.ok(missing().length);
  assert.throws(()=>applyAction(project,{type:'segment.mentionOnly',episodeId:episode.id,segmentId:segment.id,assetId:asset.id,
    sourceEvidence:'人物抓住账册',reason:'只被提到账册，未发生实物出场。'}),/仅被提及/);
  assert.equal(segment.mentionOnlyAssets,undefined);assert.ok(missing().length);
});
