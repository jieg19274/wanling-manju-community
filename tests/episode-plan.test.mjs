import test from 'node:test';
import assert from 'node:assert/strict';
import { planEpisodes } from '../dist-server/shared/episode-plan.js';
import { makeProject } from '../dist-server/shared/model.js';
import { applyAction } from '../dist-server/server/actions.js';

test('explicit numbered episode script headings preserve each episode and the full preamble',()=>{
  const original='全季：第一人称POV，9:16，对白OS保留\n'+Array.from({length:8},(_,i)=>`第${i+1}集【故事${i+1}】\n【0—30秒】\n动作与对白${i+1}\n【30—60秒】\n反应\n【60—90秒】\n结果\n`).join('');
  const plan=planEpisodes(original,1);assert.equal(plan.ranges.length,8);assert.equal(plan.ranges.map(r=>original.slice(r.start,r.end)).join(''),original);assert.equal(plan.hasHeadings,true);
});

const source = '总序：人物关系与背景。\n第一章 山门\n' + '甲'.repeat(60) + '\n第二章 雨夜\n' + '乙'.repeat(65) + '\n第三章 追问\n' + '丙'.repeat(70);

test('常规漫剧章节分集完整覆盖全文，分集原文保持可追溯', () => {
  const plan = planEpisodes(source, 2);
  assert.equal(plan.ranges.length, 2);
  assert.equal(plan.ranges.map(range => source.slice(range.start, range.end)).join(''), source);
  assert.equal(plan.ranges[0].chapters.length, 2);
  const project = makeProject('自动分集', 'standard');
  applyAction(project, { type: 'project.source', sourceText: source });
  applyAction(project, { type: 'project.plan', chaptersPerEpisode: 2 });
  applyAction(project, { type: 'project.createEpisodes' });
  assert.equal(project.episodes.length, 2);
  assert.equal(project.episodes.map(ep => ep.sourceText).join(''), source);
  assert.equal(project.episodes[0].sourceReviewedHash, undefined);
  assert.throws(() => applyAction(project, { type: 'episode.update', episodeId: project.episodes[0].id, sourceText: '改写' }), /绑定/);
});

test('无章节标题只建议一集，推文漫剧按填写集数创建', () => {
  assert.equal(planEpisodes('没有章节标题的完整原文。'.repeat(10), 1).ranges.length, 1);
  const project = makeProject('推文', 'douyin-story');
  applyAction(project, { type: 'episode.addMany', count: 3 });
  assert.deepEqual(project.episodes.map(ep => ep.number), [1, 2, 3]);
  assert.throws(() => applyAction(project, { type: 'episode.addMany', count: 101 }), /1–100/);
});

test('分集与项目可从回收区恢复；文本、图片、视频模型分别保存', () => {
  const project = makeProject('管理测试', 'douyin-story');
  for (const kind of ['text', 'image', 'video'])
    applyAction(project, { type: 'project.model', kind, name: `${kind}模型`, modelId: `${kind}.v1` });
  assert.equal(project.textModel.modelId, 'text.v1');
  assert.equal(project.imageModel.modelId, 'image.v1');
  assert.equal(project.videoModel.modelId, 'video.v1');
  applyAction(project, { type: 'episode.addMany', count: 2 });
  const first = project.episodes[0];
  applyAction(project, { type: 'episode.archive', episodeId: first.id });
  assert.deepEqual(project.episodes.map(ep => ep.number), [2]);
  assert.equal(project.archivedEpisodes[0].id, first.id);
  applyAction(project, { type: 'episode.restore', episodeId: first.id });
  assert.deepEqual(project.episodes.map(ep => ep.number), [1, 2]);
  applyAction(project, { type: 'project.archive' });
  assert.throws(() => applyAction(project, { type: 'episode.addMany', count: 1 }), /回收区/);
  applyAction(project, { type: 'project.restore' });
  assert.equal(project.archivedAt, undefined);
});
