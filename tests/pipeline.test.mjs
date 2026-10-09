import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'manju-mvp-'));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, endpoint, method = 'GET', value) {
  const response = await fetch(base + endpoint, { method,
    headers: value === undefined ? undefined : { 'Content-Type': 'application/json', ...(endpoint.endsWith('/authorize')?{Origin:base}:{}) },
    body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${endpoint}: ${result.error}`);
  return result;
}

async function waitFor(base, predicate, endpoint) {
  for (let i = 0; i < 80; i++) {
    try {
      const value = await request(base, endpoint);
      if (predicate(value)) return value;
    } catch { /* server may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('任务未完成');
}

test('完整内容合同、批量版本链和剪映草稿导出', async () => {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const processServer = spawn(process.execPath, ['dist-server/server/index.js'], { cwd: root,
    env: { ...process.env, MANJU_PORT: String(port), MANJU_DATA_DIR: path.join(temp, 'data'),
      MANJU_JIANYING_DRAFTS_DIR: path.join(temp, 'drafts'),
      MANJU_VIDEO_ADAPTER: '',
      MANJU_VIDEO_ADAPTER_DEMO: '1' }, windowsHide: true, stdio: 'ignore' });
  try {
    await waitFor(base, value => value.ok, '/api/health');
    let project = await request(base, '/api/projects', 'POST', { name: 'MVP验收', mode: 'standard' });
    const action = async value => project = await request(base, `/api/projects/${project.id}/actions`, 'POST', value);
    await action({ type: 'project.style', name: '项目国风', description: '统一暖色水墨光影' });
    await action({ type: 'project.model', kind: 'text', name: '测试文本模型', modelId: 'fixture.text',
      adapterPath: path.join(root, 'tests', 'fixtures', 'text-adapter.mjs') });
    await action({ type: 'project.model', kind: 'image', name: '测试图片模型', modelId: 'fixture.image',
      adapterPath: path.join(root, 'tests', 'fixtures', 'image-adapter.mjs') });
    await action({ type: 'project.model', name: '本地技术模型', modelId: 'fixture.video',
      adapterPath: path.join(root, 'tests', 'fixtures', 'video-adapter.mjs') });
    for (const kind of ['text', 'image', 'video']) {
      const check = await request(base, `/api/projects/${project.id}/models/${kind}/test`, 'POST', {});
      assert.equal(check.ok, true);
    }
    project = await request(base, `/api/projects/${project.id}`);
    assert.ok(project.modelChecks.video.checkedAt);
    await action({ type: 'project.source', sourceText: '第一章：雨夜里，林舟看到系统面板。他听见门外脚步，决定开门，并在同伴劝阻后停住，回头确认同伴安全。屋外的脚步越走越近，门缝下透进冷光。同伴抓住他的袖口，他先看向同伴，才重新看向门。' });
    const budget=await request(base,`/api/projects/${project.id}/assist/plan-preview`);
    await assert.rejects(request(base,`/api/projects/${project.id}/assist/plan`,'POST',{}),/预算预览/);
    const storyPlan = await request(base, `/api/projects/${project.id}/assist/plan`, 'POST', {budgetHash:budget.hash});
    assert.equal(storyPlan.method, 'story');
    assert.equal(storyPlan.ranges[0].end, project.sourceCorpus.length);
    await action({ type: 'project.plan', chaptersPerEpisode: 1 });
    assert.equal(project.episodePlan.ranges.length, 1);
    await action({ type: 'project.createEpisodes' });
    const ep = project.episodes[0];
    assert.equal(ep.visualStyle.name, '项目国风');
    assert.equal(ep.sourceText, project.sourceCorpus);
    await action({ type: 'episode.confirmSource', episodeId: ep.id });
    await request(base, `/api/projects/${project.id}/episodes/${ep.id}/assist/highlight`, 'POST', {});
    project = await request(base, `/api/projects/${project.id}`);
    assert.match(project.episodes[0].highlightCandidate.content, /事件因果/);
    await action({ type: 'episode.update', episodeId: ep.id, highlightReport: '章节范围：第一章。事件因果：门外脚步促使林舟开门，同伴劝阻使他停下。人物反应：回头确认同伴安全。浮签和面板：雨夜、系统警告。未采用素材：无。' });
    await action({ type: 'episode.confirmHighlight', episodeId: ep.id });
    await request(base, `/api/projects/${project.id}/episodes/${ep.id}/assist/script`, 'POST', {});
    project = await request(base, `/api/projects/${project.id}`);
    assert.equal(project.episodes[0].scriptCandidate.beats.length, 1);
    await action({ type: 'beat.add', episodeId: ep.id });
    const beat = project.episodes[0].scriptBeats[0];
    await action({ type: 'beat.update', episodeId: ep.id, beatId: beat.id,
      sourceQuote: '他听见门外脚步，决定开门',
      event: '林舟听见门外脚步，决定开门', reaction: '同伴劝阻后林舟停住，回头确认同伴安全',
      dialogue: ['林舟：外面有人。'], os: ['林舟：先确认她安全。'],
      floatLabels: ['雨夜'], systemPanels: ['系统警告：危险靠近'] });
    await action({ type: 'script.lock', episodeId: ep.id });
    assert.equal((await request(base, `/api/projects/${project.id}/episodes/${ep.id}/assist/assets`, 'POST', {})).assets, 1);
    project = await request(base, `/api/projects/${project.id}`);
    assert.equal(project.episodes[0].assetCandidate.entries[0].name, '林舟');
    assert.equal((await request(base, `/api/projects/${project.id}/episodes/${ep.id}/assist/effects`, 'POST', {})).candidates, 0);
    const seg = project.episodes[0].segments[0];
    await action({ type: 'asset.add', kind: 'character', name: '林舟', identity: '黑发青年，左眉有浅痣',
      voice: '青年男声，沉稳' });
    const character = project.assets[0];
    // State images require a reviewed identity anchor before generation.
    await request(base, `/api/projects/${project.id}/assets/${character.id}/images/generate`, 'POST', {role:'turnaround'});
    project = await request(base, `/api/projects/${project.id}`);
    await action({ type: 'asset.imageReview', assetId: character.id, imageId: project.assets[0].images[0].id,
      status: 'approved', checks: { identity: true, state: true, shape: true, clothing: true } });
    await action({ type: 'asset.state', assetId: character.id, label: '雨夜湿衣',
      appearance: '深青衣被雨淋湿，袖口沾水', trigger: '林舟听见门外脚步',
      startEpisode: 1, startSegment: 1 });
    const state = project.assets[0].states[0];
    await action({type:'episode.applyAssetCandidate',episodeId:ep.id});
    const reviewImages = async () => { for (const image of project.assets[0].images) await action({ type: 'asset.imageReview', assetId: character.id, imageId: image.id, status: 'approved', checks: { identity: true, state: true, shape: true, clothing: true } }); };
    const generatedImage = await request(base,
      `/api/projects/${project.id}/assets/${character.id}/images/generate`, 'POST', { stateId: state.id, role:'turnaround' });
    assert.match(generatedImage.mediaPath, /\.png$/);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6e8AAAAASUVORK5CYII=', 'base64');
    const imageResponse = await fetch(base + `/api/projects/${project.id}/assets/${character.id}/images?stateId=${state.id}&role=turnaround`,
      { method: 'POST', body: image });
    assert.equal(imageResponse.status, 201, await imageResponse.text());
    const portraitResponse = await fetch(base + `/api/projects/${project.id}/assets/${character.id}/images?stateId=${state.id}&role=portrait`,
      { method: 'POST', body: image });
    assert.equal(portraitResponse.status, 400, await portraitResponse.text());
    project = await request(base, `/api/projects/${project.id}`);
    await reviewImages();
    await action({ type: 'segment.assets', episodeId: ep.id, segmentId: seg.id,
      bindings: [{ assetId: character.id, imageId: project.assets[0].images.find(image => image.role === 'turnaround' && image.stateId === state.id).id }] });
    await action({ type: 'segment.update', episodeId: ep.id, segmentId: seg.id,
      visualPlan: '中景，林舟在左，同伴在右；林舟向门移动后停住，末帧回头。',
      durationSec: 30, action: false });
    await request(base, `/api/projects/${project.id}/episodes/${ep.id}/segments/${seg.id}/assist/storyboard`, 'POST', {});
    project = await request(base, `/api/projects/${project.id}`);
    assert.equal(project.episodes[0].segments[0].subshotCandidate.shots.length, 7);
    await action({ type: 'segment.subshots.applyCandidate', episodeId: ep.id, segmentId: seg.id });
    await action({ type: 'segment.subshots.approve', episodeId: ep.id, segmentId: seg.id });
    await request(base, `/api/projects/${project.id}/jobs`, 'POST', { episodeId: ep.id,
      segmentIds: [seg.id], kinds: ['anchor', 'prompt'] });
    await waitFor(base, jobs => jobs.filter(job => ['anchor','prompt'].includes(job.kind)).length === 2 && jobs.every(job => job.status === 'completed'), `/api/projects/${project.id}/jobs`);
    project = await request(base, `/api/projects/${project.id}`);
    assert.equal(project.episodes[0].segments[0].artifacts.length, 2);
    const prompt = project.episodes[0].segments[0].artifacts.find(item => item.kind === 'prompt').content;
    assert.match(prompt, /项目国风/);
    assert.match(prompt, /对白和内心OS不生成画面字幕/);
    assert.match(prompt, /系统警告：危险靠近/);
    assert.match(prompt, /雨夜湿衣/);
    await action({ type: 'project.style', name: '项目国风', description: '统一冷色水墨光影' });
    assert.equal(project.episodes[0].segments[0].selected.prompt, undefined);
    assert.equal(project.episodes[0].auditApprovedHash, undefined);
    await action({ type: 'project.style', name: '项目国风', description: '统一暖色水墨光影' });
    await request(base, `/api/projects/${project.id}/jobs`, 'POST', { episodeId: ep.id,
      segmentIds: [seg.id], kinds: ['prompt'] });
    await waitFor(base, jobs => jobs.filter(job => ['anchor','prompt'].includes(job.kind)).length === 3 && jobs.every(job => job.status === 'completed'),
      `/api/projects/${project.id}/jobs`);
    project = await request(base, `/api/projects/${project.id}`);
    assert.match(project.episodes[0].segments[0].artifacts.find(item => item.id === project.episodes[0].segments[0].selected.prompt).content,
      /统一暖色水墨光影/);
    await request(base,`/api/projects/${project.id}/episodes/${ep.id}/assist/semantic-review`,'POST',{});
    project=await request(base,`/api/projects/${project.id}`);
    assert.equal(project.episodes[0].semanticCandidate.entries.length,1);
    assert.equal(project.episodes[0].storyReview,undefined);
    await action({ type: 'episode.storyReview', episodeId: ep.id, entries: [{ beatId: beat.id, sourceStart: 0, sourceEnd: ep.sourceText.length, highlightIds:project.episodes[0].highlightItems.map(item=>item.id),notes: '测试原文事件反应与声音可见信息已逐项核对', checks: { highlight: true, event: true, reaction: true, speech: true, labels: true } }] });
    assert.deepEqual((await request(base, `/api/projects/${project.id}/episodes/${ep.id}/audit`)).issues, []);
    await action({ type: 'audit.approve', episodeId: ep.id });
    const production = await request(base, `/api/projects/${project.id}/episodes/${ep.id}/package`, 'POST', {});
    assert.equal(production.segments, 1);
    assert.equal(existsSync(path.join(production.folder, '片段001', '建议动作锚点板.svg')), false);
    assert.match(readFileSync(path.join(production.folder, '片段001', '正式分镜.txt'), 'utf8'), /子镜 1/);
    assert.match(readFileSync(path.join(production.folder, '片段001', '最终视频提示词.txt'), 'utf8'), /雨夜湿衣/);
    assert.match(readFileSync(path.join(production.folder, '片段001', '正式分镜.txt'), 'utf8'), /结果：/);
    assert.match(readFileSync(path.join(production.folder, '00_自动验收表.md'), 'utf8'), /原文依据/);
    const productionRefs = JSON.parse(readFileSync(path.join(production.folder, '片段001', '参考图顺序.json'))).references;
    assert.equal(productionRefs[0].name, '林舟');
    assert.equal(productionRefs[0].role, 'main');assert.equal(productionRefs.length,1);assert.equal(productionRefs[0].referenceLayout,'three-view-portrait');
    const packageTask = await request(base, `/api/projects/${project.id}/agent/task`, 'POST', {
      requestId: 'offline-package-task', agent: 'offline-test', confirmed: true,
      statement: '仅将已核验的测试内容导出生产包，不提交模型生成。', episodeIds: [ep.id], delivery: 'package' });
    const agentCommand = async (requestId, value) => {
      const context = await request(base, `/api/projects/${project.id}/agent`);
      return request(base, `/api/projects/${project.id}/agent/command`, 'POST', {
        requestId, expectedHash: context.stateHash, taskId: packageTask.id, ...value });
    };
    const packageFlow = (await agentCommand('offline-package-start', { command: 'start', episodeId: ep.id })).result;
    assert.equal(packageFlow.step.task, 'package');
    await agentCommand('offline-package-export', { command: 'continue', workflowId: packageFlow.id });
    const completedPackage = await waitFor(base, flows => flows[0].status === 'completed', `/api/projects/${project.id}/workflows`);
    assert.ok(existsSync(completedPackage[0].exportResult.package.folder));
    const packageDashboard = await request(base, `/api/projects/${project.id}/agent/dashboard`);
    assert.equal(packageDashboard.deliverables[0].path, completedPackage[0].exportResult.package.folder);
    assert.equal(packageDashboard.deliverables[0].available, true);
    assert.equal(packageDashboard.workflows[0].taskId, packageTask.id);
    assert.equal(packageDashboard.tasks[0].remaining.video, 0);
    assert.equal((await request(base, `/api/projects/${project.id}/jobs`)).filter(j => j.kind === 'video').length, 0);
    for (let count = 1; count <= 2; count++) {
      await request(base, `/api/projects/${project.id}/jobs`, 'POST', { episodeId: ep.id,
        segmentIds: [seg.id], kinds: ['video'], regenerate: count > 1 });
      await waitFor(base, jobs => jobs.filter(job => job.kind === 'video' && job.status === 'completed').length === count,
        `/api/projects/${project.id}/jobs`);
      if (count === 1) await assert.rejects(request(base, `/api/projects/${project.id}/jobs`, 'POST', {
        episodeId: ep.id, segmentIds: [seg.id], kinds: ['video'] }), /已有当前剧本与模型的成功视频/);
    }
    project = await request(base, `/api/projects/${project.id}`);
    const generated = project.episodes[0].segments[0].artifacts.filter(item => item.kind === 'video');
    assert.equal(generated.length, 2);
    assert.equal(project.episodes[0].segments[0].selected.video, generated[0].id);
    assert.equal(generated[0].demo, true);
    assert.equal(generated[0].modelId, 'fixture.video');
    const adapterRequest = JSON.parse(readFileSync(path.join(temp, 'data', 'media',
      generated[0].mediaPath.replace(/\.mp4$/, '.json'))));
    assert.equal(adapterRequest.model.id, 'fixture.video');
    assert.equal(adapterRequest.visualStyle.description, '统一暖色水墨光影');
    assert.equal(adapterRequest.references[0].name, '林舟');
    assert.equal(adapterRequest.references[0].stateLabel, '雨夜湿衣');
    assert.equal(adapterRequest.references[0].role, 'main');assert.equal(adapterRequest.references.length,1);assert.equal(adapterRequest.references[0].referenceLayout,'three-view-portrait');
    assert.equal(adapterRequest.anchorSvg, undefined);
    assert.deepEqual(adapterRequest.referenceOrder, ['character:main', 'scene', 'prop']);
    assert.match(adapterRequest.references[0].filePath, /\.png$/);

    const fixture = path.join(temp, 'voice.mp4');
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=640x360:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture], { stdio: 'ignore', windowsHide: true });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg失败')));
    });
    const video = readFileSync(fixture);
    const response = await fetch(base + `/api/projects/${project.id}/episodes/${ep.id}/segments/${seg.id}/media`,
      { method: 'POST', headers: { 'X-File-Name': 'voice.mp4' }, body: video });
    assert.equal(response.status, 201, await response.text());
    project = await request(base, `/api/projects/${project.id}`);
    const imported = project.episodes[0].segments[0].artifacts.filter(item => item.kind === 'video').at(-1);
    await action({ type: 'segment.select', episodeId: ep.id, segmentId: seg.id,
      kind: 'video', artifactId: imported.id });
    assert.match((await request(base, `/api/projects/${project.id}/episodes/${ep.id}/preflight`)).issues.join('；'), /技术检查/);
    await assert.rejects(request(base, `/api/projects/${project.id}/episodes/${ep.id}/export-mp4`, 'POST', {}), /技术检查/);
    await request(base,
      `/api/projects/${project.id}/episodes/${ep.id}/segments/${seg.id}/videos/${imported.id}?action=inspect`, 'POST', {});
    await action({ type: 'segment.videoReview', episodeId: ep.id, segmentId: seg.id,
      artifactId: imported.id, status: 'approved', notes: '已核对对白、OS、浮签与服饰状态',
      speech: [{ id: `${beat.id}:dialogue:0`, heard: true, speaker: true, startSec: 0, endSec: 2 }, { id: `${beat.id}:os:0`, heard: true, speaker: true, startSec: 0, endSec: 3 }],
      checks: { story: true, voice: true, assets: true, labels: true, pacing: true, continuity: true } });
    await action({ type: 'episode.previewCuts', episodeId: ep.id,
      cuts: [{ segmentId: seg.id, artifactId: imported.id, startSec: 0.5, durationSec: 1 }] });
    await action({ type: 'episode.previewCuts', episodeId: ep.id,
      cuts: [{ segmentId: seg.id, artifactId: imported.id, startSec: 29.5, durationSec: 1 }] });
    await assert.rejects(request(base, `/api/projects/${project.id}/episodes/${ep.id}/export`, 'POST', {}),
      /超出视频时长/);
    await action({ type: 'episode.previewCuts', episodeId: ep.id,
      cuts: [{ segmentId: seg.id, artifactId: imported.id, startSec: 0.5, durationSec: 1 }] });
    await action({ type: 'segment.select', episodeId: ep.id, segmentId: seg.id,
      kind: 'video', artifactId: generated[1].id });
    await assert.rejects(request(base, `/api/projects/${project.id}/episodes/${ep.id}/export`, 'POST', {}),
      /选中视频已变化/);
    await action({ type: 'segment.select', episodeId: ep.id, segmentId: seg.id,
      kind: 'video', artifactId: imported.id });
    const exported = await request(base, `/api/projects/${project.id}/episodes/${ep.id}/export`, 'POST', {});
    assert.equal(exported.clips, 2);
    assert.equal(exported.previewIncluded, true);
    const draft = JSON.parse(readFileSync(path.join(exported.draftDir, 'draft_content.json')));
    assert.equal(draft.tracks.length, 1);
    assert.equal(draft.tracks[0].segments.length, 2);
    assert.equal(draft.tracks[0].segments[0].source_timerange.start, 500000);
    assert.equal(draft.tracks[0].segments[0].source_timerange.duration, 1000000);
    assert.equal(draft.tracks[0].segments[1].source_timerange.start, 0);
    assert.equal(draft.tracks[0].segments[1].speed, 1.15);
    assert.equal(draft.materials.texts.length, 0);
    assert.equal(draft.materials.audios.length, 0);
    assert.ok(draft.materials.videos.every(item => item.has_audio));
    const manifest = JSON.parse(readFileSync(path.join(exported.draftDir, 'manju_manifest.json')));
    assert.equal(manifest.clips[0].sourceStartSeconds, 0.5);
    assert.equal(manifest.clips[0].preview, true);
    assert.notEqual((await request(base, `/api/projects/${project.id}/episodes/${ep.id}/export`, 'POST', {})).draftDir, exported.draftDir);
    const mp4 = await request(base, `/api/projects/${project.id}/episodes/${ep.id}/export-mp4`, 'POST', {});
    assert.equal(mp4.clips, 2); assert.equal(mp4.previewIncluded, true);
    assert.ok(Math.abs(mp4.durationSeconds - exported.durationSeconds) < 0.3);
    assert.equal(mp4.width, 640); assert.equal(mp4.height, 360);
    const mp4Manifest = JSON.parse(readFileSync(mp4.filePath + '.json'));
    assert.equal(mp4Manifest.originalAudioPreserved, true);
    assert.equal(mp4Manifest.clips[0].sourceStartSeconds, 0.5);
    assert.equal(mp4Manifest.generationInputs[0].artifactId, imported.id);
    const playable = await fetch(base + mp4.url, {headers:{Range:'bytes=0-99'}});
    assert.equal(playable.status,206); assert.equal(playable.headers.get('content-type'),'video/mp4');
    await assert.rejects(request(base, `/api/projects/${project.id}/episodes/${ep.id}/export-mp4`, 'POST', {editingDraft:true}), /正式导出预检/);
    const flow = await request(base, `/api/projects/${project.id}/workflows`, 'POST', {episodeId:ep.id,delivery:'video',limits:{text:0,image:0,video:0}});
    assert.equal(flow.step.kind,'export');
    await request(base, `/api/projects/${project.id}/workflows/${flow.id}/authorize`, 'POST', {hash:flow.step.hash,confirmed:true});
    const done = (await waitFor(base, values=>values.find(v=>v.id===flow.id)?.status==='completed', `/api/projects/${project.id}/workflows`)).find(v=>v.id===flow.id);
    assert.ok(existsSync(done.exportResult.mp4.filePath));assert.ok(existsSync(done.exportResult.draftDir));
    assert.deepEqual(done.used,{text:0,image:0,video:0});
    writeFileSync(path.join(temp,'ready-project.json'),JSON.stringify(await request(base, `/api/projects/${project.id}`)));
    if (process.env.MANJU_TEST_UPSCALE === '1') {
      const enhanced = await request(base, `/api/projects/${project.id}/episodes/${ep.id}/export`, 'POST',
        { upscale: true, onlyBelow1080: true });
      const enhancedDraft = JSON.parse(readFileSync(path.join(enhanced.draftDir, 'draft_content.json')));
      assert.equal(enhancedDraft.materials.videos[0].width, 1280);
      assert.equal(enhancedDraft.materials.videos[0].height, 720);
      assert.ok(enhancedDraft.materials.videos.every(item => item.has_audio));
    }
    await action({ type: 'segment.videoReview', episodeId: ep.id, segmentId: seg.id,
      artifactId: generated[1].id, status: 'rejected', notes: '动作不符合剧本' });
    await assert.rejects(action({ type: 'segment.select', episodeId: ep.id, segmentId: seg.id,
      kind: 'video', artifactId: generated[1].id }), /废片不能选为正式视频/);
    await action({ type: 'segment.videoReview', episodeId: ep.id, segmentId: seg.id,
      artifactId: imported.id, status: 'rejected', notes: '复看后发现镜头穿帮' });
    assert.equal(project.episodes[0].segments[0].selected.video, undefined);
    await action({ type: 'segment.videoReview', episodeId: ep.id, segmentId: seg.id,
      artifactId: imported.id, status: 'approved', notes: '复核确认可以使用',
      speech: [{ id: `${beat.id}:dialogue:0`, heard: true, speaker: true, startSec: 0, endSec: 2 }, { id: `${beat.id}:os:0`, heard: true, speaker: true, startSec: 0, endSec: 3 }],
      checks: { story: true, voice: true, assets: true, labels: true, pacing: true, continuity: true } });
    assert.equal(project.episodes[0].segments[0].selected.video, imported.id);
    await action({ type: 'segment.update', episodeId: ep.id, segmentId: seg.id,
      visualPlan: '同一剧情改为近景开场，再接门口中景。' });
    assert.match((await request(base, `/api/projects/${project.id}/episodes/${ep.id}/preflight`)).issues.join('；'),
      /旧分镜/);
    await action({ type: 'script.newVersion', episodeId: ep.id });
    assert.equal(project.episodes[0].scriptVersion, 2);
    assert.equal(project.episodes[0].scriptHistory.length, 1);
    assert.equal(project.episodes[0].scriptHistory[0].segments[0].selected.video, imported.id);
    assert.equal(project.episodes[0].segments.length, 0);
    assert.equal(project.episodes[0].scriptLockedHash, undefined);
    await action({ type: 'beat.update', episodeId: ep.id, beatId: beat.id,
      event: '林舟听见门外脚步，决定开门，随后停下', reaction: '他回头确认同伴安全' });
    await action({ type: 'script.lock', episodeId: ep.id });
    assert.equal(project.episodes[0].scriptHistory[0].scriptBeats[0].event, '林舟听见门外脚步，决定开门');
    assert.notEqual(project.episodes[0].segments[0].id, seg.id);
  } finally {
    processServer.kill();
    await new Promise(resolve => processServer.once('exit', resolve));
    if (!process.env.MANJU_TEST_KEEP_FILES) rmSync(temp, { recursive: true, force: true });
  }
});
