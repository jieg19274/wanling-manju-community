import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InfiniteCanvas } from './vendor/infinite-canvas/infinite-canvas';
import { ConnectionPath, ActiveConnectionPath } from './vendor/infinite-canvas/canvas-connections';
import { Minimap } from './vendor/infinite-canvas/canvas-mini-map';
import type { ViewportTransform, Position } from './vendor/infinite-canvas/types';
import { studioCanvas, validCanvasPoint, type StudioNode, type CanvasPoint } from '../shared/studio-canvas';
import { fitCanvasNodes, nodesInMarquee } from '../shared/canvas-viewport';
import type { Project, Episode } from '../shared/model';
import {requiresPortraitReference} from '../shared/asset-references';
import {restoreCanvasLayout,resolveWorkspaceNodes,duplicateCanvasNode,type CanvasLayout} from '../shared/canvas-workspace';
import {presentCanvasNode,isFocusedConnection,type CanvasDensity} from '../shared/canvas-presentation';
import './studio-canvas.css';

type Layout = CanvasLayout;
type NewAsset = {kind:'character'|'scene'|'prop';name:string;identity:string;voice:string};
export type StudioCanvasProps = {
  project: Project; episode: Episode; selectedSegmentId: string;
  auditLabel: string; activeTab: string;
  onSelect: (node: StudioNode) => void;
  onConnect: (from: StudioNode, to: StudioNode) => Promise<void>;
  onImport: (file: File, node: StudioNode) => Promise<string | undefined>;
  onCreateAsset: (input: NewAsset) => Promise<string>;
  onGenerate: (node:StudioNode,options:{feedback:string;count:number})=>Promise<void>;
};
const kinds: Record<StudioNode['type'], string> = {source:'剧本',asset:'资产',shot:'片段',video:'视频',anchor:'动作板',note:'文本'};
const readStored = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
};
const closeNativeMenu = (event:React.MouseEvent<HTMLDetailsElement>) => {if((event.target as Element).closest('button,a'))event.currentTarget.open=false;};
const editTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,video,[contenteditable="true"]');

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    hand:<><path d="M9 11V5a1.5 1.5 0 0 1 3 0v5m0 0V4a1.5 1.5 0 0 1 3 0v6m0 0V5a1.5 1.5 0 0 1 3 0v6m0-2a1.5 1.5 0 0 1 3 0v6c0 4-3 7-7 7-3 0-5-2-7-5l-3-4c-1-2 1-3 2-2l3 2v-3"/></>,
    select:<path d="m5 3 14 9-7 1-3 7-4-17Z"/>,
    fit:<><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></>,
    undo:<><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/></>,
    redo:<><path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/></>,
    map:<><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z"/><path d="M9 3v16M15 5v16"/></>,
    note:<><path d="M4 3h16v12l-5 6H4V3Z"/><path d="M15 21v-6h5M8 8h8M8 12h5"/></>,
    search:<><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    grid:<><path d="M3 8h18M3 16h18M8 3v18M16 3v18"/></>,
    layout:<><rect x="3" y="3" width="6" height="7" rx="1"/><rect x="15" y="3" width="6" height="7" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M9 6h6M9 18h9v-8"/></>,
    panel:<><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></>,
    play:<path d="m8 4 12 8-12 8V4Z"/>,
    image:<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-7 5 8"/></>,
    more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  };
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.more}</svg>;
}

function NodeAction({ node, action, children, tab, disabled, kind = 'video' }: { node: StudioNode; action: string; children: React.ReactNode; tab?: string; disabled?: boolean; kind?: 'prompt' | 'video' }) {
  return <button disabled={disabled} data-action={action} data-tab={tab} data-segment-id={node.segmentId} data-asset-id={node.assetId}
    data-state-id={node.stateId} data-role={node.role} data-artifact-id={node.artifactId} data-kind={kind}>{children}</button>;
}

function NodeDetails({node,project,episode,onClose,onPreview,onImport,onGenerate,referenceText,onBindVideo,onPickVideo,onTextImage}:{node:StudioNode;project:Project;episode:Episode;onClose:()=>void;onPreview:()=>void;onImport:(node:StudioNode)=>void;onGenerate:StudioCanvasProps['onGenerate'];referenceText:string;onBindVideo:(id:string)=>void;onPickVideo:(id:string)=>void;onTextImage:()=>void}) {
  const asset=project.assets?.find(a=>a.id===node.assetId);
  const [stateId,setStateId]=useState(node.stateId||''),[role,setRole]=useState(asset&&requiresPortraitReference(asset)?'turnaround':'main');
  const target={...node,stateId,role};
  const state=asset?.states.find(s=>s.id===stateId);
  const [feedback,setFeedback]=useState(referenceText),[count,setCount]=useState(1),[pending,setPending]=useState(false),[error,setError]=useState('');
  const previousReference=useRef(referenceText);
  useEffect(()=>{setFeedback(current=>current===previousReference.current?referenceText:current);previousReference.current=referenceText;},[referenceText]);
  const generate=async()=>{setPending(true);setError('');try{await onGenerate(target,{feedback,count});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending(false);}};
  const composer=<div className="mumu-node-composer"><label>视觉偏好 / 修改要求<textarea aria-label="节点生成要求" value={feedback} maxLength={500} placeholder="留空表示按当前描述再生成一版…" onChange={e=>setFeedback(e.target.value)}/></label><div><span title={node.type==='asset'?project.imageModel?.modelId:project.videoModel?.modelId}>{(node.type==='asset'?project.imageModel:project.videoModel)?.name||'尚未配置模型'}</span><label>数量<select aria-label="节点生成数量" value={count} onChange={e=>setCount(Number(e.target.value))}>{[1,2,3,4].map(n=><option key={n} value={n}>{n}版</option>)}</select></label></div><button disabled={pending||feedback.length>500||node.type==='video'&&!node.segmentId} onClick={()=>void generate()}>{pending?'准备中…':node.type==='asset'?'生图 · 核对后生成':node.media?'重做视频 · 核对后生成':'生成视频 · 核对后生成'}</button>{error&&<p role="alert">{error}</p>}<small>{node.type==='video'&&!node.segmentId?'先选择关联片段，再导入或生成。':'下一步核对完整输入和费用，再确认提交。'}</small></div>;
  return <section className="mumu-node-details" data-canvas-no-zoom aria-label="节点操作">
    <header><div><small>{kinds[node.type]}操作</small><strong>{node.title}</strong></div><button onClick={onClose} aria-label="关闭节点操作">×</button></header>
    <div className="mumu-details-body">
      {asset?<><p className="mumu-details-hint">选择状态和图片用途，再生成或比较对应版本。</p>
        <label>剧情状态<select aria-label="节点图片状态" value={stateId} onChange={e=>setStateId(e.target.value)}><option value="">基础状态</option>{asset.states.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label>图片用途<select aria-label="节点图片用途" value={role} onChange={e=>setRole(e.target.value)}>{requiresPortraitReference(asset)?<option value="turnaround">完整四视图＋大头照</option>:<option value="main">形态主图</option>}</select></label>
        <div className="mumu-details-buttons"><button disabled={!node.media} onClick={onPreview}>放大查看</button><NodeAction node={target} action="compare-bound-asset">比较历史版本</NodeAction><button onClick={()=>onImport(target)}>导入图片</button><NodeAction node={node} action="canvas-edit-asset">修改资产描述 / 状态</NodeAction></div>
        <small className="mumu-details-hint">生成 → 核对输入与费用 → 确认生成 → 审图 → 选用到片段。旧版本会保留。</small><h4>当前生成描述</h4><pre>{[asset.identity,state?.appearance,asset.voice&&`声线：${asset.voice}`].filter(Boolean).join('\n')||'请先填写资产描述'}</pre></>:
      node.type==='video'?<><p>{node.tags.join(' · ')}</p>{!episode.segments.length&&<p className="mumu-details-hint">现成剧本需先核对并建立正式片段，才能关联这个视频节点。<NodeAction node={node} action="graph-workflow" tab="script">用现成剧本建立片段</NodeAction></p>}{node.local&&<>
        <label>关联片段<select aria-label="工作视频关联片段" value={node.segmentId||''} onChange={e=>onBindVideo(e.target.value)}><option value="">请选择片段</option>{episode.segments.map(s=><option key={s.id} value={s.id}>片段 {s.number}</option>)}</select></label>
        <small className="mumu-details-hint">关联用于导入和生成，新节点不会自动带入已有视频。</small>
        {node.segmentId&&<label>节点视频<select aria-label="工作节点视频版本" value={node.artifactId||''} onChange={e=>onPickVideo(e.target.value)}><option value="">空节点 · 不使用已有视频</option>{episode.segments.find(s=>s.id===node.segmentId)?.artifacts.filter(a=>a.kind==='video').map((v,i)=><option key={v.id} value={v.id}>视频 v{i+1}{v.id===episode.segments.find(s=>s.id===node.segmentId)?.selected.video?' · 当前选用':''}</option>)}</select></label>}
      </>}<div className="mumu-details-buttons"><button disabled={!node.media} onClick={onPreview}>大窗播放</button><button disabled={!node.segmentId} onClick={()=>onImport(node)}>导入 / 替换 MP4</button><NodeAction node={node} disabled={!node.segmentId} action="compare-video">比较版本</NodeAction><NodeAction node={node} disabled={!node.artifactId} action="canvas-review-video">逐句审片</NodeAction>{node.artifactId&&!node.selected&&node.status!=='rejected'&&<NodeAction node={node} action="select-artifact">选用此版</NodeAction>}</div><small className="mumu-details-hint">重新生成会新增候选，满意后再选用。</small>{node.content&&<pre>{node.content}</pre>}</>:
      node.type==='shot'?<><div className="mumu-details-buttons"><NodeAction node={node} action="canvas-select-segment">编辑分镜 / 绑定资产</NodeAction>{node.status==='candidate'?<NodeAction node={node} action="prompt-manager-open">核对候选提示词</NodeAction>:<NodeAction node={node} action="graph-generate" kind="prompt">{node.status==='ready'?'更新提示词':'生成提示词'}</NodeAction>}<NodeAction node={node} action="compare-video">生成 / 比较视频</NodeAction><button onClick={()=>onImport(node)}>导入 MP4</button><button onClick={onPreview}>展开全文</button></div><h4>正式剧情与完整提示词</h4><pre>{node.content}</pre></>:
      <><button onClick={onPreview}>展开全文 / 预览</button>{node.type==='source'&&<NodeAction node={node} action="graph-workflow" tab="script">打开正式剧本</NodeAction>}{node.type==='note'&&<button onClick={onTextImage}>用此文本生图</button>}<pre>{node.content}</pre></>}
      {(node.type==='asset'||node.type==='video')&&composer}
    </div>
  </section>;
}

function StudioCanvas(props: StudioCanvasProps) {
  const {project, episode} = props, key = `${project.id}:${episode.id}`;
  const storageKey = `manju-native-canvas-v1:${key}`;
  const density:CanvasDensity='editing';
  const [compact,setCompact]=useState(()=>window.matchMedia('(max-width: 760px), (max-width: 900px) and (max-height: 500px)').matches);
  const [layout, setLayout] = useState<Layout>(() => {
    const old = readStored<Record<string, CanvasPoint>>(`manju-node-layout-v2:${key}`, {});
    return restoreCanvasLayout(readStored(storageKey,{points:old}));
  });
  const graph = useMemo(() => studioCanvas(project, episode, props.selectedSegmentId,layout.assetIds), [project, episode, props.selectedSegmentId,layout.assetIds]);
  const [viewport, setViewport] = useState<ViewportTransform>(() => {
    const saved = readStored<{viewport?:ViewportTransform}>(storageKey + ':view', {});
    const v = saved.viewport;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.k) && v.k >= .05 && v.k <= 5) return v;
    const old = readStored<{offset?:Position;zoom?:number}>(`manju-viewport:${key}`, {});
    return old.offset && Number.isFinite(old.offset.x) && Number.isFinite(old.offset.y) && Number.isFinite(old.zoom) ? {x:old.offset.x,y:old.offset.y,k:Math.max(.05,Math.min(5,old.zoom!))} : {x:35,y:60,k:.65};
  });
  const [selection, setSelection] = useState(new Set<string>());
  const [tool, setTool] = useState<'pan'|'select'>('pan');
  const [background, setBackground] = useState<'lines'|'dots'|'blank'>(() => readStored(storageKey+':background','lines'));
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [outline, setOutline] = useState(()=>!window.matchMedia('(max-width: 760px), (max-width: 900px) and (max-height: 500px)').matches), [showMap, setShowMap] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [size, setSize] = useState({width:1000,height:650});
  const [historyVersion, setHistoryVersion] = useState(0);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<StudioNode>();
  const [previewResolution,setPreviewResolution]=useState('');
  const previewPlayback=useRef({time:0,volume:1,muted:false,rate:1});
  const [detailsId,setDetailsId]=useState(''),[newAssetOpen,setNewAssetOpen]=useState(false);
  const [newAsset,setNewAsset]=useState<NewAsset>({kind:'character',name:'',identity:'',voice:''});
  const [creating,setCreating]=useState(false),[createError,setCreateError]=useState('');
  const [pendingAssetId,setPendingAssetId]=useState('');
  const [generateAfterCreate,setGenerateAfterCreate]=useState(false);
  const [menu, setMenu] = useState<{x:number;y:number;node?:StudioNode}>();
  const [lasso, setLasso] = useState<{start:Position;end:Position}>();
  const [connection, setConnection] = useState<{node:StudioNode;point:Position}>();
  const stage = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<StudioNode>(undefined);
  const state = useRef({layout,viewport,selection}); state.current = {layout,viewport,selection};
  const undo = useRef<Layout[]>([]), redo = useRef<Layout[]>([]);
  const gesture = useRef<{kind:'drag'|'resize'|'lasso'|'connect';pointerId:number;start:Position;before:Layout;origins?:Map<string,StudioNode>;node?:StudioNode;initial?:Set<string>}>(undefined);
  const nodes = useMemo(() => [...graph.nodes,...resolveWorkspaceNodes(layout.notes,episode,project)].map(node => {
    const point = layout.points[node.id];
    return presentCanvasNode({... (point ? {...node,position:{x:point.x,y:point.y},width:point.width || node.width,height:point.height || node.height} : node),fontSize:layout.fonts[node.id]||node.fontSize||14},density,Boolean(point?.width||point?.height));
  }), [graph, layout,density]);
  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id,n])), [nodes]);
  const nodeRef = useRef(nodes); nodeRef.current = nodes;
  const initiallyPositioned = useRef(Boolean(localStorage.getItem(storageKey+':view')));
  const visibleNodes = nodes.filter(n => !layout.hiddenIds.includes(n.id)&&(n.local||showHistory || n.type !== 'video' || n.selected || !nodes.some(other => other.type==='video' && other.segmentId===n.segmentId && other.selected)));
  const visibleIds = new Set(visibleNodes.map(n=>n.id));
  const allConnections=[...graph.connections,...layout.connections];
  const selectedNode = selection.size===1?nodes.find(n => selection.has(n.id)):undefined;
  const detailsNode=selection.size===1&&selectedNode?.id===detailsId?selectedNode:undefined;
  const openPreview = (node:StudioNode) => {
    const player=[...(root.current?.querySelectorAll('video')||[])].find(p=>p.getAttribute('src')===node.media);
    previewPlayback.current=player?{time:player.currentTime,volume:player.volume,muted:player.muted,rate:player.playbackRate}:{time:0,volume:1,muted:false,rate:1};
    root.current?.querySelectorAll('video').forEach(player=>player.pause());
    setPreviewResolution('');setDetailsId('');
    setPreview(node);
  };
  const busyGesture = () => !!gesture.current;

  useEffect(() => {
    const timer=window.setTimeout(()=>{try{localStorage.setItem(storageKey,JSON.stringify(layout));}catch{setMessage('本机画布存储已满，当前编辑仍保留在窗口中');}},250);
    return ()=>clearTimeout(timer);
  }, [layout,storageKey]);
  useEffect(() => {
    const timer=window.setTimeout(()=>localStorage.setItem(storageKey+':view',JSON.stringify({viewport})),250);
    return ()=>clearTimeout(timer);
  }, [viewport,storageKey]);
  useEffect(()=>()=>{
    localStorage.setItem(storageKey,JSON.stringify(state.current.layout));
    localStorage.setItem(storageKey+':view',JSON.stringify({viewport:state.current.viewport}));
  },[storageKey]);
  useEffect(() => {localStorage.setItem(storageKey+':background',JSON.stringify(background));},[background,storageKey]);
  useEffect(()=>{const query=window.matchMedia('(max-width: 760px), (max-width: 900px) and (max-height: 500px)');const change=()=>{setCompact(query.matches);setOutline(!query.matches);};query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const observer = new ResizeObserver(() => setSize({width:element.clientWidth,height:element.clientHeight}));
    observer.observe(element);return () => observer.disconnect();
  }, []);
  useEffect(() => { if(!message) return; const timer=window.setTimeout(()=>setMessage(''),6000);return()=>clearTimeout(timer);}, [message]);
  useEffect(()=>{
    if(!preview&&!newAssetOpen)return;
    const previous=document.activeElement as HTMLElement|null,dialog=root.current?.querySelector<HTMLElement>('[role="dialog"]');
    if(!dialog)return;
    const targets=()=>[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length>0);
    targets()[0]?.focus();
    const keepFocus=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const items=targets(),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}};
    dialog.addEventListener('keydown',keepFocus);
    return()=>{dialog.removeEventListener('keydown',keepFocus);if(previous?.isConnected)previous.focus();};
  },[Boolean(preview),newAssetOpen]);
  useEffect(()=>{
    if(initiallyPositioned.current || !stage.current || size.width<100)return;
    initiallyPositioned.current=true;
    const first=nodes.find(n=>n.type==='shot'&&n.segmentId===props.selectedSegmentId)||nodes.find(n=>n.type==='shot');
    const target=first?nodes.filter(n=>n.id===first.id||n.type==='video'&&n.segmentId===first.segmentId&&(n.selected||n.status==='missing')):nodes.filter(n=>n.type==='source');
    const fitted=fitCanvasNodes(target.map(n=>({left:n.position.x,top:n.position.y,width:n.width,height:n.height})),size,.95);
    if(fitted)setViewport({x:fitted.offset.x,y:fitted.offset.y,k:fitted.zoom});
  },[size, nodes, props.selectedSegmentId]);
  useEffect(()=>{
    const cancel=()=>{if(gesture.current){setLayout(gesture.current.before);gesture.current=undefined;setLasso(undefined);setConnection(undefined);}};
    window.addEventListener('blur',cancel);return()=>window.removeEventListener('blur',cancel);
  },[]);
  useEffect(()=>{
    const node=nodeRef.current.find(n=>n.id===detailsId);if(!node)return;
    const available=compact?size.width:Math.max(250,size.width-(size.width<850?330:385));
    setViewport(v=>({...v,x:available/2-(node.position.x+node.width/2)*v.k}));
  },[detailsId]);

  const record = useCallback((before:Layout) => {
    undo.current.push(before);redo.current=[];setHistoryVersion(v=>v+1);
  }, []);
  const deselect = useCallback(()=>{setSelection(new Set());setDetailsId('');},[]);
  const requestImport = (node:StudioNode) => {
    if(node.type==='video'&&!node.segmentId){setSelection(new Set([node.id]));setDetailsId(node.id);setMessage('先选择关联片段，再导入视频');return;}
    importTarget.current=node;setSelection(new Set([node.id]));props.onSelect(node);
    if(importInput.current){importInput.current.accept=node.type==='asset'?'image/png,image/jpeg,image/webp':'.mp4';importInput.current.click();}
  };
  const restore = useCallback((direction:'undo'|'redo') => {
    if (busyGesture()) return;
    const from=direction==='undo'?undo:redo, to=direction==='undo'?redo:undo;
    const next=from.current.pop(); if (!next) return;
    to.current.push(state.current.layout);setLayout(next);setHistoryVersion(v=>v+1);
  }, []);
  const fit = useCallback((selectedOnly=false) => {
    const target=nodeRef.current.filter(n=>!state.current.layout.hiddenIds.includes(n.id)&&(selectedOnly?state.current.selection.has(n.id):n.local||showHistory||n.type!=='video'||n.selected||!nodeRef.current.some(other=>other.type==='video'&&other.segmentId===n.segmentId&&other.selected)));
    const element=stage.current;if (!element || !target.length) return;
    const fitted=fitCanvasNodes(target.map(n=>({left:n.position.x,top:n.position.y,width:n.width,height:n.height})),{width:element.clientWidth,height:element.clientHeight},selectedOnly?1.3:1);
    if(fitted)setViewport({x:fitted.offset.x,y:fitted.offset.y,k:fitted.zoom});
  }, [showHistory]);
  useEffect(()=>{
    if(!showHistory)setSelection(selected=>new Set([...selected].filter(id=>{
      const n=nodeRef.current.find(node=>node.id===id);
      return n&&(n.local||n.type!=='video'||n.selected||!nodeRef.current.some(other=>other.type==='video'&&other.segmentId===n.segmentId&&other.selected));
    })));
  },[showHistory]);
  const focus = (node:StudioNode) => {
    if(compact)setOutline(false);
    if(node.type==='video'&&!node.selected)setShowHistory(true);
    setSelection(new Set([node.id]));props.onSelect(node);
    setDetailsId(node.id);
    const available=compact?size.width:Math.max(250,size.width-(size.width<850?330:385));
    setViewport(v=>({...v,x:available/2-(node.position.x+node.width/2)*v.k,y:size.height/2-(node.position.y+node.height/2)*v.k}));
  };
  const world = (x:number,y:number) => {
    const rect=stage.current!.getBoundingClientRect(), v=state.current.viewport;
    return {x:(x-rect.left-v.x)/v.k,y:(y-rect.top-v.y)/v.k};
  };
  const addNote = () => {
    const v=state.current.viewport, center={x:(size.width/2-v.x)/v.k,y:(size.height/2-v.y)/v.k};
    const note:StudioNode={id:`note:${crypto.randomUUID()}`,type:'note',title:'文本节点',content:'',tags:['制作文本'],position:center,width:290,height:230,local:true};
    record(state.current.layout);setLayout(l=>({...l,notes:[...l.notes,note]}));setSelection(new Set([note.id]));setMenu(undefined);
  };
  const addVideo=()=>{
    const v=state.current.viewport;
    const node:StudioNode={id:`workspace:${crypto.randomUUID()}`,type:'video',title:'视频工作节点',content:'',tags:['工作节点'],position:{x:(size.width/2-v.x)/v.k-162.5,y:(size.height/2-v.y)/v.k-155},width:325,height:310,local:true};
    record(state.current.layout);setLayout(l=>({...l,notes:[...l.notes,node]}));setSelection(new Set([node.id]));setDetailsId(node.id);setMenu(undefined);
  };
  const addImage=()=>{setNewAsset({kind:'character',name:'',identity:'',voice:''});setGenerateAfterCreate(false);setNewAssetOpen(true);setCreateError('');setMenu(undefined);};
  const removeNodes=(ids:Set<string>)=>{
    record(state.current.layout);setLayout(l=>({...l,notes:l.notes.filter(n=>!ids.has(n.id)),hiddenIds:[...new Set([...l.hiddenIds,...nodes.filter(n=>ids.has(n.id)&&!n.local).map(n=>n.id)])],connections:l.connections.filter(c=>!ids.has(c.fromNodeId)&&!ids.has(c.toNodeId))}));setSelection(new Set());setDetailsId('');setMenu(undefined);setMessage('已从画布移除，可撤销；正式剧本和媒体版本保留');
  };
  const duplicate=(node:StudioNode)=>{const copy=duplicateCanvasNode(node,`workspace:${crypto.randomUUID()}`);record(state.current.layout);setLayout(l=>({...l,notes:[...l.notes,copy]}));setSelection(new Set([copy.id]));setDetailsId('');};
  const saveAsset=(node:StudioNode)=>{record(state.current.layout);setLayout(l=>({...l,library:[...l.library.filter(n=>n.id!==node.id),{...node}]}));setFilter('library');setMessage('已存入画布素材库，可从左侧再次加入画布');};
  const resizeNode=(node:StudioNode,factor:number)=>{record(state.current.layout);setLayout(l=>({...l,points:{...l.points,[node.id]:{...node.position,width:Math.max(220,Math.min(900,node.width*factor)),height:Math.max(180,Math.min(900,node.height*factor))}}}));};
  const fontNode=(node:StudioNode,amount:number)=>{record(state.current.layout);setLayout(l=>({...l,fonts:{...l.fonts,[node.id]:Math.max(10,Math.min(36,(node.fontSize||13)+amount))}}));};
  const prepareTextImage=(node:StudioNode)=>{setNewAsset({kind:'prop',name:node.title==='文本节点'?'新图片资产':node.title,identity:node.content,voice:''});setGenerateAfterCreate(true);setNewAssetOpen(true);setCreateError('');};
  const restoreLibrary=(node:StudioNode)=>{
    const existing=nodes.find(n=>n.id===node.id);record(state.current.layout);
    const restored=existing|| (node.local?node:duplicateCanvasNode(node,`workspace:${crypto.randomUUID()}`));
    setLayout(l=>({...l,hiddenIds:l.hiddenIds.filter(id=>id!==node.id),...(!existing?{notes:[...l.notes,{...restored,local:true}]}:{})}));focus(restored);setFilter('all');
  };
  const includeAsset = (assetId:string,input?:{kind:string;identity:string}) => {
    const v=state.current.viewport,point={x:(size.width/2-v.x)/v.k-135,y:(size.height/2-v.y)/v.k-155};
    for(let attempt=0;attempt<100&&nodeRef.current.some(n=>point.x<n.position.x+n.width+20&&point.x+295>n.position.x&&point.y<n.position.y+n.height+20&&point.y+330>n.position.y);attempt++)point.x+=315;
    const asset=props.project.assets?.find(a=>a.id===assetId)||input,role=asset&&requiresPortraitReference(asset)?'turnaround':'main';
    const id=`asset:${assetId}:${role}`;
    if(!nodeRef.current.some(n=>n.id===id)){record(state.current.layout);setLayout(l=>({...l,assetIds:[...new Set([...l.assetIds,assetId])],points:{...l.points,[id]:point}}));}
    setPendingAssetId(assetId);setNewAssetOpen(false);
  };
  useEffect(()=>{
    if(!pendingAssetId)return;
    const node=nodes.find(n=>n.assetId===pendingAssetId);if(!node)return;
    setPendingAssetId('');focus(node);
  },[nodes,pendingAssetId]);
  const createAsset=async()=>{
    setCreating(true);setCreateError('');
    try{const assetId=await props.onCreateAsset(newAsset);includeAsset(assetId,newAsset);setNewAsset({kind:'character',name:'',identity:'',voice:''});setMessage('资产已加入画布；可生成或导入图片，再连到片段绑定');if(generateAfterCreate){const role=requiresPortraitReference(newAsset)?'turnaround':'main';await props.onGenerate({id:`asset:${assetId}:${role}`,type:'asset',assetId,role,stateId:'',segmentId:props.selectedSegmentId||episode.segments[0]?.id,title:newAsset.name,content:newAsset.identity,tags:[],position:{x:0,y:0},width:275,height:310},{feedback:'',count:1});}setGenerateAfterCreate(false);}
    catch(e){setCreateError(e instanceof Error?e.message:String(e));}finally{setCreating(false);}
  };
  const arrange = () => {record(state.current.layout);setLayout(l=>({...l,points:{}}));setMenu(undefined);setMessage('已按制作流程整理节点，可撤销');};
  const selectNode = (event:React.PointerEvent,node:StudioNode) => {
    if (editTarget(event.target) || (event.target as Element).closest('button,a')) return;
    event.preventDefault();event.stopPropagation();root.current?.focus();setMenu(undefined);
    let next = new Set(state.current.selection);
    if(event.shiftKey){if(next.has(node.id))next.delete(node.id);else next.add(node.id);}
    else if(!next.has(node.id))next=new Set([node.id]);
    setSelection(next);props.onSelect(node);
    const origins=new Map(nodeRef.current.filter(n=>next.has(n.id)).map(n=>[n.id,n]));
    gesture.current={kind:'drag',pointerId:event.pointerId,start:{x:event.clientX,y:event.clientY},before:state.current.layout,origins,node,initial:next};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const startResize = (event:React.PointerEvent,node:StudioNode) => {
    event.preventDefault();event.stopPropagation();root.current?.focus();
    gesture.current={kind:'resize',pointerId:event.pointerId,start:{x:event.clientX,y:event.clientY},before:state.current.layout,node};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const startConnect = (event:React.PointerEvent,node:StudioNode) => {
    event.preventDefault();event.stopPropagation();root.current?.focus();
    gesture.current={kind:'connect',pointerId:event.pointerId,start:{x:event.clientX,y:event.clientY},before:state.current.layout,node};
    setConnection({node,point:world(event.clientX,event.clientY)});event.currentTarget.setPointerCapture(event.pointerId);
  };
  const startLasso = (event:React.PointerEvent) => {
    root.current?.focus();setMenu(undefined);const point=world(event.clientX,event.clientY);
    gesture.current={kind:'lasso',pointerId:event.pointerId,start:point,before:state.current.layout,initial:event.shiftKey?new Set(state.current.selection):new Set()};
    setLasso({start:point,end:point});
  };
  const move = (event:React.PointerEvent) => {
    const g=gesture.current;if(!g || event.pointerId!==g.pointerId)return;
    const dx=(event.clientX-g.start.x)/state.current.viewport.k,dy=(event.clientY-g.start.y)/state.current.viewport.k;
    if(g.kind==='drag'&&Math.hypot(event.clientX-g.start.x,event.clientY-g.start.y)>4)setLayout(l=>({ ...l,points:{...l.points,...Object.fromEntries([...g.origins!].map(([id,n])=>[id,{...l.points[id],x:n.position.x+dx,y:n.position.y+dy}]))} }));
    else if(g.kind==='resize'){const n=g.node!;setLayout(l=>({...l,points:{...l.points,[n.id]:{...n.position,width:Math.max(200,n.width+dx),height:Math.max(160,n.height+dy)}}}));}
    else if(g.kind==='connect')setConnection({node:g.node!,point:world(event.clientX,event.clientY)});
    else {const end=world(event.clientX,event.clientY);setLasso({start:g.start,end});
      const picked=nodesInMarquee(visibleNodes.map(n=>({id:n.id,left:n.position.x,top:n.position.y,width:n.width,height:n.height})),g.start,end);
      setSelection(new Set([...g.initial!,...picked]));}
  };
  const finish = (event:React.PointerEvent) => {
    const g=gesture.current;if(!g || event.pointerId!==g.pointerId)return;
    gesture.current=undefined;setLasso(undefined);setConnection(undefined);
    if(event.type==='pointercancel'){setLayout(g.before);if(g.initial)setSelection(g.initial);return;}
    if(g.kind==='drag'||g.kind==='resize') {if(JSON.stringify(g.before)!==JSON.stringify(state.current.layout))record(g.before);}
    if(g.kind==='drag'&&Math.hypot(event.clientX-g.start.x,event.clientY-g.start.y)<=4&&g.initial?.size===1){
      if(g.node!.type==='note'||g.node!.type==='video'&&!g.node!.media)setDetailsId(g.node!.id);else openPreview(g.node!);
    }
    if(g.kind==='connect'){
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-node-id]');
      const to=nodeRef.current.find(n=>n.id===target?.dataset.nodeId);
      if(to&&to.id!==g.node!.id){
        const from=g.node!;
        if(from.type==='note'||to.type==='note'||to.local&&to.type==='video'&&!to.artifactId){
          record(state.current.layout);setLayout(l=>({...l,notes:l.notes.map(n=>n.id===to.id&&n.type==='video'&&from.type==='shot'?{...n,segmentId:from.segmentId}:n),connections:[...l.connections.filter(c=>!(c.fromNodeId===from.id&&c.toNodeId===to.id)),{id:`workspace:${from.id}:${to.id}`,fromNodeId:from.id,toNodeId:to.id,kind:'workspace'}]}));setMessage('制作连线已保存；文字参考可在节点生成面板中核对');
        }else void props.onConnect(from.local?{...from,id:from.type==='video'?`video:${from.artifactId}`:from.id}:from,to.local&&to.type==='video'?{...to,id:`video:${to.artifactId}`}:to).catch(e=>setMessage(e.message));
      }
      else setMessage('把连线拖到片段或同片段的视频版本');
    }
  };
  const keyDown = (event:React.KeyboardEvent) => {
    if(event.key==='Escape'){if(gesture.current){setLayout(gesture.current.before);gesture.current=undefined;}setSelection(new Set());setLasso(undefined);setConnection(undefined);setMenu(undefined);setPreview(undefined);setDetailsId('');if(!creating)setNewAssetOpen(false);if(compact)setOutline(false);root.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu=>menu.open=false);return;}
    if(editTarget(event.target))return;
    const mod=event.ctrlKey||event.metaKey;
    if(mod&&event.key.toLowerCase()==='a'){event.preventDefault();setSelection(new Set(visibleNodes.map(n=>n.id)));}
    else if(mod&&event.key.toLowerCase()==='z'){event.preventDefault();restore(event.shiftKey?'redo':'undo');}
    else if(mod&&event.key.toLowerCase()==='y'){event.preventDefault();restore('redo');}

    else if(event.key.toLowerCase()==='v')setTool('select');
    else if(event.key.toLowerCase()==='h')setTool('pan');
    else if(event.key.toLowerCase()==='f'){event.preventDefault();fit(event.shiftKey);}
    else if(event.key==='Delete'&&selection.size){event.preventDefault();removeNodes(selection);}
    else if(mod&&event.key.toLowerCase()==='d'&&selectedNode){event.preventDefault();duplicate(selectedNode);}
  };
  const importFile = async (file:File,node?:StudioNode) => {
    if(!node){setMessage('先选中资产节点导入图片，或选中片段节点导入 MP4');return;}
    if(node.type==='video'&&!node.segmentId){setSelection(new Set([node.id]));setDetailsId(node.id);setMessage('先选择关联片段，再导入视频');return;}
    try{
      const importedId=await props.onImport(file,node);
      if(node.local&&importedId&&['video','asset'].includes(node.type)){
        record(state.current.layout);setLayout(l=>({...l,notes:l.notes.map(n=>n.id===node.id?{...n,...(node.type==='video'?{artifactId:importedId}:{imageId:importedId,stateId:node.stateId,role:node.role})}:n)}));
      }
      setMessage('素材已导入，请核对并选用');
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}
  };
  const zoom = (k:number) => setViewport(v=>{
    const next=Math.max(.05,Math.min(5,k)), ratio=next/v.k;
    return {x:size.width/2-(size.width/2-v.x)*ratio,y:size.height/2-(size.height/2-v.y)*ratio,k:next};
  });
  const items=(filter==='library'?layout.library:nodes.filter(n=>!layout.hiddenIds.includes(n.id))).filter(n=>(filter==='all'||filter==='library'||n.type===filter)&&`${n.title} ${n.content}`.toLowerCase().includes(query.toLowerCase()));
  const svgSize={width:Math.max(800,...nodes.map(n=>n.position.x+n.width+100)),height:Math.max(600,...nodes.map(n=>n.position.y+n.height+100))};
  const toolbar = (name:string,label:string,click:()=>void,active=false,disabled=false) => <button title={label} aria-label={label} aria-pressed={['hand','select','map'].includes(name)?active:undefined} className={active?'active':''} onClick={click} disabled={disabled}><Icon name={name}/></button>;
  const floatingTop=selectedNode?Math.max(76,Math.min(size.height-64,viewport.y+selectedNode.position.y*viewport.k-52)):76;
  void historyVersion;

  return <div className="studio-native-canvas" data-density={density} ref={root} tabIndex={0} onKeyDown={keyDown} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
    <nav className="mumu-command-bar" aria-label="制作导航" data-canvas-no-zoom>
      <div className="mumu-command-context"><button data-action="tab" data-tab="episodes" title="返回项目分集">← 项目</button><strong title={`EP ${episode.number} · ${episode.title}`}>EP {episode.number} · {episode.title}</strong><span className="mumu-audit-status">{props.auditLabel}</span></div>
      <div className="mumu-command-actions"><button className={props.activeTab==='source'?'active':''} data-action="graph-workflow" data-tab="source">原文与高光</button><button className={props.activeTab==='script'?'active':''} data-action="graph-workflow" data-tab="script">正式剧本</button><button className={props.activeTab==='canvas'?'active':''} data-action="graph-workflow-close">制作画布</button><button className={props.activeTab==='assets'?'active':''} data-action="graph-workflow" data-tab="assets">资产库</button><i/><button className="mumu-add-asset" onClick={()=>{setGenerateAfterCreate(false);setNewAssetOpen(true);setCreateError('');}}>＋ 新增资产</button><button data-action="graph-jobs">生成任务</button><button data-action="canvas-view" data-view="table">版本与审片</button><button data-action="prompt-manager-open">提示词管理</button><button className={props.activeTab==='export'?'active':''} data-action="graph-workflow" data-tab="export">剪映导出</button><details className="mumu-command-more" onClick={closeNativeMenu}><summary>更多 ▾</summary><div><div className="mumu-mobile-menu-actions"><button data-action="graph-workflow" data-tab="source">原文与高光</button><button data-action="graph-workflow" data-tab="script">正式剧本</button><button data-action="graph-workflow-close">制作画布</button><button data-action="graph-workflow" data-tab="assets">资产库</button><button data-action="graph-jobs">生成任务</button><button data-action="canvas-view" data-view="table">版本与审片</button><button data-action="prompt-manager-open">提示词管理</button><button data-action="graph-workflow" data-tab="export">剪映导出</button></div><button onClick={addNote}>新增文本节点</button><button onClick={addImage}>新增图片节点</button><button onClick={addVideo}>新增视频节点</button><button onClick={()=>setFilter('library')}>画布素材库</button><button className={showHistory?'active':''} onClick={()=>setShowHistory(v=>!v)}>{showHistory?'收起历史版本':'历史版本'}</button>{layout.hiddenIds.length>0&&<button onClick={()=>{record(layout);setLayout(l=>({...l,hiddenIds:[]}));}}>恢复已移除节点（{layout.hiddenIds.length}）</button>}<button data-action="graph-workflow" data-tab="effects">特效库</button></div></details></div>
    </nav>
    {outline&&<aside className="mumu-outline" data-canvas-no-zoom>
      <div className="mumu-outline-heading"><strong>画布元素</strong><button title="收起元素面板" aria-label="收起元素面板" onClick={()=>setOutline(false)}><Icon name="panel"/></button></div>
      <div className="mumu-outline-tabs"><button aria-pressed={filter==='all'} className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>全部</button><button aria-pressed={filter==='asset'} className={filter==='asset'?'active':''} onClick={()=>setFilter('asset')}>资产</button><button aria-pressed={filter==='shot'} className={filter==='shot'?'active':''} onClick={()=>setFilter('shot')}>片段</button><button aria-pressed={filter==='video'} className={filter==='video'?'active':''} onClick={()=>setFilter('video')}>视频</button><button aria-pressed={filter==='library'} className={filter==='library'?'active':''} onClick={()=>setFilter('library')}>素材库</button></div>
      <label className="mumu-search"><Icon name="search"/><input aria-label="搜索画布节点" placeholder="搜索名称、对白、提示词" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="mumu-outline-list">{items.map(n=><button key={n.id} className={`mumu-outline-item ${selection.has(n.id)?'active':''}`} onClick={()=>filter==='library'?restoreLibrary(n):focus(n)}><span className={`mumu-kind-dot ${n.type}`}/><span>{n.title}<small>{filter==='library'?'点击加入画布':n.type==='video'?n.tags[0]:n.tags.slice(0,2).join(' · ')}</small></span>{n.selected&&<span className="mumu-check">✓</span>}</button>)}{!items.length&&<p className="mumu-muted">{filter==='library'?'在节点工具条点“存资产”，收集文字、图片和视频':'没有匹配的节点'}</p>}</div>
      <div className="mumu-outline-footer"><span>{nodes.filter(n=>!layout.hiddenIds.includes(n.id)).length} 个节点 · {allConnections.length} 条关系</span><span>布局与画布素材自动保存到本机</span></div>
    </aside>}
    <div className="mumu-canvas-area">
      {!episode.segments.length&&<section className="mumu-empty-flow" data-canvas-no-zoom aria-label="建立视频片段"><strong>现成剧本与图片已准备好？</strong><p>文字和图片节点可继续使用。先将现成剧本录入正式剧情节点，核对后锁定并建立片段；每个片段都会显示提示词和视频生成入口。</p><button data-action="graph-workflow" data-tab="script">用现成剧本建立片段</button></section>}
      <InfiniteCanvas containerRef={stage} viewport={viewport} tool={tool} backgroundMode={background}
        onViewportChange={setViewport} onCanvasMouseDown={startLasso} onCanvasDeselect={deselect}
        onCanvasDoubleClick={()=>addNote()} onContextMenu={event=>{event.preventDefault();const r=root.current!.getBoundingClientRect();setMenu({x:event.clientX-r.left,y:event.clientY-r.top});}}
        onDrop={event=>{event.preventDefault();const id=(event.target as Element).closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;const node=nodes.find(n=>n.id===id)||selectedNode;const files=[...event.dataTransfer.files];if(files.length!==1){setMessage('每次导入一个素材，便于核对版本');return;}void importFile(files[0],node);}}>
        <svg className="mumu-connections" {...svgSize}>{allConnections.map(c=>{const from=nodeById.get(c.fromNodeId),to=nodeById.get(c.toNodeId),focused=isFocusedConnection(c,selection);return from&&to&&visibleIds.has(c.fromNodeId)&&visibleIds.has(c.toNodeId)?<g key={c.id} className={`mumu-edge ${c.kind} ${focused?'is-focused':'is-muted'}`}><ConnectionPath connection={c} from={from} to={to} active={focused} onSelect={()=>focus(to)}/></g>:null;})}
          {connection&&<ActiveConnectionPath node={connection.node} handle={{nodeId:connection.node.id,handleType:'source'}} mouseWorld={connection.point}/>}</svg>
        {visibleNodes.map(node=><article key={node.id} data-node-id={node.id} data-segment-id={node.segmentId} className={`mumu-node ${node.type} ${selection.has(node.id)?'is-selected':''} ${node.selected?'is-chosen':''} ${node.status==='rejected'?'is-rejected':''}`} style={{left:node.position.x,top:node.position.y,width:node.width,height:node.height}}
          onPointerDown={event=>selectNode(event,node)} onDoubleClick={event=>{if(!(event.target as Element).closest('button,input,textarea,select,video'))openPreview(node);}} onContextMenu={event=>{event.preventDefault();event.stopPropagation();const r=root.current!.getBoundingClientRect();setSelection(new Set([node.id]));props.onSelect(node);setMenu({x:event.clientX-r.left,y:event.clientY-r.top,node});}}>
          <div className="mumu-node-heading"><span className={`mumu-kind-dot ${node.type}`}/>{node.local&&node.type==='note'?<input aria-label="文本节点名称" value={node.title} maxLength={80} onFocus={()=>record(layout)} onChange={e=>setLayout(l=>({...l,notes:l.notes.map(n=>n.id===node.id?{...n,title:e.target.value}:n)}))}/>:<strong>{node.title}</strong>}{node.selected?<span className="mumu-selected-badge">已选用</span>:<small>{node.local?'工作节点':kinds[node.type]}</small>}</div>
          <div className="mumu-node-content">
            {node.type==='video'&&node.media?<video src={node.media} controls controlsList="nofullscreen" playsInline preload="metadata" onClickCapture={e=>{if(e.detail===2){e.preventDefault();e.stopPropagation();openPreview(node);}}} onDoubleClick={e=>{e.preventDefault();e.stopPropagation();openPreview(node);}}/>:
              node.media?<button className="mumu-media" aria-label={`放大查看${node.title}`} onClick={()=>{setSelection(new Set([node.id]));props.onSelect(node);openPreview(node);}}><img src={node.media} alt={node.title} loading="lazy" draggable={false}/></button>:
              node.type==='asset'?<button className="mumu-empty-media" onClick={()=>requestImport(node)}>＋ 导入参考图</button>:node.type==='video'?<button className="mumu-empty-media" onClick={()=>{setSelection(new Set([node.id]));setDetailsId(node.id);}}>空视频节点<br/>点击导入或生成</button>:null}
            {node.type==='note'?<textarea aria-label="节点文本" style={{fontSize:node.fontSize}} value={node.content} placeholder="双击或直接输入文字、图片描述、制作备注…" onFocus={()=>{setSelection(new Set([node.id]));record(layout);}} onChange={e=>setLayout(l=>({...l,notes:l.notes.map(n=>n.id===node.id?{...n,content:e.target.value}:n)}))}/>:
              !node.media&&!['asset','video'].includes(node.type)?<div className="mumu-node-text" style={{fontSize:node.fontSize}}>{node.content||'请先完成正式分镜'}</div>:null}
          </div>
          <div className="mumu-node-tags">{node.tags.map((t,i)=><span key={i}>{t}</span>)}</div>
          <div className="mumu-node-actions">
            {node.type==='shot'?<><NodeAction node={node} action="canvas-select-segment">编辑分镜</NodeAction>{node.status==='candidate'?<NodeAction node={node} action="prompt-manager-open">核对候选提示词</NodeAction>:<NodeAction node={node} action="graph-generate" kind="prompt">{node.status==='ready'?'更新提示词':'生成提示词'}</NodeAction>}</>:
              node.type==='asset'||node.type==='video'?<button onClick={()=>{setSelection(new Set([node.id]));props.onSelect(node);setDetailsId(node.id);}}>{node.type==='asset'?'资产设置':'视频操作'}</button>:
              node.type==='source'?<NodeAction node={node} action="graph-workflow" tab="script">查看正式剧本</NodeAction>:
              node.type==='anchor'?<NodeAction node={node} action="graph-review-anchors">核对动作板</NodeAction>:<button onClick={()=>prepareTextImage(node)}>用文本生图</button>}
          </div>
          {['shot','asset','note','video'].includes(node.type)&&<button className="mumu-handle output" aria-label={`从${node.title}拖出连线`} title={node.type==='asset'?'拖到片段绑定参考图':node.type==='note'?'拖到节点作为文字参考':'拖到同片段视频选用版本'} onPointerDown={e=>startConnect(e,node)}/>}
          {['shot','video','asset','note'].includes(node.type)&&<span className="mumu-handle input" title="输入端口"/>}
          {selection.has(node.id)&&<button className="mumu-resize" aria-label={`调整${node.title}大小`} onPointerDown={e=>startResize(e,node)}/>}
        </article>)}
        {lasso&&<div className="mumu-lasso" style={{left:Math.min(lasso.start.x,lasso.end.x),top:Math.min(lasso.start.y,lasso.end.y),width:Math.abs(lasso.end.x-lasso.start.x),height:Math.abs(lasso.end.y-lasso.start.y)}}/>}
      </InfiniteCanvas>
      <div className="mumu-canvas-top" data-canvas-no-zoom><div className="mumu-top-left">{!outline&&toolbar('panel','显示元素面板',()=>setOutline(true))}<span className="mumu-canvas-label">编辑画布</span><span className="mumu-muted">{selection.size?`已选 ${selection.size} 个节点`:`${episode.segments.length} 个片段`}</span></div></div>
      {selectedNode&&<div className="mumu-node-floating mumu-node-floating-screen" data-canvas-no-zoom style={{left:Math.max(12,Math.min(size.width-350,viewport.x+selectedNode.position.x*viewport.k)),top:floatingTop}}>
        <button onClick={()=>setDetailsId(selectedNode.id)}>信息</button><button onClick={()=>openPreview(selectedNode)}>放大查看</button>{selectedNode.type==='note'&&<button onClick={()=>prepareTextImage(selectedNode)}>生图</button>}
        <details className="mumu-node-more" onClick={closeNativeMenu}><summary>更多</summary><div style={{top:compact||floatingTop>size.height/2?'auto':'calc(100% + 6px)',bottom:compact||floatingTop>size.height/2?'calc(100% + 6px)':'auto'}}><button onClick={()=>duplicate(selectedNode)}>复制</button><button onClick={()=>saveAsset(selectedNode)}>存资产</button>{(selectedNode.type!=='video'||selectedNode.media)&&<a href={selectedNode.media||`data:text/plain;charset=utf-8,${encodeURIComponent(selectedNode.content)}`} download={`${selectedNode.title}.${selectedNode.type==='video'?'mp4':selectedNode.media?'png':'txt'}`}>下载</a>}{selectedNode.type==='note'?<><button onClick={()=>fontNode(selectedNode,-1)}>− 字号</button><button onClick={()=>fontNode(selectedNode,1)}>＋ 字号</button></>:<><button onClick={()=>resizeNode(selectedNode,.85)}>− 缩小</button><button onClick={()=>resizeNode(selectedNode,1.15)}>＋ 放大</button></>}<button className="mumu-remove" onClick={()=>removeNodes(new Set([selectedNode.id]))}>{selectedNode.local?'删除':'移除'}</button></div></details>
      </div>}
      {detailsNode&&<NodeDetails key={`${detailsNode.id}:${detailsNode.stateId}:${detailsNode.role}`} node={detailsNode} project={project} episode={episode} onClose={()=>setDetailsId('')} onPreview={()=>openPreview(detailsNode)} onImport={requestImport} onGenerate={props.onGenerate} referenceText={layout.connections.filter(c=>c.toNodeId===detailsNode.id).map(c=>nodeById.get(c.fromNodeId)).filter(n=>n?.type==='note').map(n=>n!.content).join('\n')} onBindVideo={segmentId=>{record(layout);setLayout(l=>({...l,notes:l.notes.map(n=>n.id===detailsNode.id?{...n,segmentId:segmentId||undefined,artifactId:undefined,media:undefined,selected:false}:n)}));}} onPickVideo={artifactId=>{record(layout);setLayout(l=>({...l,notes:l.notes.map(n=>n.id===detailsNode.id?{...n,artifactId:artifactId||undefined}:n)}));}} onTextImage={()=>prepareTextImage(detailsNode)}/>}
      {showMap&&<Minimap nodes={visibleNodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport}/>}
      <div className="mumu-zoom-tools" data-canvas-no-zoom>{toolbar('fit','适应全部节点 · F',()=>fit())}{toolbar('map','小地图',()=>setShowMap(v=>!v),showMap)}<button title="缩小" aria-label="缩小" onClick={()=>zoom(viewport.k/1.15)}>−</button><input type="range" min="5" max="500" value={Math.round(viewport.k*100)} aria-label="画布缩放" onChange={e=>zoom(Number(e.target.value)/100)}/><button title="放大" aria-label="放大" onClick={()=>zoom(viewport.k*1.15)}>＋</button><button className="mumu-zoom-value" title="恢复 100%" onClick={()=>zoom(1)}>{Math.round(viewport.k*100)}%</button></div>
      <div className="mumu-toolbar" data-canvas-no-zoom>{toolbar('hand','移动画布 · H',()=>setTool('pan'),tool==='pan')}{toolbar('select','框选节点 · V',()=>setTool('select'),tool==='select')}<i/>{toolbar('undo','撤销布局 · Ctrl+Z',()=>restore('undo'),false,!undo.current.length)}{toolbar('redo','重做布局 · Ctrl+Shift+Z',()=>restore('redo'),false,!redo.current.length)}<i/>{toolbar('note','新增文本节点',addNote)}{toolbar('image','新增图片节点',addImage)}{toolbar('play','新增视频节点',addVideo)}{toolbar('layout','整理节点',arrange)}{toolbar('grid','切换画布背景',()=>setBackground(v=>v==='lines'?'dots':v==='dots'?'blank':'lines'))}{selection.size>0&&toolbar('fit','聚焦选中 · Shift+F',()=>fit(true))}</div>
      <div className="mumu-attribution"><a href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noreferrer">Infinite Canvas · basketikun</a><span>空白拖动平移 · 滚轮缩放 · Shift 多选</span></div>
      {message&&<div className="mumu-toast" role="status">{message}</div>}
    </div>
    <input ref={importInput} type="file" accept="image/png,image/jpeg,image/webp,.mp4" className="mumu-file-input" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file,importTarget.current);e.target.value='';}}/>
    {menu&&<div className="mumu-context-menu" role="menu" data-canvas-no-zoom style={{left:Math.min(menu.x,Math.max(0,(root.current?.clientWidth||800)-230)),top:Math.min(menu.y,Math.max(0,(root.current?.clientHeight||600)-390))}}>
      {menu.node&&<><button role="menuitem" onClick={()=>{setDetailsId(menu.node!.id);setMenu(undefined);}}>节点信息 / 编辑</button><button role="menuitem" onClick={()=>{openPreview(menu.node!);setMenu(undefined);}}>放大查看 / 全文</button><button role="menuitem" onClick={()=>{saveAsset(menu.node!);setMenu(undefined);}}>存资产</button><button role="menuitem" onClick={()=>{duplicate(menu.node!);setMenu(undefined);}}>复制节点</button><button role="menuitem" onClick={()=>removeNodes(new Set([menu.node!.id]))}>移除节点（可撤销）</button></>}<button role="menuitem" onClick={addImage}>新增图片节点</button><button role="menuitem" onClick={addNote}>新增文本节点</button><button role="menuitem" onClick={addVideo}>新增视频节点</button><button role="menuitem" onClick={()=>{fit();setMenu(undefined);}}>适应全部节点</button><button role="menuitem" onClick={arrange}>整理节点</button><button role="menuitem" onClick={()=>setMenu(undefined)}>关闭菜单</button></div>}
    {newAssetOpen&&<div className="mumu-preview" data-canvas-no-zoom role="dialog" aria-modal="true" aria-label="新增画布资产"><div className="mumu-asset-create"><header><strong>{generateAfterCreate?'文本转图片资产':'新增资产框'}</strong><button disabled={creating} onClick={()=>setNewAssetOpen(false)}>关闭</button></header><div className="mumu-create-body"><p>新建人物、场景或道具，保存后会直接出现在当前画布。</p><label>资产类型<select aria-label="新资产类型" value={newAsset.kind} onChange={e=>setNewAsset(a=>({...a,kind:e.target.value as NewAsset['kind']}))}><option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option></select></label><label>资产名称<input aria-label="新资产名称" maxLength={80} value={newAsset.name} onChange={e=>setNewAsset(a=>({...a,name:e.target.value}))}/></label><label>资产描述<textarea aria-label="新资产描述" maxLength={2000} placeholder="填写人物外观、场景结构或道具形态…" value={newAsset.identity} onChange={e=>setNewAsset(a=>({...a,identity:e.target.value}))}/></label>{newAsset.kind==='character'&&<label>人物声线<input aria-label="新资产声线" maxLength={300} value={newAsset.voice} onChange={e=>setNewAsset(a=>({...a,voice:e.target.value}))}/></label>}{createError&&<p role="alert">{createError}</p>}<button className="mumu-create-primary" disabled={creating||!newAsset.name.trim()||newAsset.identity.length>2000} onClick={()=>void createAsset()}>{creating?'保存中…':generateAfterCreate?'保存并准备生图':'创建并加入画布'}</button><small>创建后可生成或导入图片；拖右侧连线到片段，可绑定参考图。</small><details><summary>从资产库加入已有资产框</summary><div className="mumu-existing-assets">{(project.assets||[]).map(a=><button key={a.id} disabled={creating} onClick={()=>includeAsset(a.id)}>{a.name} · {({character:'人物',scene:'场景',prop:'道具'})[a.kind]}</button>)}</div></details></div></div></div>}
    {preview&&<div className="mumu-preview" data-canvas-no-zoom role="dialog" aria-modal="true" aria-label={preview.title}><div className="mumu-preview-panel"><div className="mumu-preview-heading"><strong>{preview.title}</strong><button onClick={()=>setPreview(undefined)}>关闭</button></div>{preview.type==='video'&&preview.media?<video src={preview.media} controls autoPlay onLoadedMetadata={e=>{const player=e.currentTarget,p=previewPlayback.current;player.currentTime=p.time;player.volume=p.volume;player.muted=p.muted;player.playbackRate=p.rate;setPreviewResolution(`原文件 ${player.videoWidth} × ${player.videoHeight}`);}}/>:preview.media?<img src={preview.media} alt={preview.title} onLoad={e=>setPreviewResolution(`原图 ${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}/>:<pre>{preview.content}</pre>}<div className="mumu-preview-footer">{previewResolution&&<strong>{previewResolution} · </strong>}{preview.tags.join(' · ')}</div></div></div>}
  </div>;
}

export class StudioCanvasMount {
  readonly element = document.createElement('div');
  private root: Root;
  constructor() {this.element.className='studio-canvas-host';this.root=createRoot(this.element);}
  update(props:StudioCanvasProps) {this.root.render(<StudioCanvas key={`${props.project.id}:${props.episode.id}`} {...props}/>);}
  destroy() {this.root.unmount();}
}
