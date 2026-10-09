import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceChapters, planEpisodes } from '../dist-server/shared/episode-plan.js';

test('adjacent Arabic and Chinese duplicate heading remains in its source chapter', () => {
  const source = '第99章 学堂\r\n\r\n第九十九章 学堂\r\n\r\n' + '这是完整的学堂正文。'.repeat(8) + '\r\n第100章 草庐对策\r\n' + '这是下一章完整正文。'.repeat(8);
  const chapters = sourceChapters(source);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第99章 学堂');
  assert.ok(source.slice(chapters[0].start, chapters[0].end).includes('第九十九章 学堂'));
  const plan = planEpisodes(source, 1);
  assert.equal(plan.ranges.length, 2);
  assert.equal(plan.ranges.map(r => source.slice(r.start, r.end)).join(''), source);
});

test('same title with another number, or a repeated heading after prose, stays a chapter', () => {
  const source = '第1章 学堂\n第2章 学堂\n正文\n第2章 学堂\n更多正文';
  assert.equal(sourceChapters(source).length, 3);
});
