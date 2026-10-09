import { defaultSubshots, digest, makeSegment, minimumSpokenDuration, type Episode, type ScriptBeat, type Segment } from './model.js';

export function storyUnits(episode: Episode) {
  return episode.scriptBeats.flatMap(beat => [
    { id: `${beat.id}:event`, beatId: beat.id, kind: 'event' as const, text: beat.event },
    ...orderedSpeech(beat).map(ref => ({ id: ref.id || `${beat.id}:${ref.kind}:${ref.index}`, beatId: beat.id, kind: ref.kind, text: beat[ref.kind][ref.index] })),
    ...(['floatLabels', 'systemPanels'] as const).flatMap(kind => beat[kind].map((text, index) =>
      ({ id: `${beat.id}:${kind}:${index}`, beatId: beat.id, kind, text }))),
    { id: `${beat.id}:reaction`, beatId: beat.id, kind: 'reaction' as const, text: beat.reaction },
  ]);
}

export function orderedSpeech(beat: ScriptBeat): {id?: string; kind: 'dialogue' | 'os'; index: number}[] {
  const expected = (['dialogue', 'os'] as const).flatMap(kind => beat[kind].map((_, index) => ({kind, index})));
  const refs = beat.speechOrder || expected;
  const keys = refs.map(ref => `${ref.kind}:${ref.index}`);
  if (keys.length !== expected.length || new Set(keys).size !== keys.length || expected.some(ref => !keys.includes(`${ref.kind}:${ref.index}`)))
    throw new Error('声音事件顺序须逐条覆盖全部对白和OS，不得遗漏或重复');
  return refs;
}

export function segmentBeat(episode: Episode, segment: Segment): ScriptBeat {
  const all = storyUnits(episode), ids = segment.storyUnitIds || [];
  const units = ids.map(id => { const unit = all.find(item => item.id === id); if (!unit) throw new Error('分段引用不存在的剧情单元'); return unit; });
  const counts = {dialogue: 0, os: 0};
  const speechOrder = units.filter(item => item.kind === 'dialogue' || item.kind === 'os').map(item => {
    const kind = item.kind as 'dialogue' | 'os';
    return {id: item.id, kind, index: counts[kind]++};
  });
  return { id: digest(ids), speechOrder, event: units.filter(item => item.kind === 'event').map(item => item.text).join('\n'),
    reaction: units.filter(item => item.kind === 'reaction').map(item => item.text).join('\n'),
    dialogue: units.filter(item => item.kind === 'dialogue').map(item => item.text),
    os: units.filter(item => item.kind === 'os').map(item => item.text),
    floatLabels: units.filter(item => item.kind === 'floatLabels').map(item => item.text),
    systemPanels: units.filter(item => item.kind === 'systemPanels').map(item => item.text) };
}

export function segmentationIssues(episode: Episode): string[] {
  const expected = storyUnits(episode).map(unit => unit.id);
  const actual = episode.segments.flatMap(segment => segment.storyUnitIds || storyUnits({ ...episode,
    scriptBeats: episode.scriptBeats.filter(beat => beat.id === segment.beatId) }).map(unit => unit.id));
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : ['分段剧情单元须完整覆盖、无重复、顺序不变'];
}

export function applySegmentation(episode: Episode, groups: unknown): void {
  if (!Array.isArray(groups) || !groups.length || groups.length > 200 ||
    groups.some(group => !Array.isArray(group) || !group.length || group.some(id => typeof id !== 'string')))
    throw new Error('分段计划须为剧情单元ID分组');
  const candidate = { ...episode, segments: groups.map((ids, index) => {
    const segment = { ...makeSegment(episode.scriptBeats[0], index + 1), durationSec: 30, storyUnitIds: ids as string[] };
    return segment;
  }) };
  const issues = segmentationIssues(candidate);
  if (issues.length) throw new Error(issues.join('；'));
  for (const segment of candidate.segments) {
    segment.subshots = defaultSubshots(segmentBeat(candidate, segment), 30, segment.number);
    segment.shotContractVersion = 2;
  }
  // Review visual and speech budgets afresh. No original script text is rewritten.
  episode.segments = candidate.segments;
  episode.auditApprovedHash = undefined; episode.sampleApprovedHash = undefined;
}

/** Conservative local planning: reserve visual/reaction time and never cut a line. */
export function automaticSegmentGroups(episode: Episode): string[][] {
  const groups: string[][] = [];
  let group: string[] = [], seconds = 0;
  for (const unit of storyUnits(episode)) {
    const spoken = unit.kind === 'dialogue' || unit.kind === 'os';
    const chars = unit.text.replace(/^[^：:]+[：:]/u, '').replace(/[，。！？；、\s]/gu, '').length;
    const cost = spoken ? chars / 3.5 + 1 : unit.kind === 'event' || unit.kind === 'reaction' ? 3 : 1;
    if (cost > 24) throw new Error(`单条声音事件超出30秒片段预算，须在正式剧本中明确拆句，不能删词：${unit.text}`);
    if (group.length && seconds + cost > 24) { groups.push(group); group = []; seconds = 0; }
    group.push(unit.id); seconds += cost;
  }
  if (group.length) groups.push(group);
  if (!groups.length || groups.length > 200) throw new Error('自动分段结果须为1–200段');
  return groups;
}
export function segmentPlanHash(episode:Episode) {return digest(storyUnits(episode));}
export function validateSegmentPlan(episode:Episode,groups:unknown,budgets:unknown) {
  const candidate=structuredClone(episode);applySegmentation(candidate,groups);
  if(!Array.isArray(budgets) || budgets.length!==candidate.segments.length) throw new Error('每段须提供完整声音、动作与反应预算');
  const warnings:string[]=[];
  const checked=candidate.segments.map((segment,index)=>{
    const budget=budgets[index];
    if(!budget || ['spokenSec','actionSec','reactionSec'].some(key=>!Number.isFinite(budget[key]) || budget[key]<0) || typeof budget.notes!=='string' || budget.notes.trim().length<8) throw new Error('分段预算及原剧本依据说明无效');
    const total=budget.spokenSec+budget.actionSec+budget.reactionSec;
    if(total>30.15 || budget.spokenSec+0.25<minimumSpokenDuration(segmentBeat(candidate,segment))) throw new Error('分段预算超出30秒或声音预算装不下完整台词');
    if(total<24)warnings.push(`片段${index+1}仅规划${total.toFixed(1)}秒，不能以空镜或新增剧情填满30秒；须重新规划或明确报告内容不足`);
    return {spokenSec:budget.spokenSec,actionSec:budget.actionSec,reactionSec:budget.reactionSec,notes:budget.notes.trim()};
  });
  return {groups:candidate.segments.map(segment=>segment.storyUnitIds!),budgets:checked,warnings};
}
