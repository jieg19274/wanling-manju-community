import { digest } from './model.js';
import type {IndexedEvent} from './story-index.js';
import { productionRules, type ProductionRules } from './production-rules.js';

export interface SourceRange { start: number; end: number; chapters: string[]; charCount: number }
export interface EpisodePlan { sourceHash: string; chaptersPerEpisode: number; hasHeadings: boolean;
  method?: 'chapters' | 'story'; ranges: SourceRange[] }

export interface StoryPlanProgress { fingerprint: string; totalBatches: number; completedBatches: number;
  status: 'running' | 'failed' | 'completed'; error?: string; updatedAt: string;
  results: { start: number; end: number; boundaries: number[]; summary?: string;events?:IndexedEvent[] }[] }

export interface StoryBatch { start: number; end: number; chapters: { start: number; end: number; title: string }[] }

function headingKey(title: string): string {
  const match = /^第([〇零一二两三四五六七八九十百千万0-9０-９]+)([章节回卷集])(.*)$/u.exec(title);
  if (!match) return title;
  const digits: Record<string, number> = {〇:0, 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9};
  const units: Record<string, number> = {十:10, 百:100, 千:1000, 万:10000};
  const value = match[1].replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 0xff10));
  let number = 0;
  if (/^[0-9]+$/u.test(value)) number = Number(value);
  else if (/^[〇零一二两三四五六七八九]+$/u.test(value)) number = Number([...value].map(c => digits[c]).join(''));
  else {
    let total = 0, section = 0, digit = 0;
    for (const c of value) {
      if (c in digits) digit = digits[c];
      else if (units[c] === 10000) { total += (section + digit || 1) * 10000; section = digit = 0; }
      else { section += (digit || 1) * units[c]; digit = 0; }
    }
    number = total + section + digit;
  }
  return `${number}${match[2]}:${match[3].trim()}`;
}

export function sourceChapters(source: string): StoryBatch['chapters'] {
  const heading = /^[ \t]*(第[〇零一二两三四五六七八九十百千万0-9０-９]+[章节回卷集](?:[^\r\n]{0,80})|Chapter\s+\d+(?:[^\r\n]{0,80}))\s*$/gimu;
  const matches = [...source.matchAll(heading)].filter((match, index, all) => {
    const previous = all[index - 1];
    return !previous || headingKey(previous[1].trim()) !== headingKey(match[1].trim()) ||
      source.slice(previous.index! + previous[0].length, match.index!).trim().length > 0;
  });
  const starts = matches.length ? [0, ...matches.slice(1).map(match => match.index!)] : [0];
  const titles = matches.length ? matches.map(match => match[1].trim()) : ['未识别到章节标题'];
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? source.length,
    title: titles[index] || `第 ${index + 1} 章` }));
}

export function storyBatches(source: string, chaptersPerBatch = 5, maxChars = 20_000): StoryBatch[] {
  if (maxChars < 100 || !Number.isInteger(chaptersPerBatch) || chaptersPerBatch < 1) throw new Error('批次参数无效');
  const chapters = sourceChapters(source).flatMap(chapter => {
    const chunks: typeof chapter[] = [];
    for (let start = chapter.start; start < chapter.end;) {
      let end = Math.min(start + maxChars, chapter.end);
      if (end < chapter.end) {
        const newline = source.lastIndexOf('\n', end - 1);
        if (newline > start + maxChars / 2) end = newline + 1;
        else if (/[\uD800-\uDBFF]/u.test(source[end - 1])) end--;
      }
      chunks.push({ start, end, title: chapter.title }); start = end;
    }
    return chunks;
  });
  const batches: StoryBatch[] = [];
  for (let index = 0; index < chapters.length;) {
    const first = chapters[index];
    let endIndex = index + 1;
    while (endIndex < chapters.length && endIndex - index < chaptersPerBatch &&
      chapters[endIndex].end - first.start <= maxChars) endIndex++;
    const group = chapters.slice(index, endIndex);
    batches.push({ start: first.start, end: group.at(-1)!.end, chapters: group });
    index = endIndex;
  }
  return batches;
}

export function paragraphBoundaries(source: string): number[] {
  return [0, ...[...source.matchAll(/\n(?=\S)/gu)].map(match => match.index + 1), source.length];
}

export function planEpisodes(source: string, chaptersPerEpisode: number): EpisodePlan {
  if (!Number.isInteger(chaptersPerEpisode) || chaptersPerEpisode < 1 || chaptersPerEpisode > 10)
    throw new Error('每集章节数须为 1–10');
  if (source.trim().length < 50) throw new Error('请先保存完整原文（至少 50 字）');
  // Each boundary is a chapter heading at the start of a line. All source bytes remain in exactly one range.
  const chapters = sourceChapters(source);
  const ranges: SourceRange[] = [];
  for (let index = 0; index < chapters.length; index += chaptersPerEpisode) {
    const group = chapters.slice(index, index + chaptersPerEpisode);
    const start = group[0].start, end = group.at(-1)!.end;
    ranges.push({ start, end, chapters: group.map(item => item.title), charCount: end - start });
  }
  if (ranges.length > 200) throw new Error('单次最多生成 200 集，请分项目导入原文');
  return { sourceHash: digest(source), chaptersPerEpisode,
    hasHeadings: chapters[0].title !== '未识别到章节标题', ranges };
}

// Agents choose story boundaries after reading the complete source. No heuristic
// here claims to understand the story; this validates coverage and chapter limits.
export function planChapterGroups(source: string, ends: unknown, rules?: ProductionRules): EpisodePlan {
  if (source.trim().length < 50) throw Error('请先保存完整原文');
  const chapters = sourceChapters(source), policy = productionRules(rules);
  if (chapters[0].title === '未识别到章节标题') throw Error('未识别章节标题，须先核对章节边界');
  if (!Array.isArray(ends) || !ends.length || ends.length > 200 || ends.at(-1) !== chapters.length)
    throw Error('分集须连续覆盖全部章节，最多200集');
  let cursor = 0;
  const ranges = ends.map((end, index) => {
    if (!Number.isInteger(end) || end <= cursor || end > chapters.length) throw Error('章节结束序号须严格递增');
    const count = end - cursor;
    if (count > policy.maxChapters || (count < policy.minChapters && index !== ends.length - 1))
      throw Error(`每集须取${policy.minChapters}–${policy.maxChapters}章；仅末集允许不足最小章数`);
    const group = chapters.slice(cursor, end); cursor = end;
    return { start: group[0].start, end: group.at(-1)!.end, chapters: group.map(c => c.title),
      charCount: group.at(-1)!.end - group[0].start };
  });
  return { sourceHash: digest(source), chaptersPerEpisode: 0, hasHeadings: true, method: 'story', ranges };
}
