import { sha256 } from './hash.js';
import { candidatePrompt } from './candidate-contract.js';

export const MODEL_PROMPT_FORMAT = 'model-ready-v1';
type Reference = { name: string; referenceAcceptance?: {
  status: string; statement: string; knownDifference: string; requiredVideoCorrection: string;
  acceptedInputHash: string; sourceFileHash: string;
} };

function fallbackBoundary(references: Reference[]) {
  const accepted = references.filter(ref => ref.referenceAcceptance);
  if (!accepted.length) return '';
  const lines = accepted.map(ref => {
    const a = ref.referenceAcceptance!;
    if (a.status !== 'accepted' || !a.statement?.trim() || !a.knownDifference?.trim() ||
      !a.requiredVideoCorrection?.trim() || !/^[a-f0-9]{64}$/.test(a.acceptedInputHash || '') ||
      !/^[a-f0-9]{64}$/.test(a.sourceFileHash || '')) throw new Error('沿用旧参考图缺少有效用户确认及状态修正说明');
    return `资产「${ref.name}」：旧图仅参考同一身份、脸、衣服、器形及未变化部分。已知差异：${a.knownDifference}。正式视频必须落实：${a.requiredVideoCorrection}`;
  });
  return ['【最高约束·用户确认沿用旧参考图】',
    '以下仅说明旧参考图与当前剧情状态的差异。对应变化以锁定剧本和完整视频提示词为准，不能因参考图缺项而删剧情、对白、OS、浮签或人物反应。',
    ...lines, ''].join('\n') + '\n';
}

// New tasks freeze this complete text before preview/limits/export/submission.
// Historical requests without a format marker retain the old adapter behavior.
export function videoPromptWithAcceptedFallbacks(task: {
  prompt?: string; references?: Reference[]; promptFormat?: string; promptHash?: string;
}) {
  const prompt = String(task.prompt || ''), boundary = fallbackBoundary(task.references || []);
  const afterPriority = prompt.startsWith('【最高约束】') ? prompt.slice(prompt.indexOf('\n') + 1) : '';
  if (task.promptFormat !== undefined) {
    if (task.promptFormat !== MODEL_PROMPT_FORMAT || task.promptHash !== sha256(prompt) ||
      (boundary && !prompt.startsWith(boundary) && !afterPriority.startsWith(boundary))) throw new Error('完整提交提示词哈希或参考修正不一致；未提交');
    return prompt;
  }
  return boundary + prompt;
}

export function buildVideoPrompt(prompt: string, references: Reference[] = [], feedback?: string) {
  const base = candidatePrompt(prompt, feedback), boundary = fallbackBoundary(references), end = base.indexOf('\n');
  const content = boundary && base.startsWith('【最高约束】') && end >= 0 ?
    base.slice(0, end + 1) + boundary + base.slice(end + 1) : boundary + base;
  return { content, hash: sha256(content), characters: [...content].length, format: MODEL_PROMPT_FORMAT };
}
