import { approvalHash, contentHash, selectedPromptContractIssues, type Artifact, type Episode, type Project, type Segment } from '../shared/model.js';

export function promptVersionStatus(project: Project, episode: Episode, segment: Segment, artifact: Artifact) {
  if (artifact.promptArchive) return '已停用 · 仅保留历史来源，恢复后才可选用';
  if (artifact.sourceHash !== contentHash(episode, segment)) return '正式来源已变化，请核对本片段';
  const trial = { ...segment, selected: { ...segment.selected, prompt: artifact.id } };
  if (selectedPromptContractIssues(episode, trial, project).length) return '存在内容或镜头结构问题，需修正';
  return artifact.id === segment.selected.prompt ? episode.auditApprovedHash === approvalHash(episode) ?
    '已选 · 五层核对已放行' : '已选 · 结构检查通过，待人工核对' : '结构检查通过，待比较选用';
}
