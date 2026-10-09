import { highlightHash, requireScriptReady, scriptHash, sourceHash, type Episode } from './model.js';

export interface ScriptReadiness {
  episodeId: string; number: number; title: string;
  state: 'locked' | 'source' | 'highlight' | 'script' | 'ready';
  hasExistingScript: boolean; scriptHash: string;
  label: string; message: string; tab: 'source' | 'script';
  missing: string[];
}

// Inspect saved drafts without changing them or granting a historical review.
export function scriptReadiness(episode: Episode): ScriptReadiness {
  const base = { episodeId: episode.id, number: episode.number, title: episode.title,
    hasExistingScript: episode.scriptBeats.length > 0, scriptHash: scriptHash(episode) };
  if (episode.scriptLockedHash === base.scriptHash)
    return { ...base, state: 'locked', label: '正式剧本已锁定', message: '继续使用已有正式剧本；下游核对仍按当前内容执行。', tab: 'script', missing: [] };
  const missing: string[] = [];
  if (episode.sourceText.trim().length < 50) missing.push('完整原文章节');
  else if (episode.sourceReviewedHash !== sourceHash(episode)) missing.push('完整原文阅读确认');
  if (!episode.highlightReport.trim()) missing.push('原文高光剧情报告');
  else if (episode.highlightReviewedHash !== highlightHash(episode)) missing.push('高光报告核对');
  const preserve = base.hasExistingScript ? '保留已有剧本，补齐核对后继续锁稿。' : '';
  if (missing.some(item => item.startsWith('完整原文')))
    return { ...base, state: 'source', label: '补齐原文阅读核对', message: preserve + '完整读取本集原文并记录阅读范围；不能用旧剧本或剧情摘要代替原文。', tab: 'source', missing };
  if (missing.length)
    return { ...base, state: 'highlight', label: '补齐高光核对', message: preserve + '可导入已有高光报告，或由接手 Agent 依据完整原文写报告并核对；如用软件文本模型生成，须有本次额度。', tab: 'source', missing };
  try { requireScriptReady({ ...episode, sourceTraceRequired: true }); }
  catch (error) {
    return { ...base, state: 'script', label: base.hasExistingScript ? '核对已有剧本依据' : '准备正式剧本',
      message: (base.hasExistingScript ? '保留已有事件、对白、OS、人物反应及浮签，逐项处理：' : '') + (error as Error).message,
      tab: 'script', missing: [(error as Error).message] };
  }
  return { ...base, state: 'ready', label: '核对并锁定已有剧本', message: '原文与高光记录已齐备；逐项比对剧情和声音后，可使用现有锁稿动作。锁稿仍检查分段与模型时长。', tab: 'script', missing: [] };
}
