import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../dist-server/shared/model.js';
import { applyAction } from '../dist-server/server/actions.js';
import { suggestEffects } from '../dist-server/server/effects.js';

test('锁定剧本时只根据明确正式事件自动适配特效，并允许撤销', () => {
  assert.equal(suggestEffects('这里没有雷电，也禁止系统面板出现。').length, 0);
  const project = makeProject('特效测试', 'douyin-story');
  applyAction(project, { type: 'episode.addMany', count: 1 });
  const ep = project.episodes[0];
  applyAction(project, { type: 'episode.update', episodeId: ep.id,
    sourceText: '第一章 雷雨。林舟见到雷电缠绕山门，随后系统面板出现，提示前路危险。同伴抓住林舟袖口，林舟停住并转头确认她的安危。'.repeat(2) });
  applyAction(project, { type: 'episode.confirmSource', episodeId: ep.id });
  applyAction(project, { type: 'episode.update', episodeId: ep.id,
    highlightReport: '原文第一章：雷电缠绕山门，系统面板提示危险，同伴抓住袖口，林舟停住并确认安危。' });
  applyAction(project, { type: 'episode.confirmHighlight', episodeId: ep.id });
  applyAction(project, { type: 'beat.add', episodeId: ep.id });
  const beat = ep.scriptBeats[0];
  applyAction(project, { type: 'beat.update', episodeId: ep.id, beatId: beat.id,
    sourceQuote: '雷电缠绕山门，随后系统面板出现',
    event: '雷电缠绕山门，系统面板出现并提示危险', reaction: '林舟停住，转头确认同伴安危' });
  applyAction(project, { type: 'script.lock', episodeId: ep.id });
  const segment = ep.segments[0];
  assert.ok(segment.effectIds.includes('energy-arc'));
  assert.ok(segment.effectIds.includes('info-panel-system'));
  assert.equal(segment.effectEvidence['energy-arc'], beat.event);
  applyAction(project, { type: 'segment.effects', episodeId: ep.id, segmentId: segment.id, entries: [] });
  assert.deepEqual(segment.effectIds, []);
});
