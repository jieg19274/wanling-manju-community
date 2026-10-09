import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../shared/model.js';

type RawEffect = { id: string; name: string; category: string; prompt: string; notes?: string; usage?: string;
  status?: string; authorship?: string; parameters?: Record<string, string> };
type Catalog = { effects: RawEffect[]; version?: string; schema_version?: string };
type Adaptation = { id: string; visual_details: string; visual_scope?: string; aliases?: string[] };

const bundled = path.resolve(import.meta.dirname, '..', 'bundled', 'catalog');
const hasBundledCatalog = ['effect-library-source.json', 'effect-library-frame-local.json', 'effect-library-adaptations.json']
  .some(name => existsSync(path.join(bundled, name)));
const root = hasBundledCatalog ? bundled : path.resolve(process.cwd(), 'catalog');
const read = <T>(name: string): T => JSON.parse(readFileSync(path.join(root, name), 'utf8')) as T;
const source = read<Catalog>('effect-library-source.json');
const local = read<Catalog>('effect-library-frame-local.json');
const adapted = read<{ version: string; effects: Adaptation[] }>('effect-library-adaptations.json');
const adaptations = new Map(adapted.effects.map(item => [item.id, item]));
const all = [...source.effects, ...local.effects];
const byId = new Map(all.map(effect => [effect.id, effect]));
export const catalogVersion = digest({ source: source.schema_version, local: local.version, adapted, all });

export function listEffects(query = '') {
  const term = query.trim().toLocaleLowerCase();
  return all.filter(effect => !term || `${effect.name} ${effect.category} ${effect.usage || ''} ${effect.notes || ''}`.toLocaleLowerCase().includes(term))
    .map(effect => ({ id: effect.id, name: effect.name, category: effect.category,
      usage: effect.usage, status: effect.status, localAdaptation: adaptations.has(effect.id),
      prompt: effect.prompt, notes: effect.notes, authorship: effect.authorship,
      visualScope: adaptations.get(effect.id)?.visual_scope,
      conditions: effectConditions(effect.id), visualDescription: adaptations.get(effect.id)?.visual_details }));
}

export function getEffect(id: string): RawEffect {
  const effect = byId.get(id);
  if (!effect) throw new Error('特效条目不存在');
  return effect;
}

export function effectVersion(id: string): string {
  return digest({ effect: getEffect(id), adaptation: adaptations.get(id) });
}

export function visualDescription(id: string): string {
  const details = adaptations.get(id)?.visual_details;
  if (!details) throw new Error('该条目仅供创作参考，尚无经核对的正式分镜适配描述');
  return details;
}

export function effectSummary() {
  return { version: catalogVersion, total: all.length, locallyAdapted: adaptations.size,
    source: source.effects.length, local: local.effects.length };
}

export function effectConditions(id: string) {
  const conditions = ['仅表现正式事件/反应中已发生的动作；意图、假设、否定和取消不触发', '数量、材质、颜色、接触部位、伤势和胜负沿用正式原句'];
  if (/^restraint-chain-/u.test(id)) conditions.push('正式依据必须明确为锁链；藤蔓、绳索或泛称禁锢不可套用链节');
  if (/(?:impact|contact|hit|clash|collision|block)/u.test(id)) conditions.push('接触效果仅用于正式已发生的接触，闪避/落空不产生命中冲击');
  return conditions;
}
const sentences = (text: string) => text.match(/[^。！？\n]+[。！？]?/gu)?.map(line => line.trim()).filter(Boolean) || [];
const materials:Record<string,RegExp>={
  'fire-orb':/火球|炎爆|火焰弹|(?:火焰|燃烧|炽热)[^。！？]{0,6}(?:球|弹)/u,
  'fire-trail':/火焰|尾焰|焰尾|火舌/u,'energy-arc':/电弧|雷电|闪电|雷光|电光|雷霆/u,
  'ice-grow':/冰|霜/u,'portal':/传送门|空间门|光门|空间裂隙/u,'hologram':/全息|投影|光屏/u,
};
function notPerformed(context: string) {
  return /(?:只是|仅仅)?(?:想着|想要|想象|幻想|打算|计划|准备|试图|企图|本想|欲要|将要|即将|如果|假如|若是|一旦|也许|可能会|回想|回忆|忆起)|(?:没有|没|并未|未曾|不曾|不再|未能|尚未|还没|不能|不会)(?:真正|实际|成功|再次)?(?:施法|施展|释放|放出|施放|召唤|射出|形成|出现|发射|凝聚|命中|击中)|(?:将会?|欲|拟)(?:施法|施展|释放|放出|施放|召唤|射出|形成|出现|发射|凝聚|命中|击中)|(?:并无|不存在|未出现|没有)(?:火球|电光|雷电|锁链|冲击波|法阵|光门)|(?:禁止|不得|取消|放弃|中止|停止施法|未施法|没有施法)/u.test(context);
}
export function checkedEffectEvidence(id: string, evidence: string, formalText: string): string {
  visualDescription(id);
  if (!evidence?.trim() || !formalText.includes(evidence)) throw Error('特效依据必须逐字来自正式事件或人物反应');
  // Inspect the surrounding sentence even if the caller supplies only a keyword.
  const contexts = sentences(formalText).filter(line => line.includes(evidence));
  const candidates = contexts.length ? contexts : [evidence];
  const context = candidates.find(line => !notPerformed(line) && (!/^restraint-chain-/u.test(id) || /锁链|链条/u.test(line)));
  if (!context) throw Error('该特效没有已发生动作的完整依据，或正式束缚材质不是锁链；请核对正式剧情');
  if(materials[id]&&!materials[id].test(context))throw Error('特效材质或对象与正式逐字依据不符，不能由模板添加');
  if (id==='fire-orb' && /火球(?:杖|秘籍|图案|画像|符号|二字|这个词)/u.test(context)) throw Error('正式原句仅提及火球名称或图案，没有火球动作');
  if (/(?:impact|contact|hit)/u.test(id) && /未命中|没有命中|没击中|扑空|落空|躲过|闪避成功/u.test(context)) throw Error('正式动作未命中，不能绑定命中冲击特效');
  return context;
}
export function suggestEffects(actionText: string) {
  const text = actionText.trim();
  if (!text) return [];
  return adapted.effects.flatMap(item => {
    const effect = byId.get(item.id);
    if (!effect) return [];
    const terms = [effect.name, ...(item.aliases || [])].filter(term => term.length >= 2 && !/[.*+?^${}()|[\]\\]/u.test(term));
    for (const sentence of sentences(text)) if (terms.some(term => sentence.includes(term))) {
      try { return [{ id: item.id, name: effect.name, evidence: checkedEffectEvidence(item.id,sentence,text) }]; }
      catch { /* Ambiguous mentions remain unbound. */ }
    }
    return [];
  }).slice(0, 20);
}
