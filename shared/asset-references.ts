import type { Episode, Project, Segment } from './model.js';
import { effectiveState } from './asset-state.js';
import { assetInputHash } from './generation.js';
export function requiresPortraitReference(asset:{kind:string;identity:string}):boolean {
  return asset.kind==='character' && !(/第一人称|POV/iu.test(asset.identity)&&/不展示正脸|不露正脸|禁止正脸/u.test(asset.identity)&&/手|衣袖/u.test(asset.identity));
}

export function isCharacterSheet(image:{role?:string;layout?:string}|undefined):boolean {
  return image?.role==='turnaround' && image.layout==='three-view-portrait';
}

export function assertAssetImageRole(asset:{kind:string;identity:string},role:string):void {
  if(requiresPortraitReference(asset)) {
    if(role!=='turnaround')throw new Error('人物参考统一使用完整四视图＋大头照，不再生成或导入独立全身照、头图');
  } else if(role!=='main')throw new Error('场景、道具与第一人称手部参考使用形态主图');
}

export function segmentReferences(project: Project, episode: Episode, segment: Segment) {
  return (segment.assetBindings || []).map(binding => {
    const asset = project.assets?.find(item => item.id === binding.assetId);
    if (!asset) throw new Error(`片段 ${segment.number} 绑定了不存在的资产`);
    const state = effectiveState(asset, episode, segment, binding.stateId);
    if (binding.stateId && !state) throw new Error(`资产“${asset.name}”的指定状态不存在`);
    const image = binding.imageId ? asset.images.find(item => item.id === binding.imageId) : undefined;
    if (binding.imageId && (!image || image.stateId !== state?.id))
      throw new Error(`资产“${asset.name}”的参考图与剧情状态不一致`);
    if (image?.role === 'portrait') throw new Error(`资产“${asset.name}”的头部特写不能代替全身或形态主图`);
    const acceptance=image?.referenceAcceptance;
    if(image?.review?.approvalMode==='user-fallback'&&!acceptance)throw new Error(`资产“${asset.name}”沿用旧图缺少用户确认记录`);
    if(acceptance){
      const original=asset.images.find(i=>i.id===acceptance.sourceImageId);
      if(acceptance.status!=='accepted'||!acceptance.statement.trim()||!acceptance.acceptedAt||
        !original||original.id===image.id||original.mediaPath!==image.mediaPath||
        acceptance.sourceFileHash!==image.fileHash||
        acceptance.acceptedInputHash!==assetInputHash(project,asset.id,state?.id)||
        image.inputHash!==acceptance.acceptedInputHash||!acceptance.knownDifference.trim()||!acceptance.requiredVideoCorrection.trim())
        throw new Error(`资产“${asset.name}”沿用旧图授权或版本已失效`);
    }
    return { assetId: asset.id, kind: asset.kind, name: asset.name,
      identity: asset.identity, voice: asset.voice, stateId: state?.id,
      stateLabel: state?.label || '', appearance: state?.appearance || '',
      imageId: image?.id, mediaPath: image?.mediaPath, fileHash: image?.fileHash, referenceLayout: image?.layout,
      ...(acceptance?{referenceAcceptance:acceptance}: {}) };
  }).sort((a, b) => ({ character: 0, scene: 1, prop: 2 })[a.kind] -
    ({ character: 0, scene: 1, prop: 2 })[b.kind]);
}

export function videoReferences(project: Project, episode: Episode, segment: Segment) {
  return segmentReferences(project, episode, segment).flatMap(ref => {
    const binding = segment.assetBindings?.find(item => item.assetId === ref.assetId);
    const main = project.assets?.find(item => item.id === ref.assetId)?.images.find(item => item.id === binding?.imageId);
    const integrated = ref.kind==='character' && isCharacterSheet(main);
    for(const imageId of [binding?.imageId]){
      const excluded=segment.referenceExclusions?.find(item=>item.imageId===imageId);
      if(excluded)throw new Error(`资产「${ref.name}」参考图不适用于本片段：${excluded.reason}；观察场景：${excluded.observedScene}；所需场景：${excluded.expectedScene}。缺少适用参考，必须明确补选；不会自动换图。`);
    }
    if (!main || main.review?.status !== 'approved' || main.inputHash !== assetInputHash(project, ref.assetId, ref.stateId))
      throw new Error(`资产“${ref.name}”须显式选择已审图通过的当前主图`);
    if (requiresPortraitReference({kind:ref.kind,identity:ref.identity}) && !integrated)
      throw new Error(`人物“${ref.name}”须选用已审图的完整四视图＋大头照；独立全身照与头图已退出制作流程`);
    const current = { ...ref, role: 'main' as const, temporalScope: binding?.priorReference ? `${binding.priorReference.untilSec}秒完成状态变化后；与变化前参考是同一个角色` : '' };
    if (!binding?.priorReference) return [current];
    const prior = binding.priorReference, asset = project.assets!.find(item=>item.id===ref.assetId)!;
    const image = asset.images.find(item=>item.id===prior.imageId);
    const state = asset.states.find(item=>item.id===image?.stateId);
    if (!requiresPortraitReference(asset) || !image || !isCharacterSheet(image) || image.id===main.id ||
      image.review?.status!=='approved' || image.inputHash!==assetInputHash(project,asset.id,image.stateId) ||
      !Number.isFinite(prior.untilSec) || prior.untilSec<=0 || prior.untilSec>=segment.durationSec)
      throw new Error(`资产“${ref.name}”的段内变化前参考无效；须使用同一角色已审完整四视图`);
    return [{ ...ref, imageId:image.id,mediaPath:image.mediaPath,fileHash:image.fileHash,referenceLayout:image.layout,
      stateId:image.stateId,stateLabel:state?.label||'变化前原状态',appearance:state?.appearance||'',role:'main' as const,
      temporalScope:`0–${prior.untilSec}秒状态变化完成前；与变化后参考是同一个角色，各视角不增加人数` },current];
  });
}
