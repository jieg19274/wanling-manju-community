import { digest, scriptHash, sourceHash, highlightHash, type Episode } from './model.js';
export function storyReviewHash(episode: Episode): string {
  return digest({ source: sourceHash(episode), script: scriptHash(episode), highlights: highlightHash(episode),items:episode.highlightItems });
}
export function highlightItems(report:string) {
  const counts=new Map<string,number>();
  return report.split(/\r?\n/u).map(text=>text.trim()).filter(Boolean).map(text=>{
    const key=digest(text), occurrence=counts.get(key) || 0;counts.set(key,occurrence+1);
    return {id:`highlight:${key}:${occurrence}`,text};
  });
}
export function recordStoryReview(episode: Episode, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length !== episode.scriptBeats.length) throw new Error('须逐节点核对原文、高光覆盖、事件反应、对白/OS和可见信息');
  const entries = episode.scriptBeats.map(beat => {
    const item = raw.find(value => value?.beatId === beat.id);
    if (!item || !Number.isInteger(item.sourceStart) || !Number.isInteger(item.sourceEnd) || item.sourceStart < 0 ||
      item.sourceEnd <= item.sourceStart || item.sourceEnd > episode.sourceText.length ||
      (beat.sourceQuote && !episode.sourceText.slice(item.sourceStart, item.sourceEnd).includes(beat.sourceQuote)) ||
      typeof item.notes !== 'string' || item.notes.trim().length < 8 ||
      ['highlight', 'event', 'reaction', 'speech', 'labels'].some(key => item.checks?.[key] !== true))
      throw new Error('语义核对须提供定位原文范围、逐项确认与具体说明');
    const highlightIds=Array.isArray(item.highlightIds) ? item.highlightIds : [];
    if(new Set(highlightIds).size!==highlightIds.length || highlightIds.some((id:unknown)=>!episode.highlightItems?.some(highlight=>highlight.id===id))) throw new Error('高光覆盖引用无效');
    return { beatId: beat.id, sourceStart: item.sourceStart, sourceEnd: item.sourceEnd, notes: item.notes.trim(),highlightIds };
  });
  if(episode.highlightItems?.some(highlight=>!entries.some(entry=>entry.highlightIds.includes(highlight.id)))) throw new Error('须逐条记录高光覆盖，不能仅勾选高光已核对');
  episode.storyReview = { hash: storyReviewHash(episode), entries, reviewedAt: new Date().toISOString() };
  episode.auditApprovedHash = undefined;
}

export function recordContinuityReview(episode:Episode,raw:unknown) {
  if(!Array.isArray(raw) || raw.length!==Math.max(0,episode.segments.length-1)) throw new Error('须为每对相邻片段提交独立衔接证据');
  const entries=episode.segments.slice(1).map((segment,index)=>{
    const left=episode.segments[index],entry=raw[index];
    if(entry?.left!==left.id || entry?.right!==segment.id || typeof entry.notes!=='string' || entry.notes.trim().length<8 ||
      ['space','state','frame'].some(key=>entry.checks?.[key]!==true)) throw new Error('边界证据须匹配片段顺序，确认空间、人物状态、末帧并说明结果');
    return {left:left.id,right:segment.id,notes:entry.notes.trim()};
  });
  episode.continuityReview={hash:boundaryHash(episode),entries,notes:entries.map(entry=>entry.notes).join('\n'),reviewedAt:new Date().toISOString()};
  episode.auditApprovedHash=undefined;
}

export function boundaryHash(episode: Episode): string {
  return digest(episode.segments.slice(1).map((segment, index) => ({ left: episode.segments[index].id,
    right: segment.id, endFrame: episode.segments[index].subshots?.at(-1)?.endFrame,
    priorState: segment.subshots?.[0]?.priorState })));
}
