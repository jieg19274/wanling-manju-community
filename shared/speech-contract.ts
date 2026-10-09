import { beatFor, subshotsFor, type Episode, type Segment } from './model.js';
import { orderedSpeech } from './segmentation.js';

export function speechChecklist(episode: Episode, segment: Segment) {
  const beat = beatFor(episode, segment), shots = subshotsFor(beat, segment);
  return orderedSpeech(beat).map(({kind, index, id}) => {
    const text = beat[kind][index];
    const shot = shots.find(item => item.lineRefs[kind].includes(index));
    const timing = segment.speechPlan?.find(item=>item.kind===kind&&item.index===index);
    return { id: id || `${beat.id}:${kind}:${index}`, kind, text,
      startSec: timing?.startSec ?? shot?.startSec ?? 0, endSec: timing?.endSec ?? shot?.endSec ?? Math.min(segment.durationSec, 2) };
  });
}

export interface SpeechEvidence { id: string; heard: boolean; speaker: boolean; startSec: number; endSec: number }
export function validateSpeechEvidence(expected: ReturnType<typeof speechChecklist>, raw: unknown, duration: number): SpeechEvidence[] {
  if (!Array.isArray(raw) || raw.length !== expected.length) throw new Error('须逐句确认完整对白/OS和声线，音轨存在不代表说全');
  const seen = new Set<string>();
  let previousStart = -1;
  return expected.map(line => {
    const item = raw.find(value => value && value.id === line.id) as SpeechEvidence | undefined;
    if (!item || seen.has(item.id) || item.heard !== true || item.speaker !== true ||
      !Number.isFinite(item.startSec) || !Number.isFinite(item.endSec) || item.startSec < 0 ||
      item.endSec <= item.startSec || item.endSec > duration + 0.15 || item.startSec < previousStart ||
      item.startSec < line.startSec - 0.15 || item.startSec > line.endSec + 0.15)
      throw new Error(`声音验收缺失或时间偏移：${line.text}`);
    seen.add(item.id);
    previousStart = item.startSec;
    return { id: item.id, heard: true, speaker: true, startSec: item.startSec, endSec: item.endSec };
  });
}
