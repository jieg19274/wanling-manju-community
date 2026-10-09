import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

mkdirSync(path.resolve('.test-temp'), {recursive: true});
const root = mkdtempSync(path.resolve('.test-temp/concurrency-'));
const gates = path.join(root, 'release'), eventsPath = path.join(root, 'events.jsonl');
mkdirSync(gates);
Object.assign(process.env, {MANJU_DATA_DIR: path.join(root, 'data'), MANJU_BACKUP_DIR: path.join(root, 'backups'),
  MANJU_IMAGE_CONCURRENCY: '2', MANJU_VIDEO_CONCURRENCY: '1', MANJU_TEXT_CONCURRENCY: '2',
  MANJU_TEST_CONCURRENCY_EVENTS: eventsPath, MANJU_TEST_CONCURRENCY_RELEASE_DIR: gates,
  MANJU_TEST_CONCURRENCY_CLIP: path.join(root, 'fixture.mp4')});
const model = await import('../dist-server/shared/model.js');
const store = await import('../dist-server/server/store.js');
const {runJsonAdapter, runFileAdapter} = await import('../dist-server/server/adapter-runner.js');
const {enqueue, wake, recoverJobs, runQueuedVideoConcurrently} = await import('../dist-server/server/jobs.js');
const {candidatePreview, createCandidates, tickCandidates} = await import('../dist-server/server/candidates.js');
const {concurrencyLimits} = await import('../dist-server/server/concurrency.js');
const adapter = path.resolve('tests/fixtures/gated-concurrency-adapter.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = () => existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const started = (kind, key) => events().some(event => event.event === 'start' && event.kind === kind && event.key === key);
const release = (kind, key) => writeFileSync(path.join(gates, `${kind}.${encodeURIComponent(key)}`), 'released');
async function wait(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  assert.fail(message);
}
function seedVideo(name) {
  const project = model.makeProject(name, 'standard'), episode = model.makeEpisode(1, '测试');
  project.episodes = [episode]; project.assets = [];
  project.videoModel = {name: 'offline', modelId: 'offline', adapterPath: adapter};
  episode.sourceText = '原文连续内容'.repeat(30);
  episode.sourceReviewedHash = model.sourceHash(episode);
  episode.highlightReport = '原文因果与人物反应'; episode.highlightReviewedHash = model.highlightHash(episode);
  const beat = {...model.makeBeat(), sourceQuote: episode.sourceText,
    event: '人物发现门外来客，走到门边查看来客身影',
    reaction: '同伴拉住衣袖，人物停步回头确认同伴安全', dialogue: ['人物：先别开门。']};
  episode.scriptBeats = [beat]; model.lockScript(episode);
  const segment = episode.segments[0]; segment.durationSec = 30;
  segment.subshots = model.defaultSubshots(beat, 30).map((shot, index) => ({...shot,
    action: (index < 3 ? beat.event : beat.reaction).slice((index % 3) * 4, (index % 3) * 4 + 4)}));
  segment.subshotsReviewed = true; segment.visualPlan = '门边近景到中景与末帧';
  const prompt = {id: model.id(), kind: 'prompt', createdAt: model.now(),
    sourceHash: model.contentHash(episode, segment), content: model.composePrompt(episode, segment)};
  segment.artifacts = [prompt]; segment.selected.prompt = prompt.id;
  episode.auditApprovedHash = model.approvalHash(episode); store.insertProject(project);
  return {project, episode, segment};
}
function queueVideo(seed) { return enqueue(seed.project.id, seed.episode.id, [seed.segment.id], ['video'])[0]; }
const jobStatus = job => store.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)?.status;

test('independent bounded lanes, text FIFO and failure release, budget isolation, and restart reconciliation', {timeout: 90000}, async () => {
  const clip = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=navy:s=96x54:r=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '30', '-c:v', 'libx264', '-c:a', 'aac', process.env.MANJU_TEST_CONCURRENCY_CLIP],
  {windowsHide: true, encoding: 'utf8'});
  assert.equal(clip.status, 0, clip.stderr);
  const textProject = model.makeProject('并发文本测试', 'standard'); store.insertProject(textProject);
  const keys = ['text-a', 'text-b', 'text-c', 'text-fail', 'text-e'];
  const requests = keys.map(key => ({task: 'concurrency-fixture', projectId: textProject.id, key}));
  const pending = requests.map(request => runJsonAdapter(adapter, request).then(value => ({ok: true, value}), error => ({ok: false, error})));
  let directImage;
  const images = [], videos = [];
  let ledger;
  try {
    await wait(() => started('text', keys[0]) && started('text', keys[1]), 'first two text requests did not start');
    assert.equal(started('text', keys[2]), false);
    await assert.rejects(runJsonAdapter(adapter, requests[2]), /相同模型请求已排队或正在生成/);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM adapter_tasks WHERE status='queued'").get().n, 3);
    for (const name of ['image-a', 'image-b']) {
      const project = model.makeProject(name, 'standard');
      project.imageModel = {name: 'offline', modelId: 'offline', adapterPath: adapter};
      const asset = {id: model.id(), kind: 'character', name, identity: 'same registered identity', voice: '', states: [], images: []};
      project.assets = [asset]; store.insertProject(project); images.push({project, asset});
      const request = {kind: 'image', assetId: asset.id, role: 'turnaround', count: 1, feedback: ''};
      const preview = candidatePreview(project.id, request);
      createCandidates(project.id, {...request, hash: preview.hash, requestId: model.id(), confirmed: true});
    }
    for (const name of ['video-a', 'video-b']) {
      const seed = seedVideo(name); videos.push({...seed, job: queueVideo(seed)});
    }
    await wait(() => images.every(item => started('image', item.asset.name)) && started('video', videos[0].project.id),
      'images and video did not run while the text lane was occupied');
    assert.equal(jobStatus(videos[1].job), 'queued');
    assert.equal(started('video', videos[1].project.id), false);
    assert.equal(store.nextJob(['video'], [], 1), undefined, 'atomic claims must respect an already occupied lane');
    await assert.rejects(runQueuedVideoConcurrently(videos[1].project.id, videos[1].job.id), /并发已满/);
    directImage = runFileAdapter(adapter, {task: 'asset-image', projectId: textProject.id, asset: {name: 'image-direct'}}, '.png')
      .then(output => ({ok: true, output}), error => ({ok: false, error}));
    await sleep(100); assert.equal(started('image', 'image-direct'), false, 'direct image calls must share the image limit');
    release('image', images[0].asset.name);
    await wait(() => started('image', 'image-direct'), 'direct image request did not receive a released slot');
    release('image', images[1].asset.name); release('image', 'image-direct'); release('video', videos[0].project.id);
    const directResult = await directImage; assert.equal(directResult.ok, true); assert.ok(existsSync(directResult.output));
    await wait(() => jobStatus(videos[0].job) === 'completed' && started('video', videos[1].project.id), 'video slot did not drain');
    release('video', videos[1].project.id);
    await wait(async () => {
      await tickCandidates();
      return jobStatus(videos[1].job) === 'completed' && images.every(item => store.jobsFor(item.project.id).some(job => job.kind === 'image' && job.status === 'completed'));
    }, 'media tasks did not complete');
    release('text', keys[0]); await wait(() => started('text', keys[2]), 'third text request did not acquire the released slot');
    assert.equal(started('text', keys[3]), false);
    release('text', keys[1]); await wait(() => started('text', keys[3]), 'fourth text request did not start in FIFO order');
    release('text', keys[3]); await wait(() => started('text', keys[4]), 'a failed text request did not release its slot');
    release('text', keys[2]); release('text', keys[4]);
    const results = await Promise.all(pending);
    assert.deepEqual(results.map(result => result.ok), [true, true, true, false, true]);
    const failed = store.db.prepare("SELECT status FROM adapter_tasks WHERE snapshot LIKE '%text-fail%'").get();
    assert.equal(failed.status, 'remote_unknown');
    await assert.rejects(runJsonAdapter(adapter, requests[3]), /上次相同模型请求的状态尚未确认/);
    const counts = {text: 0, image: 0, video: 0}, maxima = {...counts}; let allThree = false;
    for (const event of events()) {
      counts[event.kind] += event.event === 'start' ? 1 : -1;
      maxima[event.kind] = Math.max(maxima[event.kind], counts[event.kind]);
      if (Object.values(counts).every(count => count > 0)) allThree = true;
    }
    assert.deepEqual(maxima, {text: 2, image: 2, video: 1}); assert.deepEqual(counts, {text: 0, image: 0, video: 0});
    assert.equal(allThree, true);
    const textStarts = events().filter(event => event.kind === 'text' && event.event === 'start').map(event => event.key);
    assert.deepEqual([...textStarts.slice(0, 2)].sort(), keys.slice(0, 2));
    assert.deepEqual(textStarts.slice(2), keys.slice(2));

    const blocked = seedVideo('预算未结算项目'), unrelated = seedVideo('独立预算项目');
    videos.push(blocked, unrelated);
    const profilePath = path.join(root, 'budget.json'), ledgerPath = path.join(root, 'budget.sqlite');
    ledger = new DatabaseSync(ledgerPath); ledger.exec('CREATE TABLE calls(batch TEXT,kind TEXT,state TEXT)');
    ledger.prepare('INSERT INTO calls VALUES(?,?,?)').run('budget-fixture', 'text', 'submitted');
    writeFileSync(profilePath, JSON.stringify({scope: 'episodes3-8', state: 'active', projectId: blocked.project.id,
      batchId: 'budget-fixture', ledgerPath, requests: []}));
    process.env.MANJU_BATCH_BUDGET_PROFILE = profilePath;
    blocked.job = queueVideo(blocked); unrelated.job = queueVideo(unrelated);
    await wait(() => started('video', unrelated.project.id), 'an unrelated project was blocked by another project budget');
    assert.equal(jobStatus(blocked.job), 'queued'); assert.equal(started('video', blocked.project.id), false);
    release('video', unrelated.project.id); await wait(() => jobStatus(unrelated.job) === 'completed', 'unrelated video did not complete');
    ledger.exec("UPDATE calls SET state='completed'"); wake();
    await wait(() => started('video', blocked.project.id), 'settled budget did not unblock the original project');
    release('video', blocked.project.id); await wait(() => jobStatus(blocked.job) === 'completed', 'unblocked video did not complete');
    delete process.env.MANJU_BATCH_BUDGET_PROFILE;

    const recovered = ['queued', 'running'].map(status => {
      const id = model.id(); store.db.prepare('INSERT INTO adapter_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, textProject.id,
        'concurrency-fixture', id, '{}', status, path.join(root, id + '.json'), null, model.now(), model.now()); return id;
    });
    const beforeRecovery = events().length; recoverJobs(); await sleep(100);
    assert.deepEqual(recovered.map(id => store.db.prepare('SELECT status FROM adapter_tasks WHERE id=?').get(id).status), ['failed', 'remote_unknown']);
    assert.equal(events().length, beforeRecovery, 'restart must not resubmit an unknown or unsubmitted text request');
    Object.assign(process.env, {MANJU_IMAGE_CONCURRENCY: '166', MANJU_VIDEO_CONCURRENCY: '0', MANJU_TEXT_CONCURRENCY: '1.5'});
    assert.deepEqual(concurrencyLimits(), {image: 100, video: 100, text: 20});
    Object.assign(process.env, {MANJU_IMAGE_CONCURRENCY: '165', MANJU_VIDEO_CONCURRENCY: '100', MANJU_TEXT_CONCURRENCY: '20'});
    assert.deepEqual(concurrencyLimits(), {image: 165, video: 100, text: 20});
    Object.assign(process.env, {MANJU_IMAGE_CONCURRENCY: '166', MANJU_VIDEO_CONCURRENCY: '101', MANJU_TEXT_CONCURRENCY: '21'});
    assert.deepEqual(concurrencyLimits(), {image: 100, video: 100, text: 20});
    delete process.env.MANJU_IMAGE_CONCURRENCY; delete process.env.MANJU_VIDEO_CONCURRENCY; delete process.env.MANJU_TEXT_CONCURRENCY;
    assert.deepEqual(concurrencyLimits(), {image: 100, video: 100, text: 20});
  } finally {
    delete process.env.MANJU_BATCH_BUDGET_PROFILE;
    keys.forEach(key => release('text', key)); images.forEach(item => release('image', item.asset.name));
    release('image', 'image-direct');
    videos.forEach(item => release('video', item.project.id));
    await Promise.allSettled([...pending, directImage].filter(Boolean)); ledger?.close();
  }
});
