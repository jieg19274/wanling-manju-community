import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Project,AssetImage} from '../shared/model.js';
import {assetInputHash} from '../shared/generation.js';
import {mediaPath} from './media.js';
import {assertAssetImageRole,isCharacterSheet,requiresPortraitReference} from '../shared/asset-references.js';

export type ImageReference = {imageId:string;path:string;fileHash:string;role?:string;promptUse:string};
// Preview and execution share this selection so approval freezes actual files.
export function assetImageReferences(project:Project,assetId:string,stateId:string,role:string,sourceImageId=''):ImageReference[] {
  const asset=project.assets?.find(a=>a.id===assetId);
  if(!asset)throw Error('资产不存在');
  assertAssetImageRole(asset,role);
  const state=stateId?asset.states.find(s=>s.id===stateId):undefined;
  if(stateId&&!state)throw Error('资产状态不存在');
  const wholeCharacter=requiresPortraitReference(asset);
  const current=(image:AssetImage,sid:string)=>image.review?.status==='approved'&&(image.stateId||'')===sid&&image.inputHash===assetInputHash(project,assetId,sid)&&(!wholeCharacter||isCharacterSheet(image));
  const latest=(sid:string,r:string)=>asset.images.filter(i=>current(i,sid)&&(i.role||'main')===r).at(-1);
  const list:{image:AssetImage;use:string;repair?:boolean}[]=[];
  if(sourceImageId){
    const source=asset.images.find(i=>i.id===sourceImageId);
    if(!source||(source.stateId||'')!==stateId||(!requiresPortraitReference(asset)&&(source.role||'main')!==role))throw Error('返修原图必须属于同一资产、状态和图片用途');
    if(wholeCharacter&&!isCharacterSheet(source))throw Error('人物返修原图须使用完整四视图＋大头照；独立全身照、头图和裁图仅保留历史记录');
    list.push({image:source,repair:true,use:'待修正原图（可能未通过审核）：只保留本次明确正确的身份、衣着、结构与构图，消除反馈指定错误；不得把整张图当成已审核参考。当前登记状态优先。'});
  }
  if(state){
    const bases=[latest('',wholeCharacter?'turnaround':'main')].filter((i):i is AssetImage=>Boolean(i));
    if(!bases.length)throw Error(wholeCharacter?'先完成同一角色完整四视图＋大头照的视觉审核，再生成剧情状态图':'先完成同一资产基础图的视觉审核，再生成剧情状态图');
    const previous=asset.states.filter(s=>s.startEpisode<state.startEpisode||s.startEpisode===state.startEpisode&&(s.startSegment<state.startSegment||s.startSegment===state.startSegment&&asset.states.indexOf(s)<asset.states.indexOf(state)))
      .sort((a,b)=>b.startEpisode-a.startEpisode||b.startSegment-a.startSegment||asset.states.indexOf(b)-asset.states.indexOf(a))
      .map(s=>latest(s.id,wholeCharacter?'turnaround':'main')).find(Boolean);
    if(previous)list.push({image:previous,use:'已审核的同一资产较近上一状态；仅保持未改变部分，当前变化以本次登记状态为准。'});
    for(const image of bases)list.push({image,use:'已审核的同一资产基础外形；保持身份、脸、骨相及未改变结构，不继承已改变的历史状态。'});
  }
  if(!state&&asset.kind==='character'){
    const identity=latest('','turnaround')||latest('','main');
    if(identity)list.push({image:identity,use:'已审核的同一角色基础身份图：保持同一脸、发型、体型、衣着和配色，按本次要求改变视角与布局。'});
  }
  const seen=new Set<string>();
  return list.filter(({image})=>{if(seen.has(image.id))return false;seen.add(image.id);return true;}).map(({image,use,repair})=>{
    const source=mediaPath(image.mediaPath),hash=createHash('sha256').update(readFileSync(source)).digest('hex');
    if(!repair&&(!image.fileHash||image.fileHash!==hash))throw Error('已审核参考图的文件指纹发生变化，请重新审图；未提交生成');
    if(repair&&image.fileHash&&image.fileHash!==hash)throw Error('返修原图的文件已变化，请重新导入或审图；未提交生成');
    return {imageId:image.id,path:source,fileHash:hash,role:image.role,promptUse:use};
  });
}
