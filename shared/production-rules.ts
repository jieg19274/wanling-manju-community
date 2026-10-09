export interface ProductionRules {
  segmentDurationSec: 30;
  minChapters: number;
  maxChapters: number;
  chapterStrategy: 'story' | 'fixed';
  fixedChapters: number;
  delivery: 'package' | 'video';
}

export const DEFAULT_PRODUCTION_RULES: ProductionRules = {
  segmentDurationSec: 30, minChapters: 1, maxChapters: 3,
  chapterStrategy: 'story', fixedChapters: 3, delivery: 'package',
};

export function productionRules(value?: Partial<ProductionRules>): ProductionRules {
  const result = { ...DEFAULT_PRODUCTION_RULES, ...value };
  if (result.segmentDurationSec !== 30) throw Error('每个生成片段固定30秒');
  if (![result.minChapters, result.maxChapters, result.fixedChapters].every(n => Number.isInteger(n) && n >= 1 && n <= 10) ||
      result.minChapters > result.maxChapters || result.fixedChapters < result.minChapters || result.fixedChapters > result.maxChapters)
    throw Error('章节范围须为1–10的整数，固定章数须位于该范围内');
  if (!['story', 'fixed'].includes(result.chapterStrategy) || !['package', 'video'].includes(result.delivery))
    throw Error('制作规则无效');
  return result;
}
