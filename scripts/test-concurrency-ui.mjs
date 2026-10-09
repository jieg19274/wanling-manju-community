// Real browser checks against an isolated local service and gated, offline adapters.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!browser) throw new Error('需要已安装的 Chrome 或 Edge 执行界面测试');
mkdirSync(path.resolve('.test-temp'), {recursive: true});
const root = mkdtempSync(path.resolve('.test-temp/concurrency-ui-'));
const gates = path.join(root, 'release'), eventsPath = path.join(root, 'events.jsonl');
mkdirSync(gates);
Object.assign(process.env, {
  MANJU_DATA_DIR: path.join(root, 'data'), MANJU_BACKUP_DIR: path.join(root, 'backups'),
  MANJU_TEXT_CONCURRENCY: '2', MANJU_TEST_CONCURRENCY_RELEASE_DIR: gates,
  MANJU_TEST_CONCURRENCY_EVENTS: eventsPath,
});
delete process.env.MANJU_BATCH_BUDGET_PROFILE;
const model = await import('../dist-server/shared/model.js');
const store = await import('../dist-server/server/store.js');
const adapter = path.resolve('tests/fixtures/gated-concurrency-adapter.mjs');
const project = model.makeProject('并发页面验收', 'standard');
project.textModel = {name: 'offline', modelId: 'offline', adapterPath: adapter};
project.videoModel = {name: 'offline', modelId: 'offline', adapterPath: adapter};
project.imageModel = {name: 'offline', modelId: 'offline', adapterPath: adapter};
project.assets = [{id: model.id(), kind: 'scene', name: '本地场景', identity: '门边', voice: '', states: [], images: []}];
const episodes = [1, 2, 3].map(number => model.makeEpisode(number, `并发测试${number}`));
project.episodes = episodes;
for (const episode of episodes.slice(0, 2)) {
  episode.sourceText = '人物走到门边，同伴拉住衣袖，人物回头确认。'.repeat(8);
  episode.sourceReviewedHash = model.sourceHash(episode);
  episode.highlightReport = '门边停步与同伴反应'; episode.highlightReviewedHash = model.highlightHash(episode);
  const beat = {...model.makeBeat(), sourceQuote: episode.sourceText,
    event: '人物走到门边', reaction: '同伴拉住衣袖，人物回头确认', dialogue: ['人物：先别开门。']};
  episode.scriptBeats = [beat]; model.lockScript(episode);
}
episodes[2].sourceText = '尚未提交编辑的原始内容';
store.insertProject(project);
const other = model.makeProject('切换目标项目', 'standard');
other.episodes = [model.makeEpisode(1, '目标项目分集')]; store.insertProject(other);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = () => existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const key = episode => episode.scriptBeats[0].id;
const gatePath = episode => path.join(gates, `text.${encodeURIComponent(key(episode))}`);
const release = episode => writeFileSync(gatePath(episode), 'released');
const starts = episode => events().filter(event => event.event === 'start' && event.key === key(episode)).length;
async function wait(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`${message}${last ? ': ' + last.message : ''}`);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve)); return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(); await exited;
}
const port = await freePort(), debugPort = await freePort(), base = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['dist-server/server/index.js'], {
  windowsHide: true, stdio: 'ignore', env: {...process.env, MANJU_PORT: String(port),
    MANJU_DIRECT_API_BASE_URL: 'http://127.0.0.1:1', MANJU_JIANYING_DRAFTS_DIR: path.join(root, 'drafts'),
    NODE_OPTIONS: `--import=${pathToFileURL(path.resolve('tests/network-guard.mjs')).href}`},
});
let chrome, ws, evaluate;
const results = [];
async function get(route) {
  const response = await fetch(base + route, {signal: AbortSignal.timeout(3000)});
  assert.ok(response.ok, `GET ${route}: ${response.status}`); return response.json();
}
try {
  await wait(async () => (await get('/api/health')).ok, '本地服务未启动');
  chrome = spawn(browser, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-sync',
    `--user-data-dir=${path.join(root, 'browser-profile')}`, `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1', 'about:blank'], {windowsHide: true, stdio: 'ignore'});
  let target;
  await wait(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, {signal: AbortSignal.timeout(1500)})).json();
    target = pages.find(page => page.type === 'page'); return Boolean(target?.webSocketDebuggerUrl);
  }, '浏览器调试端口未启动');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true}); ws.addEventListener('error', reject, {once: true});
  });
  let next = 0; const pending = new Map();
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    response.error ? request.reject(Error(response.error.message)) : request.resolve(response.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => {pending.delete(id); reject(Error(`${method} 超时`));}, 5000);
      pending.set(id, {resolve: value => {clearTimeout(timer); resolve(value);}, reject: error => {clearTimeout(timer); reject(error);}});
      ws.send(JSON.stringify({id, method, params}));
    });
  }
  evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const click = selector => evaluate(`(() => {const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.disabled) throw Error('按钮不存在或被禁用: ' + ${JSON.stringify(selector)}); b.click();})()`);
  const visible = selector => wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `页面缺少 ${selector}`);
  const idle = () => wait(() => evaluate(`!document.querySelector('manju-app').busy`), '页面操作未结束');
  const tab = async name => {
    await idle();
    const selector = name === 'canvas' ? '[data-action="tab"][data-tab="canvas"], [data-action="graph-workflow-close"]'
      : `[data-action="tab"][data-tab="${name}"], [data-action="graph-workflow"][data-tab="${name}"]`;
    await click(selector); await idle();
  };
  const openEpisode = async episode => {
    await openProject(project);
    await visible(`[data-action="open-episode"][data-id="${episode.id}"]`);
    await click(`[data-action="open-episode"][data-id="${episode.id}"]`); await idle();
  };
  const openProject = async value => {
    const selector = `[data-action="open-project"][data-id="${value.id}"], [data-action="home-open-project"][data-id="${value.id}"]`;
    await idle(); await visible(selector);
    await click(selector); await idle();
    assert.equal(await evaluate(`document.querySelector('manju-app').project.id`), value.id);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false});
  await cdp('Page.navigate', {url: base});
  await openProject(project); await openEpisode(episodes[0]); await tab('script');
  await click('[data-action="suggest-semantic"]');
  await wait(() => starts(episodes[0]) === 1, '首个文本任务未启动');
  assert.equal(await evaluate(`document.querySelector('[data-action="suggest-semantic"]').disabled`), true);
  await tab('canvas'); await visible('.mumu-node.video .mumu-empty-media');
  await click('.mumu-node.video .mumu-empty-media'); await visible('[data-action="compare-video"]');
  assert.equal(await evaluate(`document.querySelector('[data-action="compare-video"]').disabled`), false);
  await tab('assets'); await visible('[data-action="asset-open"]');
  await click('[data-action="asset-open"]'); await idle(); await visible('[data-action="compare-asset"]');
  assert.equal(await evaluate(`document.querySelector('[data-action="compare-asset"]').disabled`), false);
  results.push('文本生成时，图片、视频操作入口及导航保持可用');

  await openEpisode(episodes[1]); await tab('script'); await click('[data-action="suggest-semantic"]');
  await wait(() => starts(episodes[1]) === 1, '另一个分集的文本任务未并发启动');
  assert.equal(await evaluate(`document.querySelector('manju-app').pendingText.size`), 2);
  results.push('同一目标防止重复操作，不同分集的文本任务可同时运行');
  await openEpisode(episodes[2]); await tab('source');
  const draft = '界面并发期间未保存的原文编辑';
  await evaluate(`(() => {const field = document.querySelector('[name="source-text"]'); if (field.readOnly) throw Error('测试原文不可编辑'); field.value = ${JSON.stringify(draft)}; field.dispatchEvent(new Event('input', {bubbles: true})); field.blur();})()`);
  release(episodes[1]);
  await wait(async () => (await get(`/api/projects/${project.id}`)).episodes[1].semanticCandidate, '文本候选未保存');
  await sleep(3500);
  assert.equal(await evaluate(`document.querySelector('[name="source-text"]').value`), draft);
  assert.equal((await get(`/api/projects/${project.id}`)).episodes[2].sourceText, episodes[2].sourceText);
  results.push('文本完成和自动轮询均保留未提交编辑');

  await openProject(other); release(episodes[0]);
  await wait(async () => (await get(`/api/projects/${project.id}`)).episodes[0].semanticCandidate, '首个文本候选未保存');
  await wait(() => evaluate(`document.querySelector('manju-app').pendingText.size === 0`), '已完成文本任务未释放界面状态');
  assert.equal(await evaluate(`document.querySelector('manju-app').project.id`), other.id);
  assert.equal(await evaluate(`document.querySelector('manju-app').canRefreshView()`), true);
  results.push('任务完成后不会跳回先前项目');
  await openProject(project); await openEpisode(episodes[2]); await tab('source');
  assert.equal(await evaluate(`document.querySelector('[name="source-text"]').value`), draft);
  await click('[data-action="discard-drafts"]'); await idle();
  assert.equal(await evaluate(`document.querySelector('[name="source-text"]').value`), episodes[2].sourceText);
  results.push('切换项目后恢复本地编辑；明确丢弃时重新读取已保存内容');

  store.updateProject(project.id, current => {delete current.episodes[0].semanticCandidate;});
  unlinkSync(gatePath(episodes[0]));
  await openEpisode(episodes[0]); await tab('script'); await click('[data-action="suggest-semantic"]');
  await wait(() => starts(episodes[0]) === 2, '完成的文本任务无法再次提交'); release(episodes[0]);
  await wait(() => evaluate(`!document.querySelector('[data-action="suggest-semantic"]').disabled && document.querySelector('manju-app').episode.semanticCandidate`), '安全空闲页面未刷新文本候选');
  assert.match(await evaluate(`document.querySelector('main').innerText`), /候选警告/);
  results.push('页面安全空闲时刷新候选并恢复操作按钮');
  await openEpisode(episodes[2]); await tab('source');
  const saved = '明确保存后的编辑内容';
  await evaluate(`(() => {const field = document.querySelector('[name="source-text"]'); field.value = ${JSON.stringify(saved)}; field.dispatchEvent(new Event('input', {bubbles: true})); field.blur();})()`);
  await click('[data-action="save-source"]'); await idle();
  assert.equal((await get(`/api/projects/${project.id}`)).episodes[2].sourceText, saved);
  assert.equal(await evaluate(`document.querySelector('manju-app').draftFields.size`), 0);
  assert.equal(await evaluate(`document.querySelector('manju-app').canRefreshView()`), true);
  results.push('保存编辑后恢复自动刷新，其他项目的本地编辑不会阻塞当前页面');
  // Hold the native canvas candidate load across project navigation.
  await openEpisode(episodes[0]); await visible('.mumu-node.video .mumu-empty-media');
  await click('.mumu-node.video .mumu-empty-media'); await visible('.mumu-node-composer > button');
  await evaluate(`(() => {
    const original=window.fetch;window.__testOriginalFetch=original;let intercept=true;
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(intercept&&String(args[0]).includes('/api/projects/${project.id}/candidates')){
        intercept=false;return new Promise(resolve=>{window.__testReleaseCandidates=()=>resolve(response);});
      }
      return response;
    };
  })()`);
  await click('.mumu-node-composer > button');
  await wait(()=>evaluate(`typeof window.__testReleaseCandidates==='function'`),'候选读取未被拦截');
  assert.equal(await evaluate(`document.querySelector('manju-app').busy`),false);
  await openProject(other);
  await evaluate(`window.__testReleaseCandidates();window.fetch=window.__testOriginalFetch;`);await sleep(150);
  const navigation=await evaluate(`(() => {const app=document.querySelector('manju-app');return {projectId:app.project.id,hasWorkspace:Boolean(app.candidateWorkspace),inputs:app.candidateInputs.length,panel:Boolean(document.querySelector('.candidate-workbench'))};})()`);
  assert.equal(navigation.projectId,other.id);assert.equal(navigation.hasWorkspace,false);
  assert.equal(navigation.inputs,0);assert.equal(navigation.panel,false);
  results.push('候选读取延迟期间切换项目，旧响应不会弹出旧项目窗口');
  await openProject(project);await openEpisode(episodes[0]);
  await evaluate(`(() => {
    const original=window.fetch;window.__testOriginalFetch=original;delete window.__testReleaseCandidates;let intercept=true;
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(intercept&&String(args[0]).includes('/api/projects/${project.id}/candidates')){
        intercept=false;return new Promise(resolve=>{window.__testReleaseCandidates=()=>resolve(response);});
      }
      return response;
    };
    window.__testCandidateOpen=document.querySelector('manju-app').openCandidates([{kind:'video',count:1,episodeId:${JSON.stringify(episodes[0].id)},segmentId:${JSON.stringify(episodes[0].segments[0].id)}}]);
  })()`);
  await wait(()=>evaluate(`typeof window.__testReleaseCandidates==='function'`),'当前项目候选读取未被拦截');
  await evaluate(`document.querySelector('manju-app').openProject(${JSON.stringify(project.id)},true)`);
  await evaluate(`window.__testReleaseCandidates();window.fetch=window.__testOriginalFetch;`);
  await evaluate(`window.__testCandidateOpen`);
  await visible('.candidate-workbench');
  assert.equal(await evaluate(`document.querySelector('manju-app').candidateWorkspace.input.episodeId`),episodes[0].id);
  await openProject(other);
  assert.equal(await evaluate(`Boolean(document.querySelector('.candidate-workbench'))`),false);
  assert.equal(await evaluate(`document.querySelector('manju-app').candidateInputs.length`),0);
  results.push('同项目后台刷新不干扰候选加载；切换项目后清空已有工作区');
  // Exercise prompt compatibility/state through the current native navigation.
  const sharp=(await import('sharp')).default,{createHash}=await import('node:crypto');
  const {assetInputHash}=await import('../dist-server/shared/generation.js');
  const {screenTextBoundary}=await import('../dist-server/shared/prompt-contract.js');
  const media=path.join(root,'data','media');mkdirSync(media,{recursive:true});
  const roomFile=path.join(media,'prompt-ui-room.png');await sharp({create:{width:96,height:64,channels:3,background:'#304050'}}).png().toFile(roomFile);
  const hash=createHash('sha256').update(readFileSync(roomFile)).digest('hex'),oldId=model.id(),freshId=model.id();
  store.updateProject(project.id,p=>{
    const ep=p.episodes[0],seg=ep.segments[0],beat=model.beatFor(ep,seg),asset=p.assets[0];
    const original={id:model.id(),role:'main',mediaPath:'prompt-ui-room.png',fileHash:hash,inputHash:assetInputHash(p,asset.id),source:'upload',createdAt:model.now(),review:{status:'approved',checks:{identity:true,state:true,shape:true,clothing:true},reviewedAt:model.now()}};
    const accepted={...structuredClone(original),id:model.id(),referenceAcceptance:{status:'accepted',statement:'本地界面测试确认沿用参考',acceptedAt:model.now(),sourceImageId:original.id,sourceFileHash:hash,acceptedInputHash:original.inputHash,knownDifference:'旧图仅用于空间参考。',requiredVideoCorrection:'按本段正式机位保持门边空间，不照搬旧图布局。'}};
    asset.images=[original,accepted];seg.assetBindings=[{assetId:asset.id,imageId:accepted.id}];seg.visualPlan='门边近景，人物按正式顺序行动。';seg.subshotsReviewed=true;
    seg.subshots=seg.subshots.map((shot,index)=>({...shot,evidence:index<4?beat.event:beat.reaction,action:(index<4?beat.event:beat.reaction)+`第${index+1}个执行节拍`,location:asset.name,priorState:`前置状态${index+1}`,result:`可见结果${index+1}`,endFrame:`末帧状态${index+1}`,assetIds:[asset.id]}));
    const content=model.composePrompt(ep,seg,[],model.segmentReferences(p,ep,seg),model.videoReferences(p,ep,seg)),sourceHash=model.contentHash(ep,seg);
    seg.artifacts=[{id:oldId,kind:'prompt',content:content.replace(screenTextBoundary(),''),sourceHash,createdAt:model.now()},
      {id:freshId,kind:'prompt',content,sourceHash,createdAt:model.now(),promptTemplateVersion:'historical-compatible'}];seg.selected.prompt=oldId;
    p.videoModel.capabilities={maxDurationSec:30,maxReferences:30,maxPromptChars:20000,nativeAudio:true};
  });
  await openProject(project);await openEpisode(episodes[0]);await tab('canvas');
  await click('[data-action="canvas-view"][data-view="table"]');await visible(`[data-artifact-id="${freshId}"]`);
  assert.match(await evaluate(`document.querySelector('[data-artifact-id="${freshId}"]').innerText`),/结构检查通过.*待比较选用/);
  const oldBefore=(await get(`/api/projects/${project.id}`)).episodes[0].segments[0].artifacts.find(a=>a.id===oldId);
  await click(`[data-artifact-id="${freshId}"] [data-action="select-artifact"]`);await idle();
  const chosen=(await get(`/api/projects/${project.id}`)).episodes[0].segments[0];assert.equal(chosen.selected.prompt,freshId);assert.deepEqual(chosen.artifacts.find(a=>a.id===oldId),oldBefore);
  assert.match(await evaluate(`document.querySelector('[data-artifact-id="${freshId}"]').innerText`),/待人工核对/);
  results.push('提示词新版待比较选用；历史版保持，选用不要求重复编译');
  await tab('export');await visible('[data-action="approve-audit"]');await click('[data-action="approve-audit"]');await idle();
  assert.ok((await get(`/api/projects/${project.id}`)).episodes[0].auditApprovedHash);
  await tab('canvas');await click('[data-action="canvas-view"][data-view="graph"]');
  await visible('.mumu-node.video .mumu-empty-media');await click('.mumu-node.video .mumu-empty-media');await visible('[data-action="compare-video"]');
  await click('[data-action="compare-video"]');await visible('[data-action="candidate-preview"]');await click('[data-action="candidate-preview"]');await visible('.candidate-budget');
  assert.match(await evaluate(`document.querySelector('.candidate-budget').innerText`),/完整提交提示词：.*字/);
  await click('.candidate-budget details summary');
  assert.match(await evaluate(`document.querySelector('.candidate-budget').innerText`),/按本段正式机位保持门边空间/);
  assert.equal(store.db.prepare("SELECT count(*) n FROM jobs WHERE project_id=? AND kind='video'").get(project.id).n,0);
  results.push('视频预览展示含参考修正的完整正文和字数，未提交付费生成');
  await click('[data-action="candidate-close"]');await openProject(project);await visible('[data-project-label-settings]');
  const beforeFonts=(await get(`/api/projects/${project.id}`)).episodes[0];
  assert.equal(await evaluate(`document.querySelector('[name="font-preset"]').value`),'wuxia');
  await evaluate(`(() => {const s=document.querySelector('[name="font-preset"]');s.value='elegant';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  assert.match(await evaluate(`getComputedStyle(document.querySelector('[data-project-label-settings] [data-font-preview="label"]')).fontFamily`),/Noto Serif SC/);
  await evaluate(`(() => {const s=document.querySelector('[name="font-preset"]');s.value='wuxia';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  assert.match(await evaluate(`getComputedStyle(document.querySelector('[data-project-label-settings] [data-font-preview="label"]')).fontFamily`),/楷体/);
  await click('[data-action="save-label-style"]');await idle();
  const afterFonts=await get(`/api/projects/${project.id}`);assert.equal(afterFonts.labelStyle.preset,'wuxia');
  assert.equal(afterFonts.episodes[0].auditApprovedHash,beforeFonts.auditApprovedHash);assert.deepEqual(afterFonts.episodes[0].segments[0].artifacts,beforeFonts.segments[0].artifacts);
  await click('[data-action="check-label-fonts"]');await idle();
  assert.match(await evaluate(`document.querySelector('[data-project-label-settings]').innerText`),/已检测本机中文字体.*楷体/);
  await evaluate(`document.querySelector('[data-project-label-settings]').scrollIntoView({block:'center'})`);
  const fontScreenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),fontScreenshotPath=path.join(root,'wuxia-font-settings.png');
  writeFileSync(fontScreenshotPath,Buffer.from(fontScreenshot.data,'base64'));writeFileSync(path.resolve('.test-temp/fx-fonts-ui-review.json'),JSON.stringify({frame:fontScreenshotPath,sha256:createHash('sha256').update(readFileSync(fontScreenshotPath)).digest('hex'),source:'隔离界面字体预览，非生产素材'},null,2));
  results.push('楷体/宋体切换实时预览，保存字体偏好保留提示词及五层验收，检测本机字体');
  await openEpisode(episodes[0]);await tab('canvas');await click('[data-action="canvas-view"][data-view="table"]');await visible('[data-execution-editor]');
  const palette=await evaluate(`(() => {const el=document.querySelector('[data-execution-editor]'),style=getComputedStyle(el),target=document.createElement('span');target.style.background=getComputedStyle(document.documentElement).getPropertyValue('--ui-surface');document.body.append(target);const expected=getComputedStyle(target).backgroundColor;target.remove();return {actual:style.backgroundColor,expected};})()`);assert.equal(palette.actual,palette.expected);
  await evaluate(`document.querySelector('[data-execution-editor]').open=true`);
  await click('[data-action="save-execution-plan"]');await idle();
  const planned=(await get(`/api/projects/${project.id}`)).episodes[0].segments[0];assert.equal(planned.executionPlan.labelStyle.preset,'wuxia');assert.equal(planned.subshotsReviewed,false);assert.equal(planned.selected.prompt,freshId);
  assert.deepEqual(planned.artifacts,beforeFonts.segments[0].artifacts);
  results.push('逐镜执行计划可保存并进入本段核对，保留已有提示词供比较');
  // Isolated media for the visible-text repair UI; no generated production movie.
  const synthetic=path.join(media,'font-ui-original.mp4');
  await new Promise((resolve,reject)=>{const child=spawn('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=#304050:s=640x360:r=12:d=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=30','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',synthetic],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(error)));});
  const {generationSignature}=await import('../dist-server/shared/generation.js'),sourceId=model.id();
  store.updateProject(project.id,p=>{
    const ep=p.episodes[0],seg=ep.segments[0],beat=model.beatFor(ep,seg);seg.executionPlan=undefined;seg.action=true;
    beat.floatLabels=['场景：本地场景'];seg.subshots[0].lineRefs.floatLabels=[0];ep.scriptLockedHash=model.scriptHash(ep);
    const prompt={id:model.id(),kind:'prompt',createdAt:model.now(),sourceHash:model.contentHash(ep,seg),content:model.composePrompt(ep,seg,[],model.segmentReferences(p,ep,seg),model.videoReferences(p,ep,seg))};seg.artifacts.push(prompt);seg.selected.prompt=prompt.id;
    const refs=model.videoReferences(p,ep,seg).map(r=>({imageId:r.imageId,hash}));
    const source={id:sourceId,specId:sourceId,kind:'video',createdAt:model.now(),mediaPath:'font-ui-original.mp4',sourceHash:model.contentHash(ep,seg),generationHash:generationSignature(p,ep,seg),referenceHashes:refs,review:{status:'approved',reviewedAt:model.now(),notes:'隔离合成技术样例，非生产验收'}};
    seg.artifacts.push(source);seg.selected.video=sourceId;
    store.registerGenerationSpec(sourceId,p.id,{version:1,origin:'import',hash:source.generationHash,references:refs,project:p});
  });
  await openProject(project);await openEpisode(episodes[0]);await tab('canvas');await click('[data-action="canvas-view"][data-view="table"]');await visible('[data-label-repair]');
  await evaluate(`(() => {const panel=document.querySelector('[data-label-repair]');panel.open=true;for(const name of ['repair-visible-0-enabled','repair-confirmed']){const f=panel.querySelector('[name="'+name+'"]');f.checked=true;f.dispatchEvent(new Event('change',{bubbles:true}));}const t=panel.querySelector('[name="repair-time"]');t.value=1;t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.match(await evaluate(`document.querySelector('[data-label-overlays]').innerText`),/场景：本地场景/);
  assert.match(await evaluate(`getComputedStyle(document.querySelector('[data-label-overlays] span')).fontFamily`),/楷体/);
  await click('[data-action="repair-labels"]');
  assert.equal(await evaluate(`document.querySelector('manju-app').busy`),false);
  await wait(async()=>{const p=await get(`/api/projects/${project.id}`);return p.episodes[0].segments[0].artifacts.some(a=>a.labelRepair?.sourceArtifactId===sourceId);},'本地浮签修正版未生成',25000);
  const corrected=(await get(`/api/projects/${project.id}`)).episodes[0].segments[0],derivative=corrected.artifacts.find(a=>a.labelRepair?.sourceArtifactId===sourceId);
  assert.equal(corrected.selected.video,sourceId);assert.equal(derivative.review,undefined);assert.ok(derivative.labelRepair.audioHash.startsWith('SHA256='));
  assert.equal(store.db.prepare("SELECT count(*) n FROM jobs WHERE project_id=? AND kind='video'").get(project.id).n,0);
  await wait(()=>evaluate(`document.querySelector('manju-app').labelRepairs.size===0`),'本地纠字状态未结束');
  results.push('浮签正式全文与楷体覆盖预览可操作，本地修正保留原选版和音轨且不阻塞界面或提交付费任务');
  // Recover a lost response with the same request; saved plans, not current
  // controls, must determine the retry and never duplicate the derivative.
  const repairKey=`manju-label-repair:${project.id}:${episodes[0].id}:${episodes[0].segments[0].id}:${sourceId}`;
  await evaluate(`localStorage.setItem(${JSON.stringify(repairKey)},${JSON.stringify(JSON.stringify({requestId:derivative.labelRepair.requestId,payload:{style:derivative.labelRepair.style,cues:derivative.labelRepair.cues}}))});document.querySelector('manju-app').updateLabelRepairControls();`);
  await visible('[data-action="recover-label-repair"]');await click('[data-action="recover-label-repair"]');
  await wait(()=>evaluate(`document.querySelector('manju-app').labelRepairs.size===0`),'纠字结果恢复未结束');
  const recovered=(await get(`/api/projects/${project.id}`)).episodes[0].segments[0];assert.equal(recovered.artifacts.filter(a=>a.labelRepair).length,1);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(repairKey)})`),null);
  results.push('丢失响应可按原请求查询恢复，使用已确认排程且不重复创建修正版');
  await evaluate(`(() => {const original=window.fetch;window.__testOriginalFetch=original;delete window.__testReleaseLabel;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('action=repair-labels'))return new Promise(resolve=>window.__testReleaseLabel=()=>resolve(response));return response;};const panel=document.querySelector('[data-label-repair]');panel.open=true;for(const name of ['repair-visible-0-enabled','repair-confirmed']){const f=panel.querySelector('[name="'+name+'"]');f.checked=true;f.dispatchEvent(new Event('change',{bubbles:true}));}const style=panel.querySelector('[name="repair-font-size"]');style.value='large';style.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('[data-action="repair-labels"]');assert.equal(await evaluate(`document.querySelector('manju-app').busy`),false);
  await openProject(other);
  await wait(()=>evaluate(`typeof window.__testReleaseLabel==='function'`),'后台纠字响应未被截留',25000);
  await evaluate(`window.__testReleaseLabel();window.fetch=window.__testOriginalFetch;`);
  await wait(()=>evaluate(`document.querySelector('manju-app').labelRepairs.size===0`),'旧项目纠字任务未结束');
  assert.equal(await evaluate(`document.querySelector('manju-app').project.id`),other.id);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-label-repair]'))`),false);
  assert.equal((await get(`/api/projects/${project.id}`)).episodes[0].segments[0].artifacts.filter(a=>a.labelRepair).length,2);
  results.push('本地纠字期间可切换项目，完成的旧响应保存在原项目而不跳回或弹出旧窗口');
  const managerCurrent=model.id(),managerAlternate=model.id();
  store.updateProject(project.id,p=>{
    const e=p.episodes[0],s=e.segments[0];
    const content=model.composePrompt(e,s,[],model.segmentReferences(p,e,s),model.videoReferences(p,e,s),p.labelStyle);
    for(const id of [managerCurrent,managerAlternate])s.artifacts.push({id,kind:'prompt',content,sourceHash:model.contentHash(e,s),createdAt:model.now()});
    s.selected.prompt=managerCurrent;e.auditApprovedHash=undefined;
  });
  const managementBefore=store.getProject(project.id).episodes[0].segments[0],jobsBeforeManagement=events().length;
  await openProject(project);await openEpisode(episodes[0]);await tab('canvas');
  await visible('[data-action="prompt-manager-open"]');await click('[data-action="prompt-manager-open"]');await idle();await visible('[data-prompt-manager]');
  assert.equal(await evaluate(`Boolean(document.activeElement.closest('[data-prompt-manager]'))`),true);
  await click('[data-action="prompt-unselect"]');await idle();
  let managed=store.getProject(project.id).episodes[0].segments[0];assert.equal(managed.selected.prompt,undefined);assert.equal(managed.promptSelectionPaused,true);
  assert.equal(managed.selected.video,managementBefore.selected.video);assert.equal(managed.artifacts.find(a=>a.id===managerCurrent).content,managementBefore.artifacts.find(a=>a.id===managerCurrent).content);
  results.push('关系图提示词管理可取消选用，保留全文、原视频选版和验收，未提交付费任务');
  const managementContent=managementBefore.artifacts.find(a=>a.id===managerCurrent).content;
  await evaluate(`(() => {const f=document.querySelector('[data-prompt-replacement]');f.value=${JSON.stringify(managementContent)};f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('[data-action="prompt-write-new"]');await idle();
  managed=store.getProject(project.id).episodes[0].segments[0];const writtenId=managed.selected.prompt;
  assert.ok(writtenId&&writtenId!==managerCurrent);assert.equal(managed.artifacts.find(a=>a.id===writtenId).content,managementContent);assert.equal(managed.promptSelectionPaused,undefined);
  assert.equal(await evaluate(`document.querySelector('[data-prompt-replacement]').value`),managementContent);
  results.push('全文写入入口选用合规新版、解除取消选用状态，保留旧版且不自动放行');
  await click('[data-action="prompt-check-none"]');await idle();
  await evaluate(`document.querySelector('[data-prompt-choice][data-artifact-id="${writtenId}"]').click()`);
  await click('[data-action="prompt-manage-batch"][data-operation="archive"]');await idle();
  managed=store.getProject(project.id).episodes[0].segments[0];assert.ok(managed.artifacts.find(a=>a.id===writtenId).promptArchive);assert.equal(managed.selected.prompt,undefined);
  await click('[data-action="prompt-manager-close"]');await idle();await click('[data-action="canvas-view"][data-view="table"]');await idle();
  assert.equal(await evaluate(`Boolean(document.querySelector('.canvas-node[data-artifact-id="${writtenId}"]'))`),false);
  await click('[data-action="prompt-manager-open"]');await idle();
  await evaluate(`(() => {document.querySelector('.prompt-management-history').open=true;document.querySelector('[data-prompt-choice][data-artifact-id="${writtenId}"]').click();})()`);
  await click('[data-action="prompt-manage-batch"][data-operation="restore"]');await idle();
  managed=store.getProject(project.id).episodes[0].segments[0];assert.equal(managed.artifacts.find(a=>a.id===writtenId).promptArchive,undefined);assert.equal(managed.selected.prompt,undefined);
  assert.equal(await evaluate(`Boolean(document.querySelector('.canvas-node[data-artifact-id="${writtenId}"]'))`),true);
  results.push('批量停用退出正常版本表并禁止选用，历史可恢复，恢复不自动选版或审片放行');
  await click('[data-action="prompt-check-none"]');await idle();
  await evaluate(`(() => {for(const id of [${JSON.stringify(writtenId)},${JSON.stringify(managerAlternate)}])document.querySelector('[data-prompt-choice][data-artifact-id="'+id+'"]').click();})()`);
  const beforeInvalid=JSON.stringify(store.getProject(project.id).episodes[0].segments[0]);
  await click('[data-action="prompt-manage-batch"][data-operation="select"]');await idle();
  assert.match(await evaluate(`document.querySelector('manju-app').message`),/同一片段/);
  assert.equal(JSON.stringify(store.getProject(project.id).episodes[0].segments[0]),beforeInvalid);
  await click('[data-action="prompt-check-none"]');await idle();await evaluate(`document.querySelector('[data-prompt-choice][data-artifact-id="${managerAlternate}"]').click()`);
  await click('[data-action="prompt-manage-batch"][data-operation="select"]');await idle();
  assert.equal(store.getProject(project.id).episodes[0].segments[0].selected.prompt,managerAlternate);
  await click('[data-action="prompt-check-none"]');await idle();await evaluate(`document.querySelector('[data-prompt-choice][data-artifact-id="${writtenId}"]').click()`);
  await click('[data-action="prompt-manage-batch"][data-operation="select"]');await idle();
  managed=store.getProject(project.id).episodes[0].segments[0];assert.equal(managed.selected.prompt,writtenId);assert.ok(managed.artifacts.find(a=>a.id===managerAlternate).promptArchive);
  assert.equal(managed.selected.video,managementBefore.selected.video);assert.equal(events().length,jobsBeforeManagement);
  const managerScreenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(path.join(root,'prompt-manager.png'),Buffer.from(managerScreenshot.data,'base64'));
  results.push('批量换选整批验证：同段重复选择不落盘，成功后仅停用原选版并保留原片记录');
  const provider=await import('../dist-server/server/direct-provider.js');
  provider.saveDirectConfig({apiKey:'offline-project-model-ui-key'});
  const modelProject=provider.applyGlobalModels(model.makeProject('默认与项目模型同步验收','standard'));
  assert.equal(modelProject.textModel.modelId,'claude-opus-5-5');
  results.push('全新项目的内置文本默认值为 Opus 5.5');
  modelProject.textModel={...modelProject.textModel,name:'claude-fable-5',modelId:'claude-fable-5'};
  modelProject.episodes=[model.makeEpisode(1,'模型配置隔离检查')];
  modelProject.episodes[0].sourceText='本地测试角色在门口停步，回头确认同伴。'.repeat(5);
  store.insertProject(modelProject);
  await cdp('Page.navigate',{url:base});await visible('[data-action="home-open-project"]');await openProject(modelProject);
  await click('[data-action="open-app-settings"]');await idle();
  await click('[data-action="open-model-kind"][data-kind="text"]');await idle();
  await evaluate(`(()=>{const field=document.querySelector('[name="global-model-id"]');field.value='claude-opus-5-5';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('[data-action="save-global-model"]');await idle();
  assert.equal((await get('/api/direct-provider/defaults')).text.modelId,'claude-opus-5-5');
  assert.equal(store.getProject(modelProject.id).textModel.modelId,'claude-fable-5');
  assert.equal(await evaluate(`document.querySelector('manju-app').globalModels.image.modelId`),'gpt-image-2.5-sunburst');
  assert.equal(await evaluate(`document.querySelector('manju-app').globalModels.video.modelId`),'专享sd2.5(30图10音/4-30秒/720p)');
  assert.ok(await evaluate(`document.querySelector('.agent-readiness').textContent.includes('新项目默认：claude-opus-5-5')`));
  assert.ok(await evaluate(`document.querySelector('manju-app').message.includes('当前项目仍使用 claude-fable-5')`));
  assert.ok(!await evaluate(`document.querySelector('manju-app').message.includes('同步到现有项目')`));
  results.push('默认模型保存提示真实作用范围，立即刷新 Agent 默认检查，并保留图片／视频默认值');
  await click('[data-action="project-model-settings"]');await idle();
  await tab('tasks');await visible('[data-action="use-project-default-model"][data-model-kind="text"]');
  assert.ok(await evaluate(`document.querySelector('.agent-readiness').textContent.includes('本项目实际使用：claude-fable-5')`));
  assert.ok(await evaluate(`document.querySelector('.agent-readiness').textContent.includes('本项目尚未切换')`));
  await evaluate(`document.querySelector('.agent-readiness').open=true`);
  await click('[data-action="use-project-default-model"][data-model-kind="text"]');await idle();
  assert.equal(store.getProject(modelProject.id).textModel.modelId,'claude-opus-5-5');
  assert.ok(await evaluate(`document.querySelector('.agent-readiness').textContent.includes('本项目实际使用：claude-opus-5-5')`));
  assert.equal(await evaluate(`document.querySelector('[data-action="use-project-default-model"][data-model-kind="text"]')===null`),true);
  results.push('Agent 面板显示真实项目模型，一次点击切换为 Opus 后立即同步检查结果');
  for(const [kind,id] of [['image','gpt-image-2'],['video','全能sd2.5']]){
    const original=store.getProject(modelProject.id)[`${kind}Model`].modelId;
    await click('[data-action="open-app-settings"]');await idle();
    await click(`[data-action="open-model-kind"][data-kind="${kind}"]`);await idle();
    await evaluate(`(()=>{const field=document.querySelector('[name="global-model-id"]');field.value=${JSON.stringify(id)};field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('[data-action="save-global-model"]');await idle();assert.equal(store.getProject(modelProject.id)[`${kind}Model`].modelId,original);
    await click('[data-action="project-model-settings"]');await idle();await tab('tasks');
    await evaluate(`document.querySelector('.agent-readiness').open=true`);
    await click(`[data-action="use-project-default-model"][data-model-kind="${kind}"]`);await idle();
    assert.equal(store.getProject(modelProject.id)[`${kind}Model`].modelId,id);
    assert.ok(await evaluate(`document.querySelector('.agent-readiness').textContent.includes(${JSON.stringify('本项目实际使用：'+id)})`));
    assert.equal(await evaluate(`document.querySelector('[data-action="use-project-default-model"][data-model-kind="${kind}"]')===null`),true);
    results.push(`${kind==='image'?'图片':'视频'}默认与项目配置分别显示，通过 Agent 切换后项目模型与检查结果一致`);
  }
  await click('[data-action="project-model-settings"]');await idle();
  assert.ok(await evaluate(`document.querySelector('[data-project-model-settings]').open`));
  assert.equal(await evaluate(`document.querySelectorAll('[data-project-model-settings] .model-card').length`),3);
  assert.equal(await evaluate(`document.querySelector('[data-project-model-settings] [data-model-kind="text"] [name="model-id"]').value`),'claude-opus-5-5');
  await evaluate(`(()=>{const card=document.querySelector('[data-project-model-settings] .model-card[data-model-kind="text"]'),field=card.querySelector('[name="model-id"]');field.value='offline-project-custom';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('[data-project-model-settings] .model-card[data-model-kind="text"] [data-action="save-model"]');await idle();
  assert.equal(store.getProject(modelProject.id).textModel.modelId,'offline-project-custom');
  assert.equal((await get('/api/direct-provider/defaults')).text.modelId,'claude-opus-5-5');
  await tab('tasks');
  assert.ok(await evaluate(`document.querySelector('.agent-readiness').textContent.includes('本项目实际使用：offline-project-custom')`));
  results.push('恢复三类项目模型设置入口，手动项目选择保存成功且不覆盖默认模型');
  await click('[data-action="project-model-settings"]');await idle();
  await cdp('Emulation.setDeviceMetricsOverride',{width:760,height:1000,deviceScaleFactor:1,mobile:false});
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
  await cdp('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});
  results.push('项目模型设置在窄窗口显示完整控件，页面无横向溢出；未提交生成任务');
  const recoveryProject=provider.applyGlobalModels(model.makeProject('40集旧稿核对界面验收','standard'));
  recoveryProject.episodes=Array.from({length:40},(_,i)=>{
    const e=model.makeEpisode(i+1,'保留旧稿'+(i+1));e.sourceText='人物在门边停下，回头确认同伴，随后邀请对方进屋。'.repeat(5);
    e.scriptBeats=[{...model.makeBeat(),event:'人物在门边停下',reaction:'同伴点头回应。',sourceQuote:'人物在门边停下，回头确认同伴'}];return e;
  });store.insertProject(recoveryProject);
  const recoveryBefore=JSON.stringify(store.getProject(recoveryProject.id).episodes.map(e=>e.scriptBeats)),legacyFlow=model.id(),at=model.now();
  const savedFlow={id:legacyFlow,projectId:recoveryProject.id,episodeId:recoveryProject.episodes[0].id,delivery:'package',status:'failed',createdAt:at,updatedAt:at,
    step:{key:'offline-current-opus',kind:'text',task:'highlight',model:'claude-opus-5-5',label:'提取高光报告',message:'保留已有剧本，核对当前原文。',tab:'source',submissions:1},error:'模型接口 HTTP 503：No available channel for model claude-fable-5 under offline-test-group',
    history:[{key:'offline-old-fable',kind:'text',model:'claude-fable-5',label:'旧高光请求',status:'failed',at,submissions:1}],limits:{text:2,image:0,video:0},used:{text:1,image:0,video:0}};
  store.db.prepare('INSERT INTO agent_workflows VALUES(?,?,?,?,?)').run(legacyFlow,recoveryProject.id,recoveryProject.episodes[0].id,JSON.stringify(savedFlow),at);
  const requestId=model.id(),output=path.join(root,'data/adapter-jobs',requestId+'.json');mkdirSync(path.dirname(output),{recursive:true});
  store.db.prepare('INSERT INTO adapter_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(requestId,recoveryProject.id,'highlight-report',requestId,JSON.stringify({request:{model:'claude-opus-5-5'}}),'remote_unknown',output,null,at,at);
  writeFileSync(output+'.provider-http-receipt.json',JSON.stringify({status:503,model:'claude-opus-5-5',requestId:'offline-provider-request',receivedAt:at}));
  await cdp('Page.navigate',{url:base});await visible('[data-action="home-open-project"]');await openProject(recoveryProject);await tab('tasks');
  await visible('[data-dashboard-key="script-recovery"]');
  await evaluate(`document.querySelector('[data-dashboard-key="script-recovery"]').open=true`);
  assert.match(await evaluate(`document.querySelector('[data-dashboard-key="script-recovery"]').textContent`),/已有剧本待核对 · 40 集/);
  assert.equal(await evaluate(`document.querySelectorAll('[data-dashboard-key="script-recovery"] article').length`),40);
  assert.equal(JSON.stringify(store.getProject(recoveryProject.id).episodes.map(e=>e.scriptBeats)),recoveryBefore);
  results.push('旧版40集剧本显示逐集补核对入口，打开面板不改变现稿或提交生成');
  const flowText=await evaluate(`document.querySelector('.agent-flow-list').textContent`);
  assert.match(flowText,/当前步骤模型：claude-opus-5-5/);assert.match(flowText,/上次执行失败 · claude-fable-5/);
  results.push('工作流当前 Opus 模型与历史 Fable 503分别标注模型和时间');
  await evaluate(`document.querySelector('[data-dashboard-key="model-requests"]').open=true`);
  assert.match(await evaluate(`document.querySelector('[data-dashboard-key="model-requests"]').textContent`),/已发出：claude-opus-5-5/);
  assert.match(await evaluate(`document.querySelector('[data-dashboard-key="model-requests"]').textContent`),/HTTP 503.*offline-provider-request/s);
  await cdp('Emulation.setDeviceMetricsOverride',{width:760,height:1000,deviceScaleFactor:1,mobile:false});
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
  results.push('请求模型按 HTTP 回执显示并提供服务商请求 ID，长列表和窄窗口无溢出');

  const canvasProject=model.makeProject('客户画布恢复隔离回归','standard'),canvasEpisode=model.makeEpisode(1,'已有内容'),draftEpisode=model.makeEpisode(2,'未建立片段');
  const canvasBeat={...model.makeBeat(),event:'隔离人物在门厅取回隔离信件。',reaction:'同伴确认封印完整。',dialogue:['隔离人物：信件拿到了。'],os:['隔离人物：封印还在。'],floatLabels:['隔离门厅'],systemPanels:['测试状态：完整']};
  canvasEpisode.scriptBeats=[canvasBeat];canvasEpisode.segments=[model.makeSegment(canvasBeat,1),model.makeSegment(canvasBeat,2)];
  const canvasPrompt='已保存的完整候选提示词，含对白、OS、浮签和系统信息。';
  const canvasSegment=canvasEpisode.segments[1];canvasSegment.artifacts=[{id:model.id(),kind:'prompt',createdAt:model.now(),sourceHash:'offline-canvas',content:canvasPrompt}];canvasSegment.promptSelectionPaused=true;
  canvasProject.episodes=[canvasEpisode,draftEpisode];canvasProject.assets=[
    {id:model.id(),kind:'prop',name:'隔离信件',identity:'封印完整的信件',voice:'',states:[],images:[]},
    {id:model.id(),kind:'scene',name:'仅子镜引用场景',identity:'门厅空间',voice:'',states:[],images:[]},
    {id:model.id(),kind:'scene',name:'别集山洞',identity:'无关资产',voice:'',states:[],images:[]},
  ];canvasEpisode.segments[0].subshots[0].assetIds=[canvasProject.assets[1].id];store.insertProject(canvasProject);
  const canvasStoryBefore=JSON.stringify(canvasEpisode.scriptBeats),canvasEventsBefore=events().length;
  const propId=canvasProject.assets[0].id,propSelector=`[data-node-id="asset:${propId}:main"]`,candidateSelector=`[data-node-id="shot:${canvasSegment.id}"]`;
  const reopenCanvas=async episode=>{
    await cdp('Page.navigate',{url:base});await openProject(canvasProject);
    await click(`[data-action="open-episode"][data-id="${episode.id}"]`);await idle();await tab('canvas');
    if(!await evaluate(`Boolean(document.querySelector('.studio-native-canvas'))`)){await click('[data-action="canvas-view"][data-view="graph"]');await idle();}
    await visible('.studio-native-canvas');
  };
  await cdp('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});await reopenCanvas(canvasEpisode);
  await visible(propSelector);await visible(`[data-node-id="asset:${canvasProject.assets[1].id}:main"]`);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-node-id="asset:${canvasProject.assets[2].id}:main"]'))`),false);
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(candidateSelector)}).textContent`),/候选提示词.*未选用/s);
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(candidateSelector)}).textContent`)).includes(canvasPrompt));
  await click(`${candidateSelector} [data-action="prompt-manager-open"]`);await visible('[data-prompt-manager]');
  assert.equal(await evaluate(`document.querySelector('[data-prompt-manager] [name="prompt-editor-segment"]').value`),canvasSegment.id);
  await click('[data-action="prompt-manager-close"]');await idle();
  assert.equal(store.getProject(canvasProject.id).episodes[0].segments[1].selected.prompt,undefined);
  results.push('重新打开项目显示未绑定的本集资产及完整候选提示词，候选入口定位正确片段并保留未选用状态');

  await click(`${propSelector} .mumu-node-actions button`);await visible('.mumu-node.asset.is-selected');
  await evaluate(`document.querySelector('.studio-native-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true}))`);
  await wait(()=>evaluate(`document.querySelector('.mumu-node.asset.is-selected')?.dataset.nodeId?.startsWith('workspace:')`),'未创建资产工作副本');
  const copyId=await evaluate(`document.querySelector('.mumu-node.asset.is-selected').dataset.nodeId`),copySelector=`[data-node-id="${copyId}"]`;
  const uploadPng=(await sharp({create:{width:32,height:32,channels:3,background:'#123456'}}).png().toBuffer()).toString('base64');
  await evaluate(`(() => {const bytes=Uint8Array.from(atob(${JSON.stringify(uploadPng)}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'canvas-test.png',{type:'image/png'}));document.querySelector(${JSON.stringify(copySelector)}).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
  await wait(()=>store.getProject(canvasProject.id).assets[0].images.length===1,'资产导入未保存');await visible(`${copySelector} img`);await visible(`${propSelector} img`);
  const imported=store.getProject(canvasProject.id).assets[0].images[0],importedUrl='/media/'+imported.mediaPath.split('/').map(encodeURIComponent).join('/');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(copySelector+' img')}).getAttribute('src')`),importedUrl);
  await wait(()=>evaluate(`JSON.parse(localStorage.getItem('manju-native-canvas-v1:${canvasProject.id}:${canvasEpisode.id}')||'{}').notes?.some(n=>n.id===${JSON.stringify(copyId)}&&n.imageId===${JSON.stringify(imported.id)})`),'工作副本导入版本未持久化');
  await reopenCanvas(canvasEpisode);await visible(`${copySelector} img`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(copySelector+' img')}).getAttribute('src')`),importedUrl);
  const reopened=store.getProject(canvasProject.id);assert.equal(JSON.stringify(reopened.episodes[0].scriptBeats),canvasStoryBefore);assert.equal(imported.review,undefined);
  assert.ok(reopened.episodes[0].segments.every(s=>!(s.assetBindings||[]).length));assert.equal(reopened.episodes[0].segments[1].promptSelectionPaused,true);assert.equal(events().length,canvasEventsBefore);
  results.push('资产工作副本导入后立即同步图片，重开保留导入版本且不自动绑定、审核或提交生成');

  await reopenCanvas(draftEpisode);await click('.mumu-add-asset');await visible('[aria-label="新资产名称"]');
  await evaluate(`(() => {for(const [label,value] of [['新资产名称','隔离新人物'],['新资产描述','完整四视图人物描述']]){const field=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field),'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await click('.mumu-create-primary');await idle();
  await wait(()=>store.getProject(canvasProject.id).assets.some(a=>a.name==='隔离新人物'),'空片段画布新人物未保存');
  const created=store.getProject(canvasProject.id).assets.find(a=>a.name==='隔离新人物'),createdSelector=`[data-node-id="asset:${created.id}:turnaround"]`;
  await visible(createdSelector);
  await wait(()=>evaluate(`Boolean(JSON.parse(localStorage.getItem('manju-native-canvas-v1:${canvasProject.id}:${draftEpisode.id}')||'{}').points?.['asset:${created.id}:turnaround'])`),'四视图位置未保存');
  await reopenCanvas(draftEpisode);await visible(createdSelector);
  assert.equal(store.getProject(canvasProject.id).episodes[1].segments.length,0);assert.equal(events().length,canvasEventsBefore);
  results.push('尚无片段的画布可创建人物资产，完整四视图节点及正确位置在重开后恢复');
  await evaluate(`(() => {const key='manju-native-canvas-v1:${canvasProject.id}:${draftEpisode.id}',layout=JSON.parse(localStorage.getItem(key));layout.library=[{id:'asset:${propId}:main',type:'asset',title:'隔离信件 · 保留素材',assetId:${JSON.stringify(propId)},imageId:${JSON.stringify(imported.id)},role:'main',content:'素材库保留描述',media:${JSON.stringify(importedUrl)},tags:['保留版本'],position:{x:40,y:60},width:275,height:310}];localStorage.setItem(key,JSON.stringify(layout));})()`);
  await reopenCanvas(draftEpisode);await click('.mumu-outline-tabs button:last-child');await visible('.mumu-outline-item');await click('.mumu-outline-item');
  await wait(()=>evaluate(`document.querySelector('.mumu-node.asset.is-selected')?.dataset.nodeId?.startsWith('workspace:')`),'素材库未以工作节点加入画布');
  const restoredAssetId=await evaluate(`document.querySelector('.mumu-node.asset.is-selected').dataset.nodeId`),restoredAssetSelector=`[data-node-id="${restoredAssetId}"] img`;
  await visible(restoredAssetSelector);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(restoredAssetSelector)}).getAttribute('src')`),importedUrl);
  await wait(()=>evaluate(`JSON.parse(localStorage.getItem('manju-native-canvas-v1:${canvasProject.id}:${draftEpisode.id}')).notes.some(n=>n.id===${JSON.stringify(restoredAssetId)})`),'素材库恢复节点未持久化');
  await reopenCanvas(draftEpisode);await visible(restoredAssetSelector);assert.equal(events().length,canvasEventsBefore);
  results.push('从素材库加入当前画布未展示的资产采用可恢复工作节点，重开保留完整图片和引用版本');
  writeFileSync(path.join(root, 'ui-result.json'), JSON.stringify({passed: true, browser, results}, null, 2));
  console.log(JSON.stringify({passed: true, directory: root, results}));
} catch (error) {
  const state = evaluate ? await evaluate(`({projectId: document.querySelector('manju-app')?.project?.id, tab: document.querySelector('manju-app')?.tab, busy: document.querySelector('manju-app')?.busy, notice: document.querySelector('manju-app')?.message})`).catch(() => null) : null;
  writeFileSync(path.join(root, 'ui-result.json'), JSON.stringify({passed: false, error: String(error), state, results}, null, 2));
  console.error(JSON.stringify({directory: root, state, results})); throw error;
} finally {
  episodes.slice(0, 2).forEach(release);
  if (ws?.readyState === 1) ws.close();
  await stop(chrome); await stop(service); store.db.close();
}
