import type {Project,Episode,Segment} from '../shared/model.js';
import {effectiveState} from '../shared/asset-state.js';
import {requiresPortraitReference} from '../shared/asset-references.js';
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function canvasAssets(project:Project,episode:Episode,segment:Segment){
  return (project.assets||[]).flatMap(asset=>{
    const binding=segment.assetBindings?.find(b=>b.assetId===asset.id);
    const state=effectiveState(asset,episode,segment,binding?.stateId);
    return (requiresPortraitReference(asset)?['turnaround']:['main']).map(role=>{
      const selectedId=binding?.imageId;
      const selected=asset.images.find(i=>i.id===selectedId);
      const stateId=selected?.stateId||state?.id||'';
      const images=asset.images.filter(i=>(i.role||'main')===role&&(i.stateId||'')===stateId);
      const image=selected||images.at(-1);
      return {id:`asset:${asset.id}:${role}`,assetId:asset.id,stateId,role,name:asset.name,
        kind:asset.kind,image,count:images.length,bound:Boolean(binding),selected:Boolean(selected),state:state?.label||'基础状态'};
    });
  });
}
export function renderCanvasAsset(node:ReturnType<typeof canvasAssets>[number],episode:Episode,segment:Segment,position:string,focused=false){
  const attrs=`data-action="compare-bound-asset" data-asset-id="${esc(node.assetId)}" data-state-id="${esc(node.stateId)}" data-role="${node.role}" data-segment-id="${segment.id}"`;
  const src=node.image?.mediaPath?'/media/'+node.image.mediaPath.split('/').map(encodeURIComponent).join('/'):'';
  return `<article class="graph-node graph-asset graph-media-image ${focused?'focus':''} ${node.bound?'bound':''} ${src?'':'empty-asset'}" data-node-id="${esc(node.id)}" style="${position}"><div class="graph-node-head"><span>${esc(node.name)} · ${node.role==='portrait'?'头图':'资产图'}</span><button ${attrs}>选择</button></div><div class="graph-node-body"><button class="graph-image-select" ${attrs} aria-label="选择${esc(node.name)}图片节点">${src?`<img src="${esc(src)}" alt="${esc(node.name)}"/>`:'＋ 创建图片候选'}</button><small>${esc(node.state)} · ${node.count}版 · ${node.selected?'当前选用':node.bound?'已绑定，待选图':'未绑定当前片段'}</small><div class="graph-media-actions"><button ${attrs}>再生成候选…</button><button ${attrs}>比较与选用</button></div></div></article>`;
}
