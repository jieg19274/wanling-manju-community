import test from 'node:test';
import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';
const {renderAssetWorkspace,newAssetView,segmentOptions,pageItems}=await tsImport('../web/asset-workspace.ts',import.meta.url);
const {renderHomeProjects}=await tsImport('../web/studio-home.ts',import.meta.url);
function fixture(){
  return {id:'large',name:'大型项目',episodes:Array.from({length:42},(_,i)=>({id:'ep-'+i,number:i+1,title:'章节',scriptLockedHash:'locked',segments:Array.from({length:24},(_,j)=>({id:`seg-${i}-${j}`,number:j+1}))})),
    assets:Array.from({length:330},(_,i)=>({id:'asset-'+i,name:i===329?'尾页道具':'人物'+i,kind:i===329?'prop':'character',identity:'测试身份',voice:'测试声线',states:Array.from({length:30},(_,j)=>({id:'state-'+j,label:'状态'+j,appearance:'外观',trigger:'正式原文',startEpisode:j+1,startSegment:2})),images:Array.from({length:20},(_,j)=>({id:'img-'+j,mediaPath:`image-${j}.png`,source:'upload',role:i===329?'main':'turnaround',layout:i===329?undefined:'three-view-portrait'}))}))};
}
test('historical body and portrait images remain visible with their original roles and explicit compatibility guidance',()=>{
  const project=fixture(),asset=project.assets[0];
  asset.images=[{id:'old-body',mediaPath:'body.png',source:'model',role:'main'},
    {id:'old-portrait',mediaPath:'portrait.png',source:'model',role:'portrait'}];
  const before=JSON.stringify(asset),html=renderAssetWorkspace(project,{...newAssetView(),assetId:asset.id});
  assert.equal((html.match(/<img /g)||[]).length,2);assert.match(html,/data-image-id="old-body"/);assert.match(html,/data-image-id="old-portrait"/);
  assert.match(html,/历史人物图保留供查看/);assert.match(html,/保存原图/);assert.doesNotMatch(html,/data-status="approved"/);
  assert.equal(JSON.stringify(asset),before);
});
test('unmarked legacy turnarounds require an explicit whole-layout check; missing old review checks do not break rendering',()=>{
  const project=fixture(),asset=project.assets[0];
  asset.images=[{id:'legacy-sheet',mediaPath:'whole.png',role:'turnaround',source:'upload',review:{status:'approved'}}];
  const html=renderAssetWorkspace(project,{...newAssetView(),assetId:asset.id});
  assert.match(html,/name="asset-review-layout"/);assert.match(html,/无须重复生成/);assert.match(html,/正面、侧面、背面及大头照/);
  assert.equal(asset.images[0].layout,undefined);
});
test('大项目首屏只生成资产摘要，不渲染全项目状态或参考图',()=>{
  const project=fixture(),html=renderAssetWorkspace(project,newAssetView());
  assert.equal((html.match(/data-action="asset-open"/g)||[]).length,12);
  assert.equal((html.match(/name="state-start"/g)||[]).length,0);
  assert.equal((html.match(/<img /g)||[]).length,0);
  assert.ok(html.length<30000);
  assert.equal(project.assets.length,330);assert.equal(project.assets[0].states.length,30);
});
test('打开单项后状态、图片有界，每个起点只列对应剧集片段',()=>{
  const project=fixture(),view={...newAssetView(),assetId:'asset-0',statePage:2,imagePage:2};
  const html=renderAssetWorkspace(project,view);
  assert.equal((html.match(/data-state-id=/g)||[]).length,6);
  assert.equal((html.match(/<img /g)||[]).length,6);
  assert.ok((html.match(/<option /g)||[]).length<600);
  assert.match(html,/data-state-id="state-6"/);assert.doesNotMatch(html,/data-state-id="state-0"/);
  assert.match(html,/img-13/);assert.doesNotMatch(html,/data-image-id="img-19"/);assert.match(html,/loading="lazy"/);
  const options=segmentOptions(project,2,'2:7');assert.equal((options.match(/<option /g)||[]).length,24);assert.match(options,/value="2:7" selected/);assert.doesNotMatch(options,/value="3:/);
});
test('筛选和尾页可访问全部资产，保留不存在的旧起点供核对',()=>{
  const project=fixture();
  assert.match(renderAssetWorkspace(project,{...newAssetView(),page:28}),/尾页道具/);
  assert.equal((renderAssetWorkspace(project,{...newAssetView(),kind:'prop'}).match(/data-action="asset-open"/g)||[]).length,1);
  assert.match(renderAssetWorkspace(project,{...newAssetView(),query:'尾页'}),/尾页道具/);
  assert.match(segmentOptions(project,80,'80:9'),/value="80:9" selected/);
  assert.equal(pageItems([1,2,3],999,2).page,2);
});
test('资产提取只展示所选集建议并分页，收起时不创建长证据列表',()=>{
  const project=fixture();project.episodes[3].assetCandidate={entries:Array.from({length:100},(_,i)=>({name:'建议'+i,kind:'character',evidence:'原文依据'}))};
  const view={...newAssetView(),candidateEpisodeId:'ep-3',extractionOpen:true,candidatePage:3};
  const html=renderAssetWorkspace(project,view);
  assert.match(html,/建议40/);assert.doesNotMatch(html,/建议99/);assert.match(html,/本集全部 100 项/);
  assert.doesNotMatch(renderAssetWorkspace(project,{...view,extractionOpen:false}),/原文依据/);
});
test('作品卡片保留打开与改名；演示卡片只能查看，名称正确转义',()=>{
  const home={projects:[{id:'a',name:'<作品>',updatedAt:'2026-10-05',episodes:42,demo:false},{id:'d',name:'演示',updatedAt:'2026-10-05',episodes:1,demo:true}],runs:[],deliverables:[]};
  const html=renderHomeProjects(home);
  assert.equal((html.match(/class="home-project-card"/g)||[]).length,2);
  assert.equal((html.match(/data-action="home-continue-project"/g)||[]).length,1);
  assert.match(html,/&lt;作品&gt;/);
  const demoCard=html.slice(html.indexOf('data-home-project-id="d"'));
  assert.doesNotMatch(demoCard,/data-action="home-continue-project"/);
  assert.match(demoCard,/data-action="home-open-project" data-id="d"/);
  assert.match(demoCard,/data-action="rename-project" data-id="d"/);
  assert.equal((renderHomeProjects(home,'演示').match(/class="home-project-card"/g)||[]).length,1);
});
