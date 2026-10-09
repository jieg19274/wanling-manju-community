import { staticCharacterAnchor, shotSpeech, speechWindowIssues, speechTextBoundary, screenTextBoundary, characterReferenceBoundary, visibleInformationBlock, visibleInformationIssues, promptPolicyIssues, promptStructureIssues } from './prompt-contract.js';
import { executionPlanIssues, executionPromptIssues, executionShotLines, labelStyleInstruction, type ExecutionPlan, type LabelStyle, type VisibleCue } from './execution-plan.js';
import { referencePurpose } from './reference-purpose.js';
import { sha256 } from './hash.js';
import { segmentReferences, videoReferences,requiresPortraitReference } from './asset-references.js';
import { segmentBeat, segmentationIssues, orderedSpeech } from './segmentation.js';
import { storyReviewHash, boundaryHash } from './story-review.js';
import {onlyTextualAssetMention,onlyDiscussedProp} from './asset-mentions.js';
import { DEFAULT_PRODUCTION_RULES, type ProductionRules } from './production-rules.js';
export { segmentReferences, videoReferences } from './asset-references.js';
export { pacingWarnings } from './pacing.js';

export type ProjectMode = 'standard' | 'douyin-story';
export type ArtifactKind = 'anchor' | 'prompt' | 'video';
export type VisualStyle = { name: string; description: string; presetId?: string };
import type { EpisodePlan, SourceRange, StoryPlanProgress } from './episode-plan.js';
export type VideoModel = { name: string; modelId: string; adapterPath: string;
  declaredCapabilities?: VideoModel['capabilities']; catalogFetchedAt?: string;
  capabilities?: { minDurationSec?: number; maxDurationSec?: number; fixedDurationSec?: number; maxReferences?: number; maxPromptChars?: number; nativeAudio?: boolean;
    referenceVideo?: boolean; referenceAudio?: boolean; resolutions?: string[]; outputResolution?: string; confirmedAt?: string;
    aspectRatios?: ('16:9' | '9:16' | '1:1')[] } };
export function knownVideoCapabilities(modelId: string): VideoModel['capabilities'] | undefined {
  if (/全能sd2\.5/u.test(modelId)) return { maxDurationSec: 30, fixedDurationSec: 30, maxReferences: 30, nativeAudio: true };
  // This exact model produced two 30-second 1280x720 videos with native speech
  // in the promotional verification. Audio support does not approve dialogue quality.
  if (modelId === '专享sd2.5(30图10音/4-30秒/720p)') return {
    minDurationSec: 4, maxDurationSec: 30, maxReferences: 30, nativeAudio: true,
    resolutions: ['1280x720', '720x1280'], aspectRatios: ['16:9', '9:16'],
  };
  return undefined;
}
export type ModelKind = 'text' | 'image' | 'video';
export type AssetKind = 'character' | 'scene' | 'prop';

export interface AssetState {
  id: string;
  label: string;
  appearance: string;
  trigger: string;
  startEpisode: number;
  startSegment: number;
}

export interface AssetImage {
  retainedAsOldVersion?: boolean;
  generationInput?: { asset: { id:string;kind:AssetKind;name:string;identity:string;voice:string;state?:AssetState };
    visualStyle?:VisualStyle;aspectRatio?:'16:9'|'9:16'|'1:1';modelId?:string };
  referenceAcceptance?: {status:'accepted';statement:string;acceptedAt:string;sourceImageId:string;sourceFileHash:string;acceptedInputHash:string;knownDifference:string;requiredVideoCorrection:string};
  derivedFrom?: {imageId:string;sourceHash:string;crop:{left:number;top:number;width:number;height:number}};
  layout?: 'three-view-portrait';
  referenceImages?: {imageId:string;fileHash:string}[];
  candidateId?: string;
  batchId?: string;
  id: string;
  fileHash?: string;
  stateId?: string;
  inputHash?: string;
  review?: { status: "approved" | "rejected"; approvalMode?:'user-fallback'; checks: Record<"identity" | "state" | "shape" | "clothing", boolean>; reviewedAt: string };
  role?: 'main' | 'turnaround' | 'portrait';
  mediaPath: string;
  createdAt: string;
  source: 'upload' | 'model';
}

export interface StoryAsset {
  id: string;
  kind: AssetKind;
  name: string;
  identity: string;
  voice: string;
  states: AssetState[];
  images: AssetImage[];
}

export interface AssetSuggestion {
  kind: AssetKind;
  name: string;
  identity: string;
  voice?: string;
  evidence: string;
  sourceName?: string;
  modelEvidence?: string;
    state?: { label: string; appearance: string; trigger: string; startSegment: number; modelTrigger?:string };
}

export interface AssetBinding { assetId: string; stateId?: string; imageId?: string; portraitImageId?: string;
  priorReference?: {imageId:string;untilSec:number;sourceEvidence:string} }
export interface ReferenceExclusion { imageId: string; reason: string; expectedScene: string; observedScene: string; createdAt: string }

export type LineKind = 'dialogue' | 'os' | 'floatLabels' | 'systemPanels';
export interface Subshot {
  id: string;
  startSec: number;
  endSec: number;
  framing: string;
  action: string;
  evidence?: string;
  location?: string;
  priorState?: string;
  result?: string;
  endFrame?: string;
  assetIds?: string[];
  lineRefs: Record<LineKind, number[]>;
}

export interface ScriptBeat {
  id: string;
  speechOrder?: { id?: string; kind: 'dialogue' | 'os'; index: number }[];
  sourceQuote?: string;
  event: string;
  reaction: string;
  dialogue: string[];
  os: string[];
  floatLabels: string[];
  systemPanels: string[];
}

export interface Artifact {
  promptArchive?: { archivedAt: string; reason: string };
  candidateId?: string;
  batchId?: string;
  id: string;
  jobId?: string;
  specId?: string;
  retainedAsOldVersion?: boolean;
  generationHash?: string;
  modelPromptHash?: string;
  promptTemplateVersion?: string;
  labelRepair?: { requestId: string; payloadHash: string; sourceArtifactId: string; sourceFileHash: string;
    outputFileHash: string; audioHash?: string; cues: VisibleCue[]; style: LabelStyle;
    resolvedFonts: {label: string; system: string}; createdAt: string };
  referenceHashes?: {imageId?: string; hash: string}[];
  kind: ArtifactKind;
  createdAt: string;
  sourceHash: string;
  content?: string;
  mediaPath?: string;
  demo?: boolean;
  modelName?: string;
  modelId?: string;
  technical?: { duration: number; width: number; height: number; hasAudio: boolean;
    warnings: string[]; inspectedAt?: string; size: number; modifiedAt: number };
  review?: { status: 'approved' | 'rejected'; notes: string; reviewedAt: string;
    speech?: import('./speech-contract.js').SpeechEvidence[];
      checks?: Record<'story' | 'voice' | 'assets' | 'labels' | 'pacing' | 'continuity', boolean> };
  userAcceptance?: {status:'accepted'|'withdrawn';statement:string;sourceMessageId:string;acceptedAt:string;withdrawnAt?:string;generationHash:string};
  userAcceptanceHistory?: NonNullable<Artifact['userAcceptance']>[];
  reviewHistory?: NonNullable<Artifact['review']>[];
}

export interface Segment {
  promptSelectionPaused?: boolean;
  artifactIds?: string[];
  id: string;
  number: number;
  beatId: string;
  storyUnitIds?: string[];
  assetRevision?: number;
  durationSec: number;
  visualPlan: string;
  voiceOverrides?: Record<string,string>;
  referenceExclusions?: ReferenceExclusion[];
  mentionOnlyAssets?: {assetId:string;sourceEvidence:string;reason:string}[];
  anchorPlan: { fromX: number; toX: number; level: 'wide' | 'medium' | 'close' };
  effectIds: string[];
  effectVersions: Record<string, string>;
  effectEvidence: Record<string, string>;
  effectCandidates?: { sourceHash: string; entries: { id: string; evidence: string }[] };
  executionPlan?: ExecutionPlan;
  artifacts: Artifact[];
  selected: Partial<Record<ArtifactKind, string>>;
  speedOverride?: number;
  action?: boolean;
  assetBindings?: AssetBinding[];
  subshots?: Subshot[];
  subshotsAuto?: boolean;
  subshotsReviewed?: boolean;
  speechPlan?: { kind: 'dialogue'|'os'; index: number; startSec: number; endSec: number }[];
  shotContractVersion?: 2;
  subshotCandidate?: { sourceHash: string; shots: Subshot[]; warnings?: string[]; createdAt: string };
}

export interface PreviewCut {
  segmentId: string;
  artifactId: string;
  startSec: number;
  durationSec?: number;
}

export interface Episode {
  id: string;
  number: number;
  title: string;
  productionVoicePolicy?: { contract: string; statement: string };
  sourceText: string;
  sourceRange?: SourceRange;
  sourceReviewedHash?: string;
  highlightReport: string;
  highlightItems?: {id:string;text:string}[];
  semanticCandidate?: {hash:string; entries:{beatId:string;sourceStart:number;sourceEnd:number;notes:string;highlightIds:string[]}[];warnings:string[];createdAt:string};
  segmentPlanCandidate?: {hash:string;groups:string[][];budgets:{spokenSec:number;actionSec:number;reactionSec:number;notes:string}[];warnings:string[];createdAt:string};
  highlightCandidate?: { sourceHash: string; content: string };
  scriptCandidate?: { sourceHash: string; highlightHash: string; beats: ScriptBeat[] };
  highlightReviewedHash?: string;
  scriptBeats: ScriptBeat[];
  storyReview?: { hash: string; entries: { beatId: string; sourceStart: number; sourceEnd: number; notes: string;highlightIds?:string[] }[]; reviewedAt: string };
  continuityReview?: { hash: string; notes: string; entries?:{left:string;right:string;notes:string}[]; reviewedAt: string };
  sourceTraceRequired?: boolean;
  visualStyle?: VisualStyle;
  assetRevision?: number;
  scriptVersion?: number;
  scriptHistory?: { version: number; archivedAt: string; sourceText: string; sourceReviewedHash?: string;
    highlightReport: string; highlightReviewedHash?: string;
    scriptBeats: ScriptBeat[]; sourceTraceRequired?: boolean; visualStyle?: VisualStyle; scriptLockedHash: string;
    segments: Segment[]; auditApprovedHash?: string; sampleApprovedHash?: string;
    previewCuts?: PreviewCut[] }[];
  scriptLockedHash?: string;
  assetCandidate?: { scriptHash: string; entries: AssetSuggestion[]; createdAt: string };
  segments: Segment[];
  auditApprovedHash?: string;
  sampleApprovedHash?: string;
  previewMediaPath?: string;
  previewCuts?: PreviewCut[];
  previewOverride?: boolean;
}

export interface Project {
  productionRules?: ProductionRules;
  id: string;
  demo?: { version: 1; previewMediaPath: string; description: string };
  name: string;
  mode: ProjectMode;
  visualStyle?: VisualStyle;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  labelStyle?: LabelStyle;
  assets?: StoryAsset[];
  textModel?: VideoModel;
  imageModel?: VideoModel;
  videoModel?: VideoModel;
  modelChecks?: Partial<Record<ModelKind, { checkedAt: string; modelId: string; adapterPath: string }>>;
  archivedAt?: string;
  archivedEpisodes?: Episode[];
  sourceCorpus?: string;
  episodePlan?: EpisodePlan;
  episodePlanProgress?: StoryPlanProgress;
  createdAt: string;
  updatedAt: string;
  episodes: Episode[];
}

export const id = () => globalThis.crypto.randomUUID();
export const now = () => new Date().toISOString();
export const digest = (value: unknown) => sha256(JSON.stringify(value));
export const lines = (value: string) => value.split(/\r?\n/u).map(part => part.trim()).filter(Boolean);

export function makeProject(name: string, mode: ProjectMode): Project {
  const timestamp = now();
  return { id: id(), name: name.trim(), mode, visualStyle: { name: '', description: '' },
    productionRules: structuredClone(DEFAULT_PRODUCTION_RULES),
    aspectRatio: '16:9', assets: [],
    textModel: { name: '', modelId: '', adapterPath: '' }, imageModel: { name: '', modelId: '', adapterPath: '' },
    videoModel: { name: '', modelId: '', adapterPath: '' }, createdAt: timestamp, updatedAt: timestamp, episodes: [] };
}

export function makeEpisode(number: number, title: string, visualStyle?: VisualStyle): Episode {
  return { id: id(), number, title: title.trim(), sourceText: '', highlightReport: '',
    scriptBeats: [], visualStyle: structuredClone(visualStyle || { name: '', description: '' }),
    scriptVersion: 1, scriptHistory: [], segments: [] };
}

export function makeBeat(): ScriptBeat {
  return { id: id(), event: '', reaction: '', dialogue: [], os: [], floatLabels: [], systemPanels: [] };
}

function narrativeParts(value: string, count: number): string[] {
  const clauses = value.match(/[^，。！？；]+[，。！？；]?/gu)?.map(part => part.trim()).filter(Boolean) || [];
  if (!clauses.length) return Array(count).fill(value);
  const groups: string[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    const remaining = count - index;
    const available = clauses.length - at;
    if (available <= 0) { groups.push('承接上一子镜的正式动作与空间状态，不新增事件。'); continue; }
    const target = Math.ceil(available / remaining);
    groups.push(clauses.slice(at, at + target).join(''));
    at += target;
  }
  return groups;
}

export function defaultSubshots(beat: ScriptBeat, durationSec: number, segmentNumber = 1): Subshot[] {
  const all = (key: LineKind) => beat[key].map((_, index) => index);
  if (durationSec >= 10) {
    const first = segmentNumber === 1;
    const firstSeconds = first ? 2 : 0;
    const count = Math.max(2, Math.min(12, (first ? 1 : 0) + Math.ceil((durationSec - firstSeconds) / 5)));
    const boundaries = Array.from({ length: count + 1 }, (_, index) =>
      index === 0 ? 0 : index === count ? durationSec :
        Math.round((firstSeconds + (index - (first ? 1 : 0)) * (durationSec - firstSeconds) /
          (count - (first ? 1 : 0))) * 1000) / 1000);
    const reactionCount = durationSec >= 25 ? 2 : 1;
    const actions = [...narrativeParts(beat.event, count - reactionCount),
      ...narrativeParts(beat.reaction, reactionCount)];
    const framings = ['首帧主体近景', '主体与场景中景', '动作近景', '空间关系镜',
      '动作结果镜', '人物反应近景', '末帧交接镜'];
    const shots = boundaries.slice(0, -1).map((startSec, index) => ({ id: id(), startSec,
      endSec: boundaries[index + 1], framing: framings[Math.min(index, framings.length - 1)],
      action: `${index === 0 && first ? '第一帧直接呈现正式事件主体，不单独拍环境空镜；' : ''}${actions[index]}`,
      lineRefs: { dialogue: [] as number[], os: [] as number[], floatLabels: [] as number[],
        systemPanels: [] as number[] } }));
    for (const kind of ['dialogue', 'os', 'floatLabels', 'systemPanels'] as LineKind[]) {
      const lines = beat[kind];
      let characters = 0;
      const total = lines.reduce((sum, line) => sum + line.length, 0) || 1;
      for (const [index, line] of lines.entries()) {
        const targetSec = (characters / total) * durationSec;
        const shotIndex = kind === 'floatLabels' ? Math.min(index, shots.length - 1) :
          Math.max(0, shots.findIndex(shot => targetSec < shot.endSec));
        shots[shotIndex].lineRefs[kind].push(index);
        characters += line.length;
      }
    }
    if (beat.speechOrder) {
      for (const shot of shots) { shot.lineRefs.dialogue = []; shot.lineRefs.os = []; }
      const refs = orderedSpeech(beat);
      const total = refs.reduce((sum, ref)=>sum + beat[ref.kind][ref.index].length,0) || 1;
      let cursor = 0;
      for (const ref of refs) {
        const time = cursor / total * (durationSec - 3);
        const target = shots.find(shot=>time < shot.endSec) || shots.at(-1)!;
        target.lineRefs[ref.kind].push(ref.index);
        cursor += beat[ref.kind][ref.index].length;
      }
    }
    return shots;
  }
  return [
    { id: id(), startSec: 0, endSec: durationSec / 2, framing: '中景', action: beat.event,
      lineRefs: { dialogue: all('dialogue'), os: all('os'), floatLabels: all('floatLabels'),
        systemPanels: all('systemPanels') } },
    { id: id(), startSec: durationSec / 2, endSec: durationSec, framing: '反应镜', action: beat.reaction,
      lineRefs: { dialogue: [], os: [], floatLabels: [], systemPanels: [] } },
  ];
}

export function subshotsFor(beat: ScriptBeat, segment: Segment): Subshot[] {
  return segment.subshots?.length ? segment.subshots : defaultSubshots(beat, segment.durationSec);
}

export function validateSubshots(beat: ScriptBeat, segment: Segment): string[] {
  const shots = subshotsFor(beat, segment), issues: string[] = [];
  issues.push(...speechWindowIssues(beat, shots, segment.durationSec, segment.speechPlan));
  const spokenSeconds = minimumSpokenDuration(beat);
  if (spokenSeconds > segment.durationSec + 0.25)
    issues.push(`正式对白/OS至少需要约 ${spokenSeconds.toFixed(1)} 秒，当前片段 ${segment.durationSec} 秒容纳不下；请拆分正式剧本节点或调整时长，不得删词`);
  if (shots.length < 2 || shots.length > 12) issues.push('子镜数量须为 2–12');
  if (segment.durationSec === 30 && (shots.length < 5 || shots.length > 8))
    issues.push('30 秒片段须拆成 5–8 个子镜，不能用两个 15 秒长镜头充数');
  if (segment.durationSec >= 10 && segment.number === 1 && shots[0] && shots[0].endSec > 3)
    issues.push('开场片段的首镜须在 3 秒内进入主体与剧情动作');
  let cursor = 0;
  for (const [index, shot] of shots.entries()) {
    if (!Number.isFinite(shot.startSec) || !Number.isFinite(shot.endSec) ||
      Math.abs(shot.startSec - cursor) > 0.01 || shot.endSec - shot.startSec < 0.1)
      issues.push(`子镜 ${index + 1} 时间不连续或过短`);
    if (!shot.framing?.trim() || !shot.action?.trim()) issues.push(`子镜 ${index + 1} 缺少景别或画面动作`);
    if (shot.evidence && !(beat.event + '\n' + beat.reaction).includes(shot.evidence))
      issues.push(`子镜 ${index + 1} 的剧情依据已不属于正式剧本`);
    if (segment.shotContractVersion === 2) {
      if (!shot.evidence?.trim() || shot.evidence.trim().length < 4)
        issues.push(`子镜 ${index + 1} 缺少可核对的正式剧情逐字依据`);
      for (const [key, label] of [['location', '物理场景'], ['priorState', '前置状态'],
        ['result', '可见结果'], ['endFrame', '末帧交接']] as const)
        if (!shot[key]?.trim()) issues.push(`子镜 ${index + 1} 缺少${label}`);
      if (!Array.isArray(shot.assetIds)) issues.push(`子镜 ${index + 1} 缺少资产清单`);
    }
    if (/承接上一子镜的正式动作与空间状态/u.test(shot.action))
      issues.push(`子镜 ${index + 1} 只有占位动作，须依据正式剧情补足可见变化`);
    if (segment.durationSec >= 10 && shot.endSec - shot.startSec > 6.01)
      issues.push(`子镜 ${index + 1} 超过 6 秒，请拆镜并保留对白/OS及剧情动作`);
    cursor = shot.endSec;
  }
  if (Math.abs(cursor - segment.durationSec) > 0.01) issues.push('子镜未覆盖片段完整时长');
  for (const kind of ['dialogue', 'os', 'floatLabels', 'systemPanels'] as LineKind[]) {
    const refs = shots.flatMap(shot => shot.lineRefs?.[kind] || []);
    const expected = beat[kind].map((_, index) => index);
    if (refs.length !== expected.length || refs.some(ref => !Number.isInteger(ref) || ref < 0 || ref >= expected.length) ||
      new Set(refs).size !== expected.length) issues.push(`${kind} 未逐条分配到唯一子镜`);
    else if (segment.shotContractVersion === 2 && refs.some((ref, index) => ref !== index))
      issues.push(`${kind} 在子镜中的顺序与锁定剧本不一致`);
  }
  if (!segment.speechPlan) issues.push(...spokenWindowIssues(beat, shots, segment.durationSec));
  return issues;
}

export function spokenWindowIssues(beat: ScriptBeat, shots: Subshot[], durationSec: number): string[] {
  const starts = shots.flatMap((shot, shotIndex) => (['dialogue', 'os'] as const).flatMap(kind =>
    (shot.lineRefs?.[kind] || []).map(index => ({ shotIndex, startSec: shot.startSec,
      label: kind === 'dialogue' ? '对白' : '内心OS', line: beat[kind][index] || '' }))));
  const groups = [...new Set(starts.map(item => item.startSec))].sort((a, b) => a - b);
  return groups.flatMap((startSec, groupIndex) => {
    const lines = starts.filter(item => item.startSec === startSec);
    const chars = lines.reduce((sum, item) => sum + item.line.replace(/^[^：:]+[：:]/u, '')
      .replace(/[，。！？；、\s…]/gu, '').length, 0);
    const required = chars / 3.5;
    const available = (groups[groupIndex + 1] ?? durationSec) - startSec;
    return required > available + 0.05 ?
      [`子镜 ${lines[0].shotIndex + 1} 开始的${lines.map(item => item.label).join('、')}约需 ${required.toFixed(1)} 秒，下一句开始前只有 ${available.toFixed(1)} 秒；请提前开始、后移下一句或延长片段，不得加速念词`] : [];
  });
}

export function makeSegment(beat: ScriptBeat, number: number): Segment {
  return { id: id(), number, beatId: beat.id, durationSec: 30, visualPlan: '',
    anchorPlan: { fromX: 25, toX: 75, level: 'medium' }, effectIds: [], effectVersions: {}, effectEvidence: {}, artifacts: [], selected: {},
    subshots: defaultSubshots(beat, 30, number), subshotsAuto: true, subshotsReviewed: false };
}

export function minimumSpokenDuration(beat: ScriptBeat): number {
  const spokenChars = [...beat.dialogue, ...beat.os].reduce((sum, line) =>
    sum + line.replace(/^[^：:]+[：:]/u, '').replace(/[，。！？；、\s]/gu, '').length, 0);
  return spokenChars ? spokenChars / 3.5 + 1 : 0;
}

export function suggestedSegmentDuration(beat: ScriptBeat, maxDurationSec = 30): number {
  const voicedSeconds = minimumSpokenDuration(beat);
  const target = Math.max(30, Math.ceil(voicedSeconds / 5) * 5);
  return Math.min(Math.max(1, Math.floor(maxDurationSec)), target);
}

export function modelSegmentDuration(beat: ScriptBeat, model?: VideoModel): number {
  const known = knownVideoCapabilities(model?.modelId || '');
  const fixed = known?.fixedDurationSec || model?.capabilities?.fixedDurationSec;
  const maximum = known?.maxDurationSec || model?.capabilities?.maxDurationSec || 30;
  if ((fixed && fixed !== 30) || maximum < 30 || (model?.capabilities?.minDurationSec || 0)>30) throw new Error('用户要求每个生成片段固定30秒，所选模型不支持');
  return 30;
}

export function scriptHash(episode: Episode): string { return digest(episode.scriptBeats); }
export function sourceHash(episode: Episode): string { return digest(episode.sourceText); }
export function highlightHash(episode: Episode): string { return digest(episode.highlightReport); }

export function requireScriptReady(episode: Episode): void {
  if (episode.sourceText.trim().length < 50 || episode.sourceReviewedHash !== sourceHash(episode))
    throw new Error('请先导入并完整阅读原文章节，再确认原文已读');
  if (!episode.highlightReport.trim() || episode.highlightReviewedHash !== highlightHash(episode))
    throw new Error('请先完成并核对原文高光剧情报告');
  if (!episode.scriptBeats.length || episode.scriptBeats.some(beat => !beat.event.trim() || !beat.reaction.trim()))
    throw new Error('正式剧本每个节点都需要事件和人物反应');
  for (const beat of episode.scriptBeats) {
    if (episode.sourceTraceRequired && (!beat.sourceQuote?.trim() ||
      beat.sourceQuote.trim().length < 6 || !episode.sourceText.includes(beat.sourceQuote.trim())))
      throw new Error('正式剧本每个节点须填写本集原文中的逐字依据（至少 6 字）');
    for (const item of [...beat.dialogue, ...beat.os]) {
      if (!/^[^：:]+[：:].+/u.test(item)) throw new Error(`对白/OS须用“角色：内容”填写：${item}`);
    }
  }
}

export function lockScript(episode: Episode): void {
  requireScriptReady(episode);
  episode.scriptLockedHash = scriptHash(episode);
  episode.segments = episode.scriptBeats.map((beat, index) => makeSegment(beat, index + 1));
  episode.auditApprovedHash = undefined;
}

export function beatFor(episode: Episode, segment: Segment): ScriptBeat {
  if (segment.storyUnitIds) return segmentBeat(episode, segment);
  const beat = episode.scriptBeats.find(item => item.id === segment.beatId);
  if (!beat) throw new Error(`片段 ${segment.number} 没有对应的正式剧本节点`);
  return beat;
}

function protectedLines(beat: ScriptBeat): string[] {
  return [beat.event, beat.reaction, ...beat.dialogue, ...beat.os, ...beat.floatLabels, ...beat.systemPanels].filter(Boolean);
}

export function contentHash(episode: Episode, segment: Segment): string {
  return digest({ script: episode.scriptLockedHash, beat: beatFor(episode, segment), visualPlan: segment.visualPlan,voiceOverrides:segment.voiceOverrides,referenceExclusions:segment.referenceExclusions,mentionOnlyAssets:segment.mentionOnlyAssets,
    visualStyle: episode.visualStyle || { name: '', description: '' },
    anchorPlan: segment.anchorPlan, durationSec: segment.durationSec, effectIds: segment.effectIds,
    effectVersions: segment.effectVersions, effectEvidence: segment.effectEvidence,
    assetRevision: segment.assetRevision || 0, assetBindings: segment.assetBindings || [],
    subshots: segment.subshots || [], ...(segment.speechPlan ? {speechPlan:segment.speechPlan} : {}),
    ...(segment.executionPlan ? {executionPlan:segment.executionPlan} : {}) });
}

export function validMentionOnly(segment:Segment,beat:ScriptBeat,asset:{id:string;kind:AssetKind;name:string;identity:string}):boolean {
  const declaration=segment.mentionOnlyAssets?.find(item=>item.assetId===asset.id);
  const eligible = asset.kind==='character' ? requiresPortraitReference(asset) : asset.kind==='prop' ?
    !!declaration?.sourceEvidence.includes(asset.name) && onlyDiscussedProp(beat,segment,asset.name) :
    asset.kind==='scene' && !!declaration?.sourceEvidence.includes(asset.name) &&
    !segment.subshots?.some(shot => (shot.location || '').includes(asset.name) ||
      ['进入', '转入', '转至', '抵达', '来到', '走进', '置身'].some(verb => shot.action.includes(verb + asset.name)));
  return !!declaration && eligible && declaration.reason.length>=8 && declaration.sourceEvidence.length>=4 &&
    [beat.event,beat.reaction,...beat.dialogue,...beat.os].some(text=>text.includes(declaration.sourceEvidence)) &&
    !segment.assetBindings?.some(binding=>binding.assetId===asset.id) && !segment.subshots?.some(shot=>shot.assetIds?.includes(asset.id)) &&
    ![...beat.dialogue,...beat.os].some(line=>line.split(/[：:]/u)[0].replace('·OS','').trim()===asset.name);
}

export function storyboardSourceHash(episode: Episode, segment: Segment): string {
  return digest({ script: episode.scriptLockedHash, beat: beatFor(episode, segment),
    durationSec: segment.durationSec, visualPlan: segment.visualPlan,
    assetBindings: segment.assetBindings || [], assetRevision: segment.assetRevision || 0 });
}

export function composeStoryboard(episode: Episode, segment: Segment): string {
  const beat = beatFor(episode, segment);
  const shots = subshotsFor(beat, segment);
  return [
    ...(segment.mentionOnlyAssets||[]).map(item=>`【仅被提及，不出画】${item.reason}；正式依据：${item.sourceEvidence}。不得因提及而新增该资产的实体、人物正脸或反打。`),
    `正式片段 ${segment.number}｜${segment.durationSec} 秒`,
    ...(beat.sourceQuote ? [`原文依据：${beat.sourceQuote}`] : []),
    `事件：${beat.event}`, `人物反应：${beat.reaction}`,
    ...beat.dialogue.map(line => `对白：${line}`), ...beat.os.map(line => `内心OS：${line}`),
    ...beat.floatLabels.map(line => `浮签：${line}`), ...beat.systemPanels.map(line => `系统面板：${line}`),
    ...shots.flatMap((shot, index) => [
      `子镜 ${index + 1}｜${shot.startSec}–${shot.endSec} 秒｜${shot.framing}｜场景：${shot.location || '待核对'}｜前置：${shot.priorState || '待核对'}｜动作：${shot.action}｜结果：${shot.result || '待核对'}｜末帧：${shot.endFrame || '待核对'}`,
      ...(['dialogue', 'os', 'floatLabels', 'systemPanels'] as LineKind[]).flatMap(kind =>
        shot.lineRefs[kind].map(ref => `${kind}：${beat[kind][ref] ?? '未找到正式剧本条目'}`)),
      ...executionShotLines(beat, segment, shot),
    ]),
    `视觉与机位：${segment.visualPlan.trim() || '待填写'}`,
  ].join('\n');
}

export function composeImport(episode: Episode, segment: Segment): string {
  return `【正式分镜导入版】\n${composeStoryboard(episode, segment)}\n【末帧交接】保持已写出的动作结果，不新增剧情。`;
}

export function selectedPromptContractIssues(episode: Episode, segment: Segment, project?: Project): string[] {
  const prompt = selectedArtifact(segment, 'prompt'), beat = beatFor(episode, segment), shots = subshotsFor(beat, segment);
  const issues = validateSubshots(beat, segment);
  issues.push(...executionPlanIssues(beat, segment, shots, project));
  if (!prompt?.content) return [...issues, '选用提示词缺失'];
  if (prompt.sourceHash !== contentHash(episode, segment)) issues.push('选用提示词来源已变化；请核对受影响片段');
  for (const line of protectedLines(beat)) if (!prompt.content.includes(line)) issues.push('选用提示词遗漏正式剧情或人物反应：' + line);
  if(episode.productionVoicePolicy?.contract&&!prompt?.content?.includes(episode.productionVoicePolicy.contract))issues.push('选用提示词缺少用户指定声音与字幕规则，请重新编译；完整保留正式对白和OS');
  issues.push(...promptPolicyIssues(prompt.content));
  issues.push(...promptStructureIssues(beat, segment, shots, prompt.content,
    project ? Object.fromEntries((project.assets || []).map(asset => [asset.id, asset.name])) : undefined));
  issues.push(...visibleInformationIssues(beat, prompt?.content || ''));
  issues.push(...executionPromptIssues(beat, segment, shots, prompt.content,
    project ? Object.fromEntries((project.assets || []).map(asset => [asset.id, asset.name])) : {}));
  for (const line of [...beat.dialogue, ...beat.os]) if (!prompt?.content?.includes(line)) issues.push('选用提示词遗漏正式对白或OS，不能生成');
  for (const [index] of shots.entries()) for (const kind of ['dialogue', 'os'] as const) {
    const text = shotSpeech(beat, shots, index, kind, segment);
    if (text.startsWith('无新台词；承接前镜') && !prompt?.content?.includes(text))
      issues.push(`子镜${index + 1}的跨镜${kind}延续合同缺失；请重新编译提示词`);
  }
  return issues;
}

export function promptReadiness(episode: Episode, segment: Segment, project?: Project) {
  const current = selectedArtifact(segment, 'prompt');
  const issues = selectedPromptContractIssues(episode, segment, project);
  if (!issues.length) return { state: 'ready', issues, candidate: undefined };
  const candidate = [...segment.artifacts].reverse().find(item => item.kind === 'prompt' && !item.promptArchive && item.id !== current?.id &&
    !selectedPromptContractIssues(episode, { ...segment, selected: { ...segment.selected, prompt: item.id } }, project).length);
  return { state: candidate ? 'candidate' : !current ? 'missing' :
    current.sourceHash !== contentHash(episode, segment) ? 'stale' : 'invalid', issues, candidate };
}

export function composePrompt(episode: Episode, segment: Segment, effectDescriptions: string[] = [],
  references: ReturnType<typeof segmentReferences> = [],attachments:ReturnType<typeof videoReferences>=[], labelStyle?: LabelStyle): string {
  const beat = beatFor(episode, segment);
  const style = episode.visualStyle;
  const shots = subshotsFor(beat, segment);
  const pov=references.find(ref=>ref.kind==='character'&&!requiresPortraitReference({kind:ref.kind,identity:ref.identity}));
  return [
    '【最高约束】严格按本段子镜时间顺序生成；禁止新增人物、场景、动作或对白，禁止跳镜、提前演出下一段和重复拉长同一动作。锁定剧本中的因果、反应与声音须完整保留。',
    ...(episode.productionVoicePolicy?.contract?[episode.productionVoicePolicy.contract]:[]),
    speechTextBoundary(beat),
    screenTextBoundary(),
    ...(segment.mentionOnlyAssets||[]).map(item=>`【仅被提及，不出画】${item.reason}；正式依据：${item.sourceEvidence}。不得因提及而新增该人物的正脸、身体或反打。`),
    `【正式视频提示词｜片段 ${segment.number}｜${segment.durationSec} 秒】`,
    '【逐镜参考范围】全部附件是资产库，不代表每镜全部出场。每镜只使用该镜参考资产，未列出的角色和道具不得被图片诱导提前入场；衣饰和道具图片背景不是实际场景。',
    characterReferenceBoundary(),
    ...attachments.map((ref,index)=>`【附件图${index+1}】${ref.name}｜${ref.referenceLayout==='three-view-portrait'?'完整四视图＋大头照':'主图'}；${referencePurpose(ref,pov?.assetId)}${ref.temporalScope?'；适用：'+ref.temporalScope:''}`),
    ...(style?.name ? [`【项目漫剧风格】${style.name}`] : []),
    ...(style?.description ? [`【统一视觉要求】${style.description}。风格只影响画面表现，不得改变下列正式剧情、对白或可见信息。`] : []),
    `【剧情与动作】${beat.event}`, `【人物反应】${beat.reaction}`,
    `【画面与机位】${segment.visualPlan.trim() || '遵照正式分镜的场景、动作方向与末帧'}`,
    ...(segment.speechPlan?.length ? ['【逐句声音时序】下列时间是对应原句的唯一正常发声时窗；同句跨镜连续一次，OS闭口。', ...segment.speechPlan.map(item=>`${item.kind==='dialogue'?'对白':'内心OS'} ${item.index+1}｜${item.startSec}–${item.endSec}秒｜${beat[item.kind][item.index]}`)] : []),
    ...(segment.durationSec >= 10 ? ['【镜头节奏】本段按下列子镜时间码切换独立景别，不拍成单个持续推拉运镜；对白和内心OS从所标子镜开始，可自然跨后续子镜说完，切镜不得截断声音或压缩台词。'] : []),
    pov?`【声音生成合同】完整原生音轨必须生成并保留。摄影机就是${pov.name}的双眼；该角色对白从摄影机位置发出，不出现主角脸或嘴型；其内心OS使用同一本人声线，不能配给镜头前的对手。只有可见说话角色才同步其自身口型。各角色分别使用下列声线，逐字按正式原句说完整，无重叠抢词、复读或额外旁白；切镜不中断声音。清晰普通话、自然正常语速，不吞字、不耳语、不快读赶词。先不生成背景音乐，环境音和音效低电平辅助，不能盖词。`:'【声音生成合同】完整原生音轨必须生成并保留。逐镜【对白】由对应角色真实说出口，口型同步；逐镜【内心OS】也必须由对应角色本人声线逐字发声，嘴型不动，带轻微内心混响。环境音与音效在发声时压低，不得用环境声代替台词、用画面字幕代替声音，或因角色当前不是人形而省略其心声。禁止第三方解说、旁白及额外配音。',
    '【声音字段口径】按逐镜动作及声音计划明确标定的起音时点依次发声；未另标细分时点的新句才从其所属子镜起点开始。禁止在规定起音点之前朗读。标为无新台词的子镜可以承接已经开始的同一句声音，不新增发声。切镜不截断、不重说；同一子镜内的对白与OS，以及两个人物问答按各自明确时间先后进行，不同时抢话。软件最迟结束字段只是窗口上限，不要求读满；具体落音服从已明确的实际计划与正常语速，嘴型同步，OS闭口。对白和OS均由对应角色本人声线实际进入视频模型原生音轨，不能用字幕替代。',
    ...shots.map((shot, index) =>
      `### 子镜${index + 1}｜${shot.startSec}–${shot.endSec}秒｜${shot.framing}\n【场景与前置】${shot.location || '沿用已核对场景'}；${shot.priorState || '承接上一镜'}\n【正式画面动作】${shot.action}\n【可见结果】${shot.result || '遵照正式动作'}\n【参考资产】${(shot.assetIds || []).map(assetId => references.find(ref => ref.assetId === assetId)?.name || assetId).join('、') || '无'}\n【对白】${shotSpeech(beat,shots,index,'dialogue',segment)}\n【内心OS】${shotSpeech(beat,shots,index,'os',segment)}\n【旁白】无\n【浮签】${shot.lineRefs.floatLabels.map(n => beat.floatLabels[n]).join('、') || '无'}\n【系统信息】${shot.lineRefs.systemPanels.map(n => beat.systemPanels[n]).join('、') || '无'}\n${executionShotLines(beat,segment,shot,Object.fromEntries(references.map(ref=>[ref.assetId,ref.name]))).join('\n')}${segment.executionPlan ? '\n' : ''}【停止边界/物理末帧】${shot.endFrame || '接下一镜'}。不提前演下一镜。`),
    ...references.map(ref => `【${ref.kind === 'character' ? '角色' : ref.kind === 'scene' ? '场景' : '道具'}锚点】${ref.name}；${ref.kind==='character'?staticCharacterAnchor(ref.identity):ref.identity}${ref.stateLabel ? `；状态：${ref.stateLabel}，${ref.appearance}` : ''}${(segment.voiceOverrides?.[ref.assetId]||ref.voice) ? `；声线：${segment.voiceOverrides?.[ref.assetId]||ref.voice}` : ''}`),
    ...(segment.executionPlan ? [] : effectDescriptions.map(text => `【视觉特效】${text}`)),
    labelStyleInstruction(segment.executionPlan?.labelStyle || labelStyle),
    visibleInformationBlock(beat),
    '【禁止】不得删减事件、对白、OS、人物反应或可见信息；不得添加新剧情。',
  ].join('\n');
}

export function anchorSvg(segment: Segment, serpentine = false, characterCount = 1): string {
  const x1 = Math.max(10, Math.min(90, segment.anchorPlan.fromX));
  const x2 = Math.max(10, Math.min(90, segment.anchorPlan.toX));
  const count = Math.max(2, Math.min(12, segment.subshots?.length || 2));
  const width = 640 / count, radius = Math.min(13, width / 7) *
    (segment.anchorPlan.level === 'close' ? 1.25 : segment.anchorPlan.level === 'wide' ? 0.8 : 1);
  const panels = Array.from({ length: count }, (_, index) => {
    const from = width * (x1 + (x2 - x1) * index / count) / 100;
    const to = width * (x1 + (x2 - x1) * (index + 1) / count) / 100;
    const arrow = Math.abs(to - from) > radius * 2 ?
      `<path d="M${from} 250 L${to} 250" stroke="#8b5a43" stroke-width="3" marker-end="url(#tip)"/>` : '';
    const serpentPath = `M${Math.max(8, from - 32)} 267 C${Math.max(10, from - 10)} 226 ${Math.max(10, to - 28)} 280 ${to} 225`;
    const lead = serpentine ? `<path d="${serpentPath}" stroke="#617584" stroke-width="${Math.max(13, radius * 2.3)}" stroke-linecap="round" fill="none"/><path d="${serpentPath}" stroke="#f4f0e8" stroke-width="${Math.max(9, radius * 1.7)}" stroke-linecap="round" fill="none"/><circle cx="${to}" cy="220" r="${radius * 0.85}" fill="#f4f0e8" stroke="#596777" stroke-width="2"/>` :
      `<circle cx="${from}" cy="220" r="${radius}" fill="#35495e"/><path d="M${from - radius} 285 L${from} 245 L${from + radius} 285" stroke="#35495e" stroke-width="${Math.max(3, radius / 2)}" fill="none"/>`;
    const second = serpentine && characterCount > 1 ?
      `<path d="M${width * 0.88} 273 C${width * 0.72} 243 ${width * 0.65} 279 ${width * 0.58} 240" stroke="#639388" stroke-width="${Math.max(7, radius * 1.3)}" stroke-linecap="round" fill="none"/><circle cx="${width * 0.58}" cy="237" r="${radius * 0.7}" fill="#639388"/>` : '';
    return `<g transform="translate(${index * width},0)"><rect width="${width}" height="360" fill="${index % 2 ? '#e8e2d5' : '#eee8dd'}"/><path d="M0 286 L${width} 286" stroke="#ad9d89" stroke-width="2"/>${lead}${second}${arrow}<path d="M${width} 0 L${width} 360" stroke="#fff" stroke-width="4"/></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#8b5a43"/></marker></defs>${panels}</svg>`;
}

export function selectedArtifact(segment: Segment, kind: ArtifactKind): Artifact | undefined {
  return segment.artifacts.find(item => item.id === segment.selected[kind] && item.kind === kind &&
    (kind !== 'prompt' || !item.promptArchive));
}

export function auditEpisode(episode: Episode, project?: Project): string[] {
  const issues: string[] = [];
  if (episode.sourceReviewedHash !== sourceHash(episode)) issues.push('原文尚未完成阅读确认或已变化');
  if (episode.highlightReviewedHash !== highlightHash(episode)) issues.push('高光剧情报告尚未核对或已变化');
  if (episode.scriptLockedHash !== scriptHash(episode)) issues.push('正式剧本未锁定或锁定后已变化');
  if (episode.sourceTraceRequired && episode.storyReview?.hash !== storyReviewHash(episode)) issues.push('逐节点原文语义及高光覆盖尚未人工核对');
  if (episode.segments.length > 1 && episode.segments.some(segment => segment.shotContractVersion === 2) &&
    (episode.continuityReview?.hash !== boundaryHash(episode) || episode.continuityReview?.entries?.length!==episode.segments.length-1)) issues.push('片段间状态与末帧衔接尚未独立核对');
  if (episode.sourceTraceRequired) for (const [index, beat] of episode.scriptBeats.entries())
    if (!beat.sourceQuote?.trim() || !episode.sourceText.includes(beat.sourceQuote.trim()))
      issues.push(`剧情节点 ${index + 1} 缺少可追溯原文依据`);
  issues.push(...segmentationIssues(episode));
  for (let index = 0; index < episode.segments.length; index++) {
    const segment = episode.segments[index], beat = beatFor(episode, segment);
    if (segment.number !== index + 1) { issues.push('分段序号不连续'); continue; }
    if (segment.durationSec !== 30) issues.push(`片段 ${segment.number} 必须固定 30 秒`);
    if (!segment.visualPlan.trim()) issues.push(`片段 ${segment.number} 缺少视觉与机位`);
    if (segment.subshotsReviewed === false) issues.push(`片段 ${segment.number} 的分镜草案尚未逐镜核对`);
    issues.push(...validateSubshots(beat, segment).map(item => `片段 ${segment.number}：${item}`));
    if (project?.videoModel?.modelId) {
      const known = knownVideoCapabilities(project.videoModel.modelId);
      const fixed = known?.fixedDurationSec || project.videoModel.capabilities?.fixedDurationSec;
      const maximum = known?.maxDurationSec || project.videoModel.capabilities?.maxDurationSec;
      if (fixed && segment.durationSec !== fixed)
        issues.push(`片段 ${segment.number} 为 ${segment.durationSec} 秒，所选模型固定 ${fixed} 秒；请调整分段或换模型，不得填空镜`);
      else if (maximum && segment.durationSec > maximum)
        issues.push(`片段 ${segment.number} 超过所选视频模型 ${maximum} 秒上限`);
    }
    const storyboard = composeStoryboard(episode, segment), importText = composeImport(episode, segment);
    const prompt = selectedArtifact(segment, 'prompt');
    issues.push(...selectedPromptContractIssues(episode, segment, project).map(issue => `片段 ${segment.number}：${issue}`));
    for (const item of protectedLines(beat)) {
      if (!storyboard.includes(item) || !importText.includes(item) || !prompt?.content?.includes(item))
        issues.push(`片段 ${segment.number} 在正式分镜、导入版或最终提示词中缺少：${item}`);
    }
    if (!prompt || prompt.sourceHash !== contentHash(episode, segment)) issues.push(`片段 ${segment.number} 的最终提示词缺失或来源已变化`);
    if (segment.shotContractVersion === 2 && prompt?.content) for (const [shotIndex, shot] of subshotsFor(beat, segment).entries())
      for (const text of [shot.location, shot.priorState, shot.result, shot.endFrame])
        if (text && !prompt.content.includes(text))
          issues.push(`片段 ${segment.number} 子镜 ${shotIndex + 1} 的场景、结果或末帧未写入最终提示词`);
    if (segment.shotContractVersion === 2 && prompt?.content &&
      !prompt.content.slice(0, 400).includes('【最高约束】'))
      issues.push(`片段 ${segment.number} 的防乱演核心约束未置于提示词开头`);
    const anchor = selectedArtifact(segment, 'anchor');
    if (anchor?.content && /<text\b/i.test(anchor.content)) issues.push(`片段 ${segment.number} 的动作锚点板含可读文字`);
    if (project) {
      try {
        const references = segmentReferences(project, episode, segment);
        for (const ref of references)
          if (!ref.mediaPath) issues.push(`片段 ${segment.number} 的资产“${ref.name}”缺少对应状态参考图`);
        const videoRefs = videoReferences(project, episode, segment);
        for (const ref of references.filter(item => requiresPortraitReference(item)))
          if (!videoRefs.some(item => item.assetId === ref.assetId && item.referenceLayout === 'three-view-portrait'))
            issues.push(`片段 ${segment.number} 的人物“${ref.name}”缺少当前剧情状态的完整四视图＋大头照`);
        if (segment.shotContractVersion === 2) {
          const bound = new Set(references.map(ref => ref.assetId));
          const used = new Set(subshotsFor(beat, segment).flatMap(shot => shot.assetIds || []));
          for (const assetId of used) if (!bound.has(assetId))
            issues.push(`片段 ${segment.number} 的子镜引用了未绑定资产`);
          for (const ref of references) if (!used.has(ref.assetId))
            issues.push(`片段 ${segment.number} 绑定了未在任何子镜使用的资产“${ref.name}”`);
          // HUD/identity labels can name an absent relative or a prop-based role
          // (e.g. “账页证人”). They are not evidence that the object is in frame.
          const text = [beat.event, beat.reaction, ...beat.dialogue, ...beat.os, segment.visualPlan,
            ...subshotsFor(beat, segment).flatMap(shot => [shot.location || '', shot.action])].join('\n');
          const sceneText = [beat.event, beat.reaction, ...subshotsFor(beat, segment).map(shot => shot.location || '')].join('\n');
          const normalizedScene = (value:string) => value.replace(/[\s·]/gu, '');
          const coveredQualifiedScene = (asset:{id:string;kind:AssetKind;name:string}) => asset.kind==='scene' && (project.assets || []).some(other =>
            other.kind==='scene' && bound.has(other.id) && other.name!==asset.name && other.name.includes(asset.name) &&
            normalizedScene(sceneText).includes(normalizedScene(other.name)));
          const propText = [beat.event,beat.reaction,...subshotsFor(beat,segment).map(shot=>shot.action)].join('\n');
          const coveredQualifiedProp = (asset:{id:string;kind:AssetKind;name:string}) => asset.kind==='prop' && !used.has(asset.id) &&
            !['另一份','另一个','另一张','额外一份','第二份'].some(prefix=>propText.includes(prefix+asset.name)) && (project.assets || []).some(other =>
              other.kind==='prop' && bound.has(other.id) && other.name!==asset.name && other.name.includes(asset.name) && propText.includes(other.name));
          for (const asset of project.assets || []) if (text.includes(asset.name) && !bound.has(asset.id) && !validMentionOnly(segment,beat,asset) && !onlyTextualAssetMention(beat,segment,asset) && !coveredQualifiedScene(asset) && !coveredQualifiedProp(asset))
            issues.push(`片段 ${segment.number} 的正式剧情出现“${asset.name}”却未绑定参考资产`);
          for (const [index, shot] of subshotsFor(beat, segment).entries()) {
            const scene = references.find(ref => ref.kind === 'scene' && ref.name === shot.location);
            if (scene && !(shot.assetIds || []).includes(scene.assetId))
              issues.push(`片段 ${segment.number} 子镜 ${index + 1} 缺少对应场景参考图`);
          }
        }
      } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  return issues;
}

export function approvalHash(episode: Episode): string {
  return digest({ source: sourceHash(episode), highlight: highlightHash(episode), script: scriptHash(episode),
    segments: episode.segments.map(segment => ({ id: segment.id, hash: contentHash(episode, segment),
      prompt: { id: selectedArtifact(segment, 'prompt')?.id, content: selectedArtifact(segment, 'prompt')?.content } })) });
}

export function sampleGateHash(project: Project, episode: Episode): string {
  return digest({ approval: approvalHash(episode), videoModel: project.videoModel || null,
    aspectRatio: project.aspectRatio || '16:9' });
}

export function shouldIncludePreview(mode: ProjectMode, episode: Episode, firstEpisodeNumber = 1): boolean {
  return episode.previewOverride ?? (mode === 'douyin-story' || episode.number === firstEpisodeNumber);
}
