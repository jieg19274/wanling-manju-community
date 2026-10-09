import type { ScriptBeat, Segment } from './model.js';

export function pacingWarnings(beat: ScriptBeat, segment: Segment): string[] {
  const shots = segment.subshots || [], warnings: string[] = [];
  const normalized = (value: string) => value.replace(/[\s，。！？；、,.!?;：:]/gu, '');
  for (let index = 1; index < shots.length; index++) {
    const left = normalized(shots[index - 1].action), right = normalized(shots[index].action);
    if (left.length >= 8 && (left === right || left.includes(right) || right.includes(left)))
      warnings.push(`子镜 ${index} 与 ${index + 1} 动作重复，请依据正式剧情安排不同的可见推进`);
  }
  for (const [index, shot] of shots.entries()) {
    if (shot.endSec - shot.startSec >= 4 &&
      /^(?:凝视|注视|站定|等待|静止|停留|空镜|缓慢推近|镜头推近)/u.test(shot.action.trim()))
      warnings.push(`子镜 ${index + 1} 静态停留较长，请检查是否能以正式事件中的动作或反应推进`);
  }
  const spokenChars = [...beat.dialogue, ...beat.os].reduce((total, line) => total +
    line.replace(/^[^：:]+[：:]/u, '').replace(/[，。！？；、\s]/gu, '').length, 0);
  if (segment.durationSec >= 30 && spokenChars / 3.5 + 1 < 8 &&
    [...beat.event, ...beat.reaction].length < 65)
    warnings.push('30 秒片段剧情与声音信息偏少；请核对是否能按原文合并相邻事件，不能用空镜凑时长');
  return warnings;
}
