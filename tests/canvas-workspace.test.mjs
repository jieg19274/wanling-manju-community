import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeProject,makeEpisode,makeBeat,makeSegment} from '../dist-server/shared/model.js';
import {restoreCanvasLayout,resolveWorkspaceNodes,duplicateCanvasNode} from '../dist-server/shared/canvas-workspace.js';

const node=(type='note')=>({id:'workspace:test',type,title:'制作文本',content:'完整文本，包括对白与OS',position:{x:40,y:60},width:300,height:240,tags:['工作节点'],local:true});
test('workspace restoration migrates text notes and rejects corrupt layouts, unsupported media and authoritative node IDs',()=>{
  const data={notes:[node(),{...node(),id:'source:official'},null,{...node(),media:'https://untrusted.invalid/img.png'},{...node(),tags:null}],points:{bad:{x:Infinity,y:1},good:{x:-50,y:60,width:300}},fonts:{good:18,bad:200},assetIds:['asset','asset'],connections:[{id:'ok',fromNodeId:'a',toNodeId:'b'},{id:'self',fromNodeId:'a',toNodeId:'a'}]};
  const layout=restoreCanvasLayout(data);assert.equal(layout.notes.length,1);assert.equal(layout.notes[0].local,true);assert.deepEqual(layout.assetIds,['asset']);assert.deepEqual(Object.keys(layout.points),['good']);assert.deepEqual(layout.fonts,{good:18});assert.equal(layout.connections.length,1);assert.deepEqual(layout.hiddenIds,[]);assert.deepEqual(layout.library,[]);
});
test('copying locked story creates editable work text while preserving the original content and removing production bindings',()=>{
  const official={...node('shot'),id:'shot:official',local:undefined,segmentId:'formal',assetId:'actor',artifactId:'prompt',media:'/media/formal.png',selected:true};
  const before=JSON.stringify(official),copy=duplicateCanvasNode(official,'workspace:copy');
  assert.equal(copy.type,'note');assert.equal(copy.content,official.content);assert.equal(copy.local,true);assert.equal(copy.segmentId,undefined);assert.equal(copy.assetId,undefined);assert.equal(copy.artifactId,undefined);assert.equal(copy.media,undefined);assert.equal(copy.selected,false);assert.equal(JSON.stringify(official),before);
});
test('new and restored empty video work nodes never inherit a segment video, including later arrivals',()=>{
  const e=makeEpisode(1,'素材核对'),b=makeBeat(),s=makeSegment(b,1),other=makeSegment(b,2);e.scriptBeats=[b];e.segments=[s,other];
  s.artifacts=[{id:'first',kind:'video',mediaPath:'old.mp4'},{id:'latest',kind:'video',mediaPath:'new.mp4'}];s.selected.video='first';other.artifacts=[{id:'unrelated',kind:'video',mediaPath:'other.mp4'}];
  const before=JSON.stringify(e),free={...node('video'),segmentId:s.id};
  const empty=resolveWorkspaceNodes([free],e)[0];assert.equal(empty.artifactId,undefined);assert.equal(empty.media,undefined);assert.equal(empty.selected,false);
  assert.ok(empty.tags.includes('空视频节点'));
  const restored=restoreCanvasLayout({notes:[free]}).notes;
  assert.equal(resolveWorkspaceNodes(restored,e)[0].media,undefined);
  assert.equal(resolveWorkspaceNodes([{...free,segmentId:undefined}],e)[0].media,undefined);
  const chosen=resolveWorkspaceNodes([{...free,artifactId:'first'}],e)[0];assert.equal(chosen.media,'/media/old.mp4');assert.equal(chosen.selected,true);
  assert.equal(resolveWorkspaceNodes([{...free,artifactId:'unrelated'}],e)[0].media,undefined);assert.equal(s.selected.video,'first');assert.equal(JSON.stringify(e),before);
  e.segments[0].artifacts.push({id:'generated-later',kind:'video',mediaPath:'later.mp4'});
  assert.equal(resolveWorkspaceNodes(restored,e)[0].media,undefined);
  assert.equal(resolveWorkspaceNodes([{...free,artifactId:'first'}],e)[0].media,'/media/old.mp4');
});

test('explicit video selection survives restoration and copying without falling back when the version disappears',()=>{
  const e=makeEpisode(1,'版本选择'),b=makeBeat(),s=makeSegment(b,1);e.scriptBeats=[b];e.segments=[s];
  s.artifacts=[{id:'imported',kind:'video',mediaPath:'imported.mp4'},{id:'other',kind:'video',mediaPath:'other.mp4'}];
  const work={...node('video'),segmentId:s.id,artifactId:'imported'};
  const restored=restoreCanvasLayout({notes:[work]}).notes;
  assert.equal(resolveWorkspaceNodes(restored,e)[0].media,'/media/imported.mp4');
  const copy=duplicateCanvasNode(resolveWorkspaceNodes(restored,e)[0],'workspace:copy');
  assert.equal(resolveWorkspaceNodes([copy],e)[0].media,'/media/imported.mp4');
  s.artifacts=s.artifacts.filter(v=>v.id!=='imported');
  const missing=resolveWorkspaceNodes(restored,e)[0];assert.equal(missing.media,undefined);assert.equal(missing.artifactId,undefined);
  assert.equal(s.selected.video,undefined);
});

test('restored asset copies refresh library metadata and reviews while retaining their explicit image version',()=>{
  const p=makeProject('资产恢复隔离测试','standard'),e=makeEpisode(1,'恢复');p.episodes=[e];
  p.assets=[{id:'actor',kind:'character',name:'人物',identity:'更新后的资产描述',voice:'清晰声线',states:[],images:[
    {id:'pinned',role:'turnaround',layout:'three-view-portrait',mediaPath:'完整四视图.png',source:'upload',review:{status:'rejected'}},
    {id:'newest',role:'turnaround',layout:'three-view-portrait',mediaPath:'新候选.png',source:'model'}]}];
  const copy={...node('asset'),assetId:'actor',imageId:'pinned',role:'turnaround',content:'旧描述',media:'/media/旧缓存.png',status:'approved'};
  const saved=restoreCanvasLayout({notes:[copy]}).notes,before=JSON.stringify(p);
  let current=resolveWorkspaceNodes(saved,e,p)[0];
  assert.equal(current.content.includes('更新后的资产描述'),true);assert.equal(current.status,'rejected');
  assert.equal(current.imageId,'pinned');assert.equal(current.media.includes(encodeURIComponent('完整四视图.png')),true);
  assert.equal(JSON.stringify(p),before);
  p.assets[0].images=p.assets[0].images.filter(i=>i.id!=='pinned');
  current=resolveWorkspaceNodes(saved,e,p)[0];assert.equal(current.media,undefined);assert.equal(current.status,'missing');
  assert.equal(current.imageId,undefined);assert.equal(current.media?.includes('新候选'),undefined);
});
