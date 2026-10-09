import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, makeEpisode, makeBeat, lockScript, sourceHash, highlightHash,
  segmentReferences, validateSubshots, composePrompt, anchorSvg, sampleGateHash,
  suggestedSegmentDuration, knownVideoCapabilities } from '../dist-server/shared/model.js';
import { spokenWindowIssues } from '../dist-server/shared/model.js';
import { applyAction } from '../dist-server/server/actions.js';
import { approvalHash, auditEpisode, pacingWarnings } from '../dist-server/shared/model.js';

function episode(number, events) {
  const result = makeEpisode(number, `EP${number}`);
  result.sourceText = '原文'.repeat(40);
  result.sourceReviewedHash = sourceHash(result);
  result.highlightReport = '因果、目的、人物反应、后续影响均已核对';
  result.highlightReviewedHash = highlightHash(result);
  result.scriptBeats = events.map(event => ({ ...makeBeat(), event, reaction: '林舟停住，确认同伴安全。',
    dialogue: ['林舟：等一下。'], os: ['林舟：她还在身后。'],
    floatLabels: ['雨夜'], systemPanels: ['危险靠近'] }));
  lockScript(result);
  return result;
}

test('剧情状态跨集延续，回忆可指定历史状态，错图会阻断', () => {
  const project = makeProject('连续性', 'standard');
  const first = episode(1, ['林舟穿上深青衣']), second = episode(2, ['林舟走入雨中', '林舟衣服被雨淋湿']);
  project.episodes = [first, second];
  const character = { id: 'character', kind: 'character', name: '林舟', identity: '黑发青年', voice: '沉稳男声',
    states: [
      { id: 'dry', label: '深青衣', appearance: '干燥深青衣', trigger: '穿上深青衣', startEpisode: 1, startSegment: 1 },
      { id: 'wet', label: '雨夜湿衣', appearance: '衣袖被雨淋湿', trigger: '衣服被雨淋湿', startEpisode: 2, startSegment: 2 },
    ], images: [
      { id: 'dry-image', stateId: 'dry', mediaPath: 'dry.png', source: 'upload', createdAt: '' },
      { id: 'wet-image', stateId: 'wet', mediaPath: 'wet.png', source: 'upload', createdAt: '' },
    ] };
  project.assets = [character];
  for (const ep of project.episodes) for (const segment of ep.segments)
    segment.assetBindings = [{ assetId: character.id }];
  assert.equal(segmentReferences(project, first, first.segments[0])[0].stateLabel, '深青衣');
  assert.equal(segmentReferences(project, second, second.segments[0])[0].stateLabel, '深青衣');
  assert.equal(segmentReferences(project, second, second.segments[1])[0].stateLabel, '雨夜湿衣');
  second.segments[1].assetBindings = [{ assetId: character.id, stateId: 'dry' }];
  assert.equal(segmentReferences(project, second, second.segments[1])[0].stateLabel, '深青衣');
  second.segments[1].assetBindings = [{ assetId: character.id, stateId: 'dry', imageId: 'wet-image' }];
  assert.throws(() => segmentReferences(project, second, second.segments[1]), /参考图与剧情状态不一致/);
});

test('多子镜逐条承载正式声音与可见信息，漏分配会阻断核对', () => {
  const ep = episode(1, ['林舟看向门，门缝透出红光，他向门前迈步，伸手握住门把手，轻轻推开门。']), segment = ep.segments[0], beat = ep.scriptBeats[0];
  assert.deepEqual(validateSubshots(beat, segment), []);
  assert.equal(segment.subshots.length, 7);
  assert.ok(segment.subshots.every(shot => shot.endSec - shot.startSec <= 6));
  assert.match(composePrompt(ep, segment), /林舟：等一下/);
  assert.match(composePrompt(ep, segment), /【声音生成合同】.*内心OS.*必须.*发声/u);
  assert.match(composePrompt(ep, segment), /【内心OS】林舟：她还在身后。/u);
  assert.match(composePrompt(ep, segment), /对白和内心OS不生成画面字幕/);
  assert.match(composePrompt(ep, segment), /禁止第三方解说、旁白/);
  assert.doesNotMatch(anchorSvg(segment), /<text\b/);
  const serpentBoard = anchorSvg(segment, true, 2);
  assert.match(serpentBoard, /#639388/);
  assert.doesNotMatch(serpentBoard, /<text\b/);
  segment.subshots[0].lineRefs.os = [];
  assert.match(validateSubshots(beat, segment).join('；'), /os 未逐条分配/);
});

test('剧情太薄时不能把30秒填成空镜或重复动作', () => {
  const ep = episode(1, ['林舟看向门']), segment = ep.segments[0];
  assert.match(validateSubshots(ep.scriptBeats[0], segment).join('；'), /只有占位动作/);
});

test('默认片段按30秒组织，短模型不能用估计时长绕过锁稿门禁', () => {
  const beat = { ...makeBeat(), event: '林舟开门，走进屋内。', reaction: '林舟警觉。',
    dialogue: ['林舟：等一下。'], os: [], floatLabels: [], systemPanels: [] };
  assert.equal(suggestedSegmentDuration(beat, 30), 30);
  assert.equal(suggestedSegmentDuration(beat, 8), 8);
  beat.os = ['林舟：' + '门后的声音越来越近。'.repeat(8)];
  assert.equal(suggestedSegmentDuration(beat, 30), 30);
});

test('固定 30 秒模型记录精确时长约束，不以最长时长代替', () => {
  assert.equal(knownVideoCapabilities('全能sd2.5(满血内置过脸30图超分1080P)').fixedDurationSec, 30);
});

test('每句对白和内心OS按下一句开始时间验算，不允许末镜赶词', () => {
  const beat = { ...makeBeat(), dialogue: [], os: ['甲：一二三四五六七八九十', '乙：一二三四五六七八九十'],
    floatLabels: [], systemPanels: [] };
  const shots = [{ startSec: 0, lineRefs: { dialogue: [], os: [0] } },
    { startSec: 18, lineRefs: { dialogue: [], os: [1] } }];
  assert.match(spokenWindowIssues(beat, shots, 20).join('；'), /下一句开始前只有 2.0 秒/);
  shots[1].startSec = 15;
  assert.deepEqual(spokenWindowIssues(beat, shots, 20), []);
});

test('模型时长装不下正式声音时在锁稿前阻断', () => {
  const project = makeProject('短视频模型', 'standard');
  project.videoModel = { name: '短模型', modelId: 'short', adapterPath: 'short.mjs',
    capabilities: { maxDurationSec: 8 } };
  const ep = makeEpisode(1, '第一集');
  ep.sourceText = '原文'.repeat(40);
  ep.sourceReviewedHash = sourceHash(ep);
  ep.highlightReport = '事件起因、人物目的、反应和结果';
  ep.highlightReviewedHash = highlightHash(ep);
  ep.scriptBeats = [{ ...makeBeat(), sourceQuote: '原文原文原文', event: '林舟打开门。', reaction: '林舟听见脚步后警觉。',
    dialogue: ['林舟：' + '门后的声音越来越近。'.repeat(8)], os: [], floatLabels: [], systemPanels: [] }];
  project.episodes = [ep];
  assert.throws(() => applyAction(project, { type: 'script.lock', episodeId: ep.id }), /固定30秒/);
});

test('新剧本节点没有原文依据不能锁稿', () => {
  const project = makeProject('原文依据', 'standard'), ep = makeEpisode(1, '第一集');
  ep.sourceText = '原文原文原文'.repeat(12);
  ep.sourceReviewedHash = sourceHash(ep);
  ep.highlightReport = '完整因果与人物反应';
  ep.highlightReviewedHash = highlightHash(ep);
  ep.scriptBeats = [{ ...makeBeat(), event: '林舟入门。', reaction: '林舟惊讶。' }];
  project.episodes = [ep];
  assert.throws(() => applyAction(project, { type: 'script.lock', episodeId: ep.id }), /逐字依据/);
});

test('30 秒片段拒绝两个 15 秒长镜头', () => {
  const ep = episode(1, ['林舟转身']), segment = ep.segments[0];
  segment.durationSec = 30;
  segment.subshots = segment.subshots.slice(0, 2);
  segment.subshots[0].endSec = 15;
  segment.subshots[1].startSec = 15;
  segment.subshots[1].endSec = 30;
  assert.match(validateSubshots(ep.scriptBeats[0], segment).join('；'), /5–8 个子镜/);
  assert.match(validateSubshots(ep.scriptBeats[0], segment).join('；'), /超过 6 秒/);
});

test('片段改为 30 秒会重排默认子镜，手工编辑后不再覆盖', () => {
  const project = makeProject('节奏', 'standard');
  const ep = episode(1, ['白蟒睁眼，抬头看向溶洞，翻动身体晒太阳，察觉自己仍是蟒蛇。']);
  project.episodes = [ep];
  const segment = ep.segments[0];
  applyAction(project, { type: 'segment.update', episodeId: ep.id, segmentId: segment.id, durationSec: 30 });
  assert.equal(segment.subshots.length, 7);
  assert.equal(segment.subshots[0].endSec, 2);
  assert.equal(segment.subshots.at(-1).endSec, 30);
  assert.ok(segment.subshots.every(shot => shot.endSec - shot.startSec <= 5));
  assert.ok(segment.subshotsAuto);
  const first = segment.subshots[0];
  applyAction(project, { type: 'segment.subshot.update', episodeId: ep.id, segmentId: segment.id,
    subshotId: first.id, startSec: first.startSec, endSec: first.endSec,
    framing: first.framing, sceneAction: first.action, lineRefs: first.lineRefs });
  assert.throws(() => applyAction(project, { type: 'segment.update', episodeId: ep.id, segmentId: segment.id, durationSec: 15 }), /固定30秒/);
  assert.equal(segment.subshots.length, 7);
});

test('视频模型或分镜变化使试片放行失效', () => {
  const project = makeProject('试片', 'standard'), ep = episode(1, ['林舟转身']);
  project.episodes = [ep];
  const approved = sampleGateHash(project, ep);
  project.videoModel = { name: '另一模型', modelId: 'other', adapterPath: 'other.mjs' };
  assert.notEqual(sampleGateHash(project, ep), approved);
  const changed = sampleGateHash(project, ep);
  ep.segments[0].visualPlan = '改为近景';
  assert.notEqual(sampleGateHash(project, ep), changed);
});

test('固定时长模型在锁稿时规划片段，旧片段在审计阶段提示不兼容', () => {
  const project = makeProject('固定时长', 'standard');
  project.videoModel = { name: '全能', modelId: '全能sd2.5', adapterPath: 'video.mjs' };
  const ep = episode(1, ['林舟推开门，发现同伴倒在门边。']);
  ep.scriptLockedHash = undefined;
  ep.scriptBeats[0].sourceQuote = ep.sourceText.slice(0, 8);
  project.episodes = [ep];
  applyAction(project, { type: 'script.lock', episodeId: ep.id });
  assert.equal(ep.segments[0].durationSec, 30);
  ep.segments[0].durationSec = 15;
  assert.match(auditEpisode(ep, project).join('；'), /固定 30 秒/);
});

test('重复提取资产只补新状态，保留原有身份和参考图', () => {
  const project = makeProject('服饰变化', 'standard');
  const ep = episode(1, ['林舟穿上深青衣，走入雨中。', '林舟的衣袖被雨淋湿。']);
  project.episodes = [ep];
  const original = { id: 'role', kind: 'character', name: '林舟', identity: '黑发青年', voice: '沉稳男声',
    states: [], images: [{ id: 'photo', mediaPath: 'role.png', source: 'upload', createdAt: '' }] };
  project.assets = [original];
  ep.assetCandidate = { scriptHash: ep.scriptLockedHash, createdAt: '', entries: [
    { kind: 'character', name: '林舟', identity: '另一身份不应覆盖', evidence: '林舟穿上深青衣',
      state: { label: '深青衣', appearance: '深青衣完整', trigger: '林舟穿上深青衣', startSegment: 1 } },
    { kind: 'character', name: '林舟', identity: '另一身份不应覆盖', evidence: '林舟的衣袖被雨淋湿',
      state: { label: '雨夜湿衣', appearance: '衣袖被雨淋湿', trigger: '林舟的衣袖被雨淋湿', startSegment: 2 } },
  ] };
  applyAction(project, { type: 'episode.applyAssetCandidate', episodeId: ep.id });
  assert.equal(project.assets.length, 1);
  assert.equal(original.identity, '黑发青年');
  assert.equal(original.images[0].id, 'photo');
  assert.deepEqual(original.states.map(item => item.label), ['深青衣', '雨夜湿衣']);
});

test('锚点板可选，不改变五层放行签名；重复镜头给节奏提示', () => {
  const ep = episode(1, ['林舟推开门，发现同伴倒在门边。']);
  const segment = ep.segments[0], approved = approvalHash(ep);
  segment.artifacts.push({ id: 'board', kind: 'anchor', sourceHash: '', content: '<svg/>', createdAt: '' });
  segment.selected.anchor = 'board';
  assert.equal(approvalHash(ep), approved);
  assert.doesNotMatch(auditEpisode(ep).join('；'), /锚点板缺失/);
  segment.subshots[1].action = segment.subshots[0].action;
  assert.match(pacingWarnings(ep.scriptBeats[0], segment).join('；'), /动作重复/);
});
