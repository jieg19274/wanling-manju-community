import type {Project,StoryAsset,AssetImage} from '../shared/model';
import {uiIcon} from './ui-icons';
import {isCharacterSheet,requiresPortraitReference} from '../shared/asset-references';
import {assetInputHash} from '../shared/generation';

const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const mediaUrl=(path:string)=>`/media/${path.split('/').map(encodeURIComponent).join('/')}`;
const kindNames={character:'人物',scene:'场景',prop:'道具'} as const;
export const ASSET_PAGE_SIZE=12, STATE_PAGE_SIZE=6, IMAGE_PAGE_SIZE=6;
export interface AssetView {query:string;kind:string;page:number;assetId:string;statePage:number;imagePage:number;candidateEpisodeId:string;candidatePage:number;extractionOpen:boolean;addOpen:boolean;newStateOpen:boolean}
export const newAssetView=():AssetView=>({query:'',kind:'all',page:1,assetId:'',statePage:1,imagePage:1,candidateEpisodeId:'',candidatePage:1,extractionOpen:false,addOpen:false,newStateOpen:false});
export function pageItems<T>(items:T[],page:number,size:number){
  const pages=Math.max(1,Math.ceil(items.length/size)),current=Math.max(1,Math.min(pages,Math.floor(page)||1));
  return {items:items.slice((current-1)*size,current*size),page:current,pages,total:items.length};
}
function pager(action:string,page:number,pages:number,label:string){return pages>1?`<nav class="asset-pager" aria-label="${label}分页"><button data-action="${action}" data-page="${page-1}" ${page===1?'disabled':''}>上一页</button><span>${page} / ${pages}</span><button data-action="${action}" data-page="${page+1}" ${page===pages?'disabled':''}>下一页</button></nav>`:'';}
export function segmentOptions(project:Project,episodeNumber:number,selected=''){
  const segments=project.episodes.find(ep=>ep.number===episodeNumber)?.segments||[];
  const found=segments.some(seg=>`${episodeNumber}:${seg.number}`===selected);
  return `${selected&&!found?`<option value="${esc(selected)}" selected>原起点 ${esc(selected)}（请核对）</option>`:''}${segments.map(seg=>{const value=`${episodeNumber}:${seg.number}`;return `<option value="${value}" ${value===selected?'selected':''}>片段 ${seg.number}</option>`;}).join('')}`;
}
function startFields(project:Project,episodeNumber:number,segmentNumber:number){
  const selected=`${episodeNumber}:${segmentNumber}`;
  return `<label>生效剧集<select name="state-episode">${project.episodes.filter(ep=>ep.segments.length||ep.number===episodeNumber).map(ep=>`<option value="${ep.number}" ${ep.number===episodeNumber?'selected':''}>第 ${ep.number} 集</option>`).join('')}</select></label><label>起点片段<select name="state-start">${segmentOptions(project,episodeNumber,selected)}</select></label>`;
}
function renderImage(project:Project,asset:StoryAsset,image:AssetImage){
  const character=requiresPortraitReference(asset),sheet=isCharacterSheet(image);
  const historical=character&&!sheet,needsLayout=historical&&image.role==='turnaround';
  const stale=!!image.inputHash&&image.inputHash!==assetInputHash(project,asset.id,image.stateId);
  const reviewable=!historical||needsLayout;
  const title=sheet?'完整四视图＋大头照':({main:'形态主图',turnaround:'旧版四视图（待核对布局）',portrait:'头部特写'} as const)[image.role||'main'];
  const status=stale?'资产描述已变，需核对当前状态':image.referenceAcceptance?.status==='accepted'?'沿用旧图（用户确认）':image.review?.status==='approved'?'通过':image.review?.status==='rejected'?'废图':'待审';
  const compatibility=historical?(needsLayout?'旧版图未登记完整布局。请核对正面、侧面、背面及大头照，确认后可重新审核原图，无须重复生成。':'历史人物图保留供查看。新视频须选用完整四视图＋大头照；如原完整设定图已在历史记录中，请核对并选用原图。'):image.review?.status==='approved'&&(!image.fileHash||!image.inputHash)?'旧审核记录缺少文件或描述指纹，请重新审核原图，无须重复生成。':'';
  return `<figure data-image-id="${esc(image.id)}"><img src="${mediaUrl(image.mediaPath)}" alt="${esc(asset.name)}状态参考图" loading="lazy" decoding="async" width="360" height="240"/><figcaption>${title} · ${esc(asset.states.find(state=>state.id===image.stateId)?.label||image.generationInput?.asset.state?.label||'基础图')} · ${image.source==='model'?'模型生成':image.source==='upload'?'本地导入':esc(image.source)} · ${status}</figcaption>
    ${compatibility?`<p class="asset-helper">${compatibility}</p>`:''}
    ${reviewable?`<div class="asset-review-checks">${(['identity','state','shape','clothing'] as const).map(key=>`<label><input type="checkbox" name="asset-review-check" value="${key}" ${image.review?.checks?.[key]?'checked':''}/> ${({identity:'身份',state:'剧情状态',shape:'形态',clothing:'服饰'} as const)[key]}</label>`).join('')}${needsLayout?'<label><input type="checkbox" name="asset-review-layout"/>已核对整张含正面、侧面、背面及大头照</label>':''}</div>`:''}
    <div class="actions"><a href="${mediaUrl(image.mediaPath)}" target="_blank" rel="noopener">查看原图</a><a href="${mediaUrl(image.mediaPath)}" download>保存原图</a>${reviewable?`<button data-action="asset-image-review" data-status="approved" ${stale?'disabled':''}>审图通过</button>`:''}<button data-action="asset-image-review" data-status="rejected">判废</button>${!historical?'<button data-action="repair-asset-image">以此图返修</button>':''}</div></figure>`;
}
function renderEditor(project:Project,asset:StoryAsset,view:AssetView){
  const activeImages=[...asset.images].reverse();
  const states=pageItems(asset.states,view.statePage,STATE_PAGE_SIZE),images=pageItems(activeImages,view.imagePage,IMAGE_PAGE_SIZE);
  const first=project.episodes.find(ep=>ep.segments.length);
  const defaultRole=requiresPortraitReference(asset)?'turnaround':'main';
  return `<section class="panel asset-card asset-editor" data-asset-id="${esc(asset.id)}" aria-label="${esc(asset.name)}资产编辑"><div class="panel-head"><div><h2>${esc(asset.name)}</h2><span class="chip">${kindNames[asset.kind]}</span></div><button data-action="asset-close">收起编辑</button></div>
    <div class="asset-identity-form"><label>名称<input name="asset-name" value="${esc(asset.name)}"/></label><label>固定身份与跨形态特征<input name="asset-identity" value="${esc(asset.identity)}"/></label><label>人物声线<input name="asset-voice" value="${esc(asset.voice)}" ${asset.kind==='character'?'':'disabled'}/></label><button data-action="save-asset">保存固定信息</button></div>
    <div class="asset-section-title"><h3>剧情状态</h3><span>${asset.states.length} 项</span></div>
    ${states.items.map(state=>`<div class="asset-state" data-state-form data-state-id="${esc(state.id)}"><label>状态名<input name="state-label" value="${esc(state.label)}"/></label><label>当前形态、服饰与伤势<input name="state-appearance" value="${esc(state.appearance)}"/></label><label class="asset-trigger">触发原文<input name="state-trigger" value="${esc(state.trigger)}"/></label>${startFields(project,state.startEpisode,state.startSegment)}<button data-action="save-asset-state">保存状态</button></div>`).join('')||'<p>尚无剧情状态。无变化的场景或道具可直接导入基础图。</p>'}
    ${pager('asset-state-page',states.page,states.pages,'剧情状态')}
    <details class="asset-add-state" ${view.newStateOpen?'open':''}><summary>新增剧情状态</summary><div class="asset-state" data-state-form><label>新状态名<input name="state-label" placeholder="例如：雨夜湿衣"/></label><label>当前形态、服饰与伤势<input name="state-appearance" placeholder="这个状态的视觉外观"/></label><label class="asset-trigger">触发原文<input name="state-trigger" placeholder="粘贴正式事件或反应中的原句"/></label>${first?startFields(project,first.number,first.segments[0].number):'<p>先在剧本中建立片段，再添加状态起点。</p>'}<button data-action="add-asset-state" ${first?'':'disabled'}>新增状态</button></div></details>
    <div class="asset-section-title"><h3>状态参考图</h3><span>${activeImages.length} 张</span></div>
    <p class="asset-helper">新人物先做“三视图＋大头照”：横向依次正面全身、90°侧面全身、背面全身、正面大头照。审图后直接选用完整四视图，用同一张图锁定五官、发型、体态与服装。人物参考始终整张生成、导入和绑定。剧情状态保持同源身份；蛇形使用蛇头特写。</p>
    <div class="asset-upload"><label>剧情状态<select name="asset-image-state"><option value="">基础图（无剧情状态）</option>${asset.states.map(state=>`<option value="${esc(state.id)}">${esc(state.label)}</option>`).join('')}</select></label><label>参考图用途<select name="asset-image-role">${defaultRole==='turnaround'?'<option value="turnaround">完整四视图＋大头照</option>':'<option value="main">形态主图</option>'}</select></label><label class="asset-upload-file">选择参考图<input name="asset-image-file" type="file" accept="image/png,image/jpeg,image/webp"/></label><div class="actions"><button data-action="upload-asset-image">导入参考图</button><button data-action="generate-asset-image" ${project.imageModel?.adapterPath?'':'disabled'}>生成候选</button><button data-action="compare-asset">比较与选用</button></div></div>
    <div class="asset-images">${images.items.map(image=>renderImage(project,asset,image)).join('')||'<p class="asset-helper">尚无参考图。选择状态后导入图片，或生成候选。</p>'}</div>
    ${pager('asset-image-page',images.page,images.pages,'参考图')}
  </section>`;
}
export function renderAssetWorkspace(project:Project,view:AssetView,focusedId=''){
  const assets=project.assets||[],query=view.query.trim().toLocaleLowerCase();
  const filtered=assets.filter(asset=>(view.kind==='all'||view.kind===asset.kind)&&(!query||`${asset.name} ${asset.identity}`.toLocaleLowerCase().includes(query)));
  const page=pageItems(filtered,view.page,ASSET_PAGE_SIZE),selected=assets.find(asset=>asset.id===(focusedId||view.assetId));
  const episodes=project.episodes.filter(ep=>ep.scriptLockedHash),candidate=episodes.find(ep=>ep.id===view.candidateEpisodeId)||episodes[0];
  const candidateEntries=pageItems(candidate?.assetCandidate?.entries||[],view.candidatePage,20);
  return `<div class="asset-workspace ${focusedId?'asset-focus-mode':''}"><div class="page-title"><div><h1>资产与状态</h1><p>管理人物、场景、道具及随剧情变化的外观。</p></div><span class="chip">${assets.length} 项资产</span></div>
    ${!focusedId?`<details class="panel asset-extraction" ${view.extractionOpen?'open':''}><summary>从锁定剧本提取资产</summary><p>模型提出建议后，核对逐字依据再采用。已有资产与参考图会保留。</p>${candidate?`<div class="asset-extraction-controls"><label>选择剧集<select name="asset-candidate-episode">${episodes.map(ep=>`<option value="${esc(ep.id)}" ${ep.id===candidate.id?'selected':''}>第 ${ep.number} 集 · ${esc(ep.title)}</option>`).join('')}</select></label><button data-action="suggest-assets" data-episode-id="${esc(candidate.id)}" ${project.textModel?.adapterPath?'':'disabled'}>提取资产与状态建议</button></div>${view.extractionOpen&&candidate.assetCandidate?`<p>待核对 ${candidate.assetCandidate.entries.length} 项：</p><div class="asset-candidate-evidence">${candidateEntries.items.map(item=>`<article><strong>${esc(item.name)} · ${kindNames[item.kind]}${item.state?` · ${esc(item.state.label)}（片段 ${item.state.startSegment} 起）`:''}</strong><p>依据：${esc(item.evidence)}${item.state?`；变化依据：${esc(item.state.trigger)}`:''}</p></article>`).join('')}</div>${pager('asset-candidate-page',candidateEntries.page,candidateEntries.pages,'资产建议')}<p class="asset-helper">确认将合并本集全部 ${candidate.assetCandidate.entries.length} 项建议，请逐页核对。</p><button data-action="apply-asset-candidate" data-episode-id="${esc(candidate.id)}">确认并合并这些建议</button>`:''}`:'<p>先在本集锁定正式剧本。</p>'}</details>
    <details class="panel asset-add" ${view.addOpen?'open':''}><summary>手动新增资产</summary><p>固定身份与声线放在资产上，形态、服饰和伤势放在剧情状态上。</p><div class="asset-identity-form"><label>类型<select name="new-asset-kind"><option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option></select></label><label>名称<input name="new-asset-name"/></label><label>固定身份与跨形态特征<input name="new-asset-identity"/></label><label>人物声线<input name="new-asset-voice" placeholder="只用于人物"/></label></div><button data-action="add-asset">添加资产</button></details>
    <div class="asset-browser-tools"><div class="asset-kind-filter" role="group" aria-label="资产类型">${(['all','character','scene','prop'] as const).map(kind=>`<button data-action="asset-kind" data-kind="${kind}" aria-pressed="${view.kind===kind}">${kind==='all'?'全部':kindNames[kind]} <span>${kind==='all'?assets.length:assets.filter(a=>a.kind===kind).length}</span></button>`).join('')}</div><div class="asset-search"><label class="sr-only" for="asset-search">搜索资产</label><input id="asset-search" name="asset-search" value="${esc(view.query)}" placeholder="搜索名称或身份"/><button data-action="asset-search">搜索</button></div></div>
    <div class="asset-summary-grid">${page.items.map(asset=>`<button class="asset-summary ${asset.id===selected?.id?'selected':''}" data-action="asset-open" data-id="${esc(asset.id)}" aria-pressed="${asset.id===selected?.id}"><span class="asset-kind-icon">${uiIcon(asset.kind==='character'?'person':asset.kind==='scene'?'scene':'prop')}</span><strong>${esc(asset.name)}</strong><span>${kindNames[asset.kind]} · ${asset.states.length} 个状态 · ${asset.images.length} 张图</span><small>查看与编辑</small></button>`).join('')||'<p class="asset-empty">没有匹配的资产。可更换筛选条件，或从锁定剧本提取。</p>'}</div>${pager('asset-page',page.page,page.pages,'资产')}`:''}
    <div data-asset-editor>${selected?renderEditor(project,selected,view):'<div class="asset-empty">选择一项资产，查看剧情状态和参考图。</div>'}</div>
  </div>`;
}
