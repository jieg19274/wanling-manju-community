export type ProviderPrice = {
  model: string; description: string; quotaType: number; modelPrice: number; modelRatio: number;
  completionRatio: number; expression?: string; groups: {name: string; ratio: number}[];
};
export type ProviderBilling = {
  fetchedAt: string; pricingVersion?: string; currency: string; quotaPerUnit?: number;
  conversion?: number; quota?: {available: number; used: number; unlimited: boolean; expiresAt: number};
  quotaError?: string; pricingError?: string; credentialError?: string;
  accountBalanceAvailable: boolean;
  accountBalanceUpdatedAt?: string;
  accountBalanceStale?: boolean;
  account?: {connected:boolean;name:string;pending:boolean};
  accountBalance?: {available: number; currency: string; source: 'user' | 'billing' | 'wallet'; matchesModelKey?:boolean};
  accountBalanceError?: string; group?: string; prices: ProviderPrice[];
};
type Range = {minimum: number; maximum: number};
type Quote = Range & {
  known: boolean; currency: string; description: string; pricingVersion: string; model: string;
  input?: Range; output?: Range;
};
function amount(value: number) {
  const formatted = value.toLocaleString('zh-CN', {maximumFractionDigits: 4});
  return value > 0 && Number(formatted.replace(/,/g, '')) === 0 ? value.toPrecision(3) : formatted;
}
export function priceRange(range: Range) {
  return range.minimum === range.maximum ? amount(range.minimum) : `${amount(range.minimum)}–${amount(range.maximum)}`;
}
function requestUnit(price: ProviderPrice, seconds: number) {
  if (!price.expression) return price.modelPrice;
  // Parse only numeric per-request/per-second pricing; never execute remote code.
  const expression = price.expression.replace(/^tier\("[^"\n]{1,80}",\s*(.*)\)$/u, '$1');
  const match = /^(?:(u\("seconds"\))\s*\*\s*)?(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?$/u.exec(expression);
  if (!match) return undefined;
  const divisor = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isFinite(divisor) || divisor <= 0) return undefined;
  return Number(match[2]) / divisor * (match[1] ? seconds : 1);
}
export function billingQuote(billing: ProviderBilling | undefined, model: string, count = 1, seconds = 30): Quote {
  const result: Quote = {known: false, currency: billing?.currency || '服务额度', minimum: 0, maximum: 0,
    description: '暂无价格', pricingVersion: billing?.pricingVersion || '', model};
  const price = billing?.prices.find(p => p.model === model);
  if (!billing?.conversion || !billing.quotaPerUnit || !price?.groups.length) return result;
  const matchingGroup = billing.group && price.groups.find(g => g.name === billing.group);
  const ratios = (matchingGroup ? [matchingGroup] : price.groups).map(g => g.ratio);
  if (!ratios.every(r => Number.isFinite(r) && r > 0)) return result;
  const range = (unit: number, factor = 1): Range => ({minimum: unit * billing.conversion! * Math.min(...ratios) * factor,
    maximum: unit * billing.conversion! * Math.max(...ratios) * factor});
  if (price.quotaType === 0) {
    if (!Number.isFinite(price.modelRatio) || price.modelRatio < 0 || !Number.isFinite(price.completionRatio) || price.completionRatio < 0) return result;
    const input = range(price.modelRatio * 1e6 / billing.quotaPerUnit), output = range(price.modelRatio * price.completionRatio * 1e6 / billing.quotaPerUnit);
    return {...result, input, output, description: `输入 ${priceRange(input)} ${billing.currency}/百万 Token；输出 ${priceRange(output)} ${billing.currency}/百万 Token。实际 Token 数未知。`};
  }
  if (price.quotaType !== 1 && price.quotaType !== 2) return result;
  const unit = requestUnit(price, seconds);
  if (unit === undefined || !Number.isFinite(unit) || unit < 0 || !Number.isFinite(count) || count < 0) return result;
  const estimate = range(unit, count);
  return {...result, ...estimate, known: true, description: `${priceRange(estimate)} ${billing.currency}`};
}
export function modelPriceLabel(billing: ProviderBilling | undefined, model: string, kind: 'text' | 'image' | 'video') {
  const price = billing?.prices.find(p => p.model === model);
  const perSecond = Boolean(price?.expression && /u\("seconds"\)/u.test(price.expression));
  const quote = billingQuote(billing, model, 1, perSecond ? 1 : 30);
  if (quote.input && quote.output) return `输入 ${priceRange(quote.input)} ${quote.currency} / 百万 Token · 输出 ${priceRange(quote.output)} ${quote.currency} / 百万 Token`;
  if (!quote.known) return '暂无价格';
  return `${priceRange(quote)} ${quote.currency} / ${perSecond ? '秒' : kind === 'image' ? '张' : kind === 'video' ? '段' : '次'}`;
}
