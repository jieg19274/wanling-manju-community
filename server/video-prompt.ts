import { selectedArtifact, selectedPromptContractIssues, videoReferences, knownVideoCapabilities,
  type Project, type Episode, type Segment } from '../shared/model.js';
import { buildVideoPrompt } from '../shared/video-prompt.js';

export function preparedVideoPrompt(project: Project, episode: Episode, segment: Segment, feedback?: string) {
  const issues = selectedPromptContractIssues(episode, segment, project);
  if (issues.length) throw new Error(issues.join('；'));
  const prepared = buildVideoPrompt(selectedArtifact(segment, 'prompt')!.content!, videoReferences(project, episode, segment), feedback);
  const capabilities = { ...knownVideoCapabilities(project.videoModel?.modelId || ''), ...project.videoModel?.capabilities };
  if (capabilities.maxPromptChars && prepared.characters > capabilities.maxPromptChars)
    throw new Error(`片段 ${segment.number} 的完整提交提示词 ${prepared.characters} 字超过模型 ${capabilities.maxPromptChars} 字上限；请调整视觉偏好或拆分片段，不得删减正式剧情`);
  return prepared;
}
