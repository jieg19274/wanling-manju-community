import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../dist-server/shared/model.js';
import {studioCanvas,canvasConnectionAction,validCanvasPoint,canvasMediaUrl} from '../dist-server/shared/studio-canvas.js';

function fixture(){
  const p=model.makeProject('画布验收','standard'),e=model.makeEpisode(1,'关系核对');
  const b={...model.makeBeat(),event:'角色走进门并取回信件',reaction:'守门人回望后让开',dialogue:['角色：这封信我必须完整带回。'],os:['角色：先核对封印。'],floatLabels:['人物：使者'],systemPanels:['剩余时间：30']};
  const a=model.makeSegment(b,1),c=model.makeSegment(b,2);e.scriptBeats=[b];e.segments=[a,c];p.episodes=[e];
  p.assets=[{id:'actor',name:'使者<一>',kind:'character',identity:'使者身份',voice:'低沉声线',states:[],images:[{id:'sheet',role:'turnaround',layout:'three-view-portrait',mediaPath:'使者/四视图.png',source:'upload',createdAt:model.now()}]}];
  for(const s of e.segments){s.assetBindings=[{assetId:'actor',imageId:'sheet'}];s.artifacts=[{id:`prompt-${s.id}`,kind:'prompt',createdAt:model.now(),sourceHash:'fixture',content:'完整提示词\n'+b.dialogue[0]},{id:`video-${s.id}`,kind:'video',createdAt:model.now(),sourceHash:'fixture',mediaPath:'片段.mp4'},{id:`waste-${s.id}`,kind:'video',createdAt:model.now(),sourceHash:'fixture',mediaPath:'废片.mp4',review:{status:'rejected',notes:'判废',reviewedAt:model.now()}}];s.selected.prompt=s.artifacts[0].id;s.selected.video=s.artifacts[1].id;}
  return{p,e,b,a,c};
}
test('native canvas is a lossless display projection and keeps every video version and full story field',()=>{
  const{p,e,b,a}=fixture(),before=JSON.stringify(p),graph=studioCanvas(p,e,a.id);
  const shot=graph.nodes.find(n=>n.id===`shot:${a.id}`);
  for(const text of [b.event,b.reaction,...b.dialogue,...b.os,...b.floatLabels,...b.systemPanels,a.artifacts[0].content])assert.ok(shot.content.includes(text));
  assert.equal(graph.nodes.filter(n=>n.type==='video').length,4);
  assert.equal(graph.nodes.filter(n=>n.type==='asset').length,1);
  assert.equal(JSON.stringify(p),before);
});
test('all segment reference connections remain visible and selected media identity is stable when focus changes',()=>{
  const{p,e,a,c}=fixture(),first=studioCanvas(p,e,a.id),next=studioCanvas(p,e,c.id);
  assert.deepEqual(first.nodes.map(n=>n.id),next.nodes.map(n=>n.id));
  for(const s of [a,c])assert.equal(first.connections.filter(edge=>edge.kind==='reference'&&edge.toNodeId===`shot:${s.id}`).length,1);
  assert.equal(first.connections.filter(edge=>edge.kind==='chosen').length,2);
  assert.equal(first.nodes.find(n=>n.id==='asset:actor:turnaround').imageId,'sheet');
});
test('first video generation stays reachable before any prompt or video exists without altering the episode',()=>{
  const {p,e,a,c}=fixture();
  a.artifacts=[];a.selected={};
  const before=JSON.stringify(p),graph=studioCanvas(p,e,a.id);
  const pending=graph.nodes.find(n=>n.type==='video'&&n.segmentId===a.id);
  assert.ok(pending);assert.equal(pending.status,'missing');assert.equal(pending.artifactId,undefined);assert.equal(pending.media,undefined);
  assert.ok(pending.content.includes('先在左侧分镜节点生成提示词'));
  assert.ok(graph.connections.some(edge=>edge.fromNodeId===`shot:${a.id}`&&edge.toNodeId===pending.id));
  assert.equal(canvasConnectionAction(graph.nodes,`shot:${a.id}`,pending.id),null);
  assert.equal(graph.nodes.filter(n=>n.type==='video'&&n.segmentId===c.id).length,2);
  assert.equal(JSON.stringify(p),before);
  a.artifacts=[{id:'first-result',kind:'video',createdAt:model.now(),sourceHash:'fixture',mediaPath:'结果.mp4'}];a.selected.video='first-result';
  const next=studioCanvas(p,e,a.id).nodes.filter(n=>n.type==='video'&&n.segmentId===a.id);
  assert.equal(next.length,1);assert.equal(next[0].artifactId,'first-result');assert.equal(next[0].selected,true);
});
test('an episode canvas excludes other episode assets and places selected video nearest its shot',()=>{
  const{p,e,a}=fixture();
  p.assets.push({...structuredClone(p.assets[0]),id:'another-episode',name:'他集人物'});
  a.selected.video=a.artifacts[2].id;
  const{nodes}=studioCanvas(p,e,a.id);
  assert.equal(nodes.some(n=>n.assetId==='another-episode'),false);
  const videos=nodes.filter(n=>n.type==='video'&&n.segmentId===a.id);
  assert.equal(videos.find(n=>n.selected).position.x,Math.min(...videos.map(n=>n.position.x)));
  assert.equal(videos.length,2);
});
test('dragging a version connection rejects another segment, rejected video, and nonexistent nodes',()=>{
  const{p,e,a,c}=fixture(),{nodes}=studioCanvas(p,e,a.id);
  assert.deepEqual(canvasConnectionAction(nodes,`shot:${a.id}`,`video:video-${a.id}`),{segmentId:a.id,artifactId:`video-${a.id}`});
  for(const target of [`video:video-${c.id}`,`video:waste-${a.id}`,'absent'])assert.equal(canvasConnectionAction(nodes,`shot:${a.id}`,target),null);
  const empty={...nodes.find(n=>n.type==='video'),id:'workspace:empty',local:true,artifactId:undefined,media:undefined,selected:false};
  assert.equal(canvasConnectionAction([...nodes,empty],`shot:${a.id}`,empty.id),null);
});
test('manually added asset boxes appear before binding without changing story or creating reference links',()=>{
  const{p,e,a}=fixture();
  for(const kind of ['character','scene','prop'])p.assets.push({id:`new-${kind}`,name:`新${kind}`,kind,identity:'待生成描述',voice:'',states:[],images:[]});
  const before=JSON.stringify(p),ids=['new-character','new-scene','new-prop','missing'];
  const{nodes,connections}=studioCanvas(p,e,a.id,ids);
  for(const assetId of ids.slice(0,3)){
    const n=nodes.find(n=>n.assetId===assetId);assert.ok(n);assert.equal(n.status,'missing');
    assert.equal(n.segmentId,a.id);assert.equal(n.tags.at(-1),'未绑定当前片段');
    assert.equal(connections.some(c=>c.fromNodeId===n.id),false);
  }
  assert.equal(nodes.some(n=>n.assetId==='missing'),false);assert.equal(JSON.stringify(p),before);
});
test('restored layouts reject corrupt coordinates and media URLs encode each path component',()=>{
  for(const bad of [null,{x:NaN,y:2},{x:2,y:Infinity},{x:1,y:2,width:-1},{x:1,y:2,height:Infinity}])assert.equal(validCanvasPoint(bad),false);
  assert.equal(validCanvasPoint({x:-200,y:100,width:300,height:200}),true);
  assert.equal(canvasMediaUrl('资产/图 1.png'),'/media/%E8%B5%84%E4%BA%A7/%E5%9B%BE%201.png');
});

test('reopened canvas shows formal-story and subshot assets before binding, with current library images',()=>{
  const{p,e,b,a}=fixture();
  p.assets.push({id:'letter',name:'信件',kind:'prop',identity:'封印完整的信件',voice:'',states:[],images:[{id:'letter-old',role:'main',mediaPath:'旧信件.png',source:'upload',createdAt:model.now()}]},
    {id:'hall',name:'未在正文命名的门厅',kind:'scene',identity:'门厅',voice:'',states:[],images:[]},
    {id:'unrelated',name:'他集山洞',kind:'scene',identity:'山洞',voice:'',states:[],images:[]});
  a.subshots[0].assetIds=['hall'];
  const saved=JSON.parse(JSON.stringify(p));
  saved.assets.find(x=>x.id==='letter').images.push({id:'letter-new',role:'main',mediaPath:'新信件.png',source:'upload',createdAt:model.now()});
  const before=JSON.stringify(saved),{nodes,connections}=studioCanvas(saved,saved.episodes[0],a.id);
  assert.equal(nodes.find(n=>n.assetId==='letter')?.imageId,'letter-new');
  assert.ok(nodes.some(n=>n.assetId==='hall'));assert.equal(nodes.some(n=>n.assetId==='unrelated'),false);
  assert.ok(nodes.find(n=>n.assetId==='letter').tags.includes('未绑定当前片段'));
  assert.equal(connections.some(c=>c.fromNodeId==='asset:letter:main'),false);
  assert.equal(JSON.stringify(saved),before);assert.equal(b.event,'角色走进门并取回信件');
});

test('assets explicitly added to a draft canvas survive reopening before segments exist',()=>{
  const{p,e}=fixture();e.segments=[];
  const before=JSON.stringify(p),saved=JSON.parse(before);
  const{nodes,connections}=studioCanvas(saved,saved.episodes[0],'',['actor']);
  const asset=nodes.find(n=>n.assetId==='actor');
  assert.ok(asset);assert.equal(asset.role,'turnaround');assert.equal(asset.imageId,'sheet');
  assert.equal(asset.segmentId,undefined);assert.equal(connections.length,0);assert.equal(JSON.stringify(saved),before);
});

test('unselected prompt remains visible as a candidate after reopening without restoring selection or archived versions',()=>{
  const{p,e,a}=fixture();delete a.selected.prompt;a.promptSelectionPaused=true;
  a.artifacts.push({id:'archived',kind:'prompt',createdAt:model.now(),sourceHash:'fixture',content:'旧版已停用，不得作为候选显示',promptArchive:{archivedAt:model.now(),reason:'替换旧版'}});
  const saved=JSON.parse(JSON.stringify(p)),before=JSON.stringify(saved);
  let shot=studioCanvas(saved,saved.episodes[0],a.id).nodes.find(n=>n.id===`shot:${a.id}`);
  assert.ok(shot.content.includes(a.artifacts[0].content));assert.ok(shot.content.includes('候选提示词（未选用）'));
  assert.equal(shot.status,'candidate');assert.equal(shot.artifactId,a.artifacts[0].id);assert.equal(shot.content.includes('旧版已停用'),false);
  assert.equal(JSON.stringify(saved),before);assert.equal(saved.episodes[0].segments[0].selected.prompt,undefined);
  saved.episodes[0].segments[0].artifacts[0].promptArchive={archivedAt:model.now(),reason:'停止使用'};
  shot=studioCanvas(saved,saved.episodes[0],a.id).nodes.find(n=>n.id===`shot:${a.id}`);
  assert.equal(shot.status,'missing');assert.equal(shot.content.includes(a.artifacts[0].content),false);
});
