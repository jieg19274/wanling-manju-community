import {type StudioNode,type StudioConnection,type CanvasPoint,validCanvasPoint,canvasMediaUrl,videoState} from './studio-canvas.js';
import type {Episode,Project} from './model.js';
import {requiresPortraitReference} from './asset-references.js';

export type CanvasLayout={points:Record<string,CanvasPoint>;notes:StudioNode[];assetIds:string[];hiddenIds:string[];connections:StudioConnection[];library:StudioNode[];fonts:Record<string,number>};
const strings=(value:unknown)=>Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'))]:[];
const validNode=(n:StudioNode)=>n&&['note','video','asset','source','shot','anchor'].includes(n.type)&&typeof n.id==='string'&&typeof n.title==='string'&&typeof n.content==='string'&&Array.isArray(n.tags)&&n.tags.every(t=>typeof t==='string')&&validCanvasPoint({...n.position,width:n.width,height:n.height})&&(!n.media||typeof n.media==='string'&&(n.media.startsWith('/media/')||n.media.startsWith('data:image/')));
export function restoreCanvasLayout(value:unknown):CanvasLayout {
  const saved=value&&typeof value==='object'?value as Partial<CanvasLayout>:{};
  return {points:Object.fromEntries(Object.entries(saved.points||{}).filter(([,p])=>validCanvasPoint(p))),
    notes:(Array.isArray(saved.notes)?saved.notes:[]).filter(n=>validNode(n)&&/^(note|workspace):/.test(n.id)).map(n=>({...n,local:true})),
    assetIds:strings(saved.assetIds),hiddenIds:strings(saved.hiddenIds),
    connections:(Array.isArray(saved.connections)?saved.connections:[]).filter(c=>c&&typeof c.id==='string'&&typeof c.fromNodeId==='string'&&typeof c.toNodeId==='string'&&c.fromNodeId!==c.toNodeId),
    library:(Array.isArray(saved.library)?saved.library:[]).filter(validNode),
    fonts:Object.fromEntries(Object.entries(saved.fonts||{}).filter(([,size])=>Number.isFinite(size)&&size>=10&&size<=36))};
}
export function resolveWorkspaceNodes(nodes:StudioNode[],episode:Episode,project?:Project):StudioNode[] {
  return nodes.map(n=>{
    if(n.type==='asset'&&n.local&&project){
      const asset=project.assets?.find(a=>a.id===n.assetId);
      if(!asset)return {...n,imageId:undefined,media:undefined,status:'missing',tags:['资产已移除','工作节点']};
      const image=n.imageId?asset.images.find(i=>i.id===n.imageId):undefined;
      const stateId=image?.stateId||n.stateId||'',state=asset.states.find(s=>s.id===stateId);
      return {...n,stateId,role:image?.role||n.role||(requiresPortraitReference(asset)?'turnaround':'main'),imageId:image?.id,
        content:[asset.identity,state?.appearance,asset.voice&&`声线：${asset.voice}`].filter(Boolean).join('\n'),
        media:image?.mediaPath?canvasMediaUrl(image.mediaPath):undefined,status:image?image.review?.status||'pending':'missing',
        tags:[state?.label||'基础状态',image?'引用保留版本':n.imageId?'引用版本已移除':'未选择参考图','工作节点']};
    }
    if(n.type!=='video'||!n.local)return n;
    const segment=episode.segments.find(s=>s.id===n.segmentId);
    const videos=segment?.artifacts.filter(a=>a.kind==='video')||[];
    const video=n.artifactId?videos.find(v=>v.id===n.artifactId):undefined;
    return {...n,artifactId:video?.id,selected:!!video&&segment?.selected.video===video.id,media:video?.mediaPath?canvasMediaUrl(video.mediaPath):undefined,
      status:video?.review?.status||'pending',tags:[segment?`片段 ${segment.number}`:'未关联片段',video?videoState(video):'空视频节点','工作节点']};
  });
}
export function duplicateCanvasNode(node:StudioNode,id:string):StudioNode {
  const text=!['asset','video','note'].includes(node.type);
  return {...node,id,type:text?'note':node.type,title:`${node.title} · 副本`,local:true,
    position:{x:node.position.x+40,y:node.position.y+40},selected:false,
    ...(text?{media:undefined,assetId:undefined,segmentId:undefined,artifactId:undefined,tags:['制作文本副本']}:{} )};
}
