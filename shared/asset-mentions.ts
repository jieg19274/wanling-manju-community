import type {ScriptBeat,Segment,AssetKind} from './model.js';

/** Prop exemptions need positive textual evidence, never just a user's reason. */
export function onlyDiscussedProp(beat:ScriptBeat,segment:Segment,name:string):boolean {
  if(!name)return false;
  const shots=segment.subshots||[];
  if(shots.some(shot=>(shot.location||'').includes(name)))return false;
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const modifiers='(?:关于|有关|搭赠|赠送|购买|提供|借用|归还|寻找|取得|得到|这|那|该|本|一|份|件|个|些|批|种|旧|新|以|用|要|将|想|的)';
  const discussed=new RegExp('(?:谈论|谈及|讨论|提到|提及|说起|询问|打听|商议|商量|想要|索要|提出|计划|打算)'+modifiers+'{0,6}[“"「]?'+escaped+'[”"」]?','gu');
  const absent=new RegExp('(?:尚未|还未|并未|没有|未曾)(?:取得|得到|拿到|拿出|取出|见到)[^，。！？；\\n]{0,6}'+escaped+'|'+escaped+'[^，。！？；\\n]{0,4}(?:尚未|还未|并未|没有|未曾)(?:取得|得到|拿到|拿出|取出|出现|出场)','gu');
  const physical=/(?:抓住|抓着|拿着|握着|捧着|抱着|端着|手持|怀抱|拿在|握在|拿出|取出|掏出|拾起|举起|摊开|摊在|摊着|翻开|翻阅|展开|合上|打开|递给|递出|塞进|收进|摆在|放在|放到|放下|展示|触摸|使用|查看|撕碎|烧毁|砸碎|悬挂)/u;
  const texts=[beat.event,beat.reaction,segment.visualPlan,
    ...shots.flatMap(shot=>[shot.action,shot.priorState,shot.result,shot.endFrame])];
  for(const text of texts.filter((value):value is string=>typeof value==='string'&&value.includes(name))){
    // Negated actions do not establish presence, but affirmative actions and
    // pronoun actions in the same sentence still block the exemption.
    const affirmative=text.replace(/(?:尚未|还未|并未|没有|未曾)(?:取得|得到|拿到|拿出|取出|见到)/gu,'未执行');
    const remaining=text.replace(discussed,'文字提及').replace(absent,'尚未出现');
    if(physical.test(affirmative)||remaining.includes(name)||/(?:它|该道具|此物)/u.test(remaining))return false;
  }
  // Dialogue alone can mention an absent prop, but cannot deny an explicit use.
  return ![...beat.dialogue,...beat.os].some(text=>text.includes(name)&&physical.test(
    text.replace(/(?:尚未|还未|并未|没有|未曾)(?:取得|得到|拿到|拿出|取出|见到)/gu,'未执行')));
}

// Written names on a letter and its absent sender do not introduce a new actor
// or filming location. Ambiguous mentions still require explicit review.
export function onlyTextualAssetMention(beat:ScriptBeat,segment:Segment,asset:{id:string;name:string;kind:AssetKind}):boolean {
  if(asset.kind==='prop'||!asset.name)return false;
  const shots=segment.subshots||[];
  if(shots.some(s=>s.assetIds?.includes(asset.id)||(asset.kind==='scene'&&(s.location||'').includes(asset.name))))return false;
  if([...beat.dialogue,...beat.os].some(line=>line.split(/[：:]/u)[0].replace('·OS','').trim()===asset.name))return false;
  const name=asset.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const narrative=[beat.event,beat.reaction,segment.visualPlan,...shots.map(s=>s.action)].join('\n');
  const owner=new RegExp(name+'的(?:请帖|书信|信件|口信|邀约|邀请函)','gu');
  const inscription=new RegExp('[“"「]?'+name+'[”"」]?(?:的)?(?:落款|印记|印章|字样|署名)','gu');
  const writtenName=new RegExp('(?:落款|印记|署名)(?:上|中)?(?:仅为|为|是|写着)?[“"「]?'+name+'[”"」]?','gu');
  const remaining=asset.kind==='character'?narrative.replace(owner,'该人的来信'):narrative.replace(inscription,'纸上标识').replace(writtenName,'纸上标识');
  // A character mentioned in another person's speech alone stays ambiguous.
  // A scene mentioned only in dialogue is not proof that the camera is there.
  return !remaining.includes(asset.name)&&(asset.kind==='scene'||narrative.includes(asset.name));
}
