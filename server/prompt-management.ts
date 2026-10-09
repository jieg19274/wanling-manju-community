import { beatFor, contentHash, id, now, scriptHash, selectedPromptContractIssues,
  type Artifact, type Episode, type Project, type Segment } from '../shared/model.js';

type Entry = { segmentId?: unknown; artifactId?: unknown; content?: unknown; expectedPromptId?: unknown };
type Operation = 'archive' | 'restore' | 'unselect' | 'select' | 'replace';

export function prepareWrittenPrompt(project: Project, episode: Episode, segment: Segment, text: unknown): Artifact {
  if (episode.scriptLockedHash !== scriptHash(episode)) throw Error('请先锁定正式剧本');
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content || content.length > 200000) throw Error('最终提示词为空或过长');
  const beat = beatFor(episode, segment);
  const protectedText = [beat.event, beat.reaction, ...beat.dialogue, ...beat.os, ...beat.floatLabels, ...beat.systemPanels,
    ...(segment.subshots || []).flatMap(shot => [shot.action, shot.location, shot.priorState, shot.result, shot.endFrame])].filter(Boolean) as string[];
  if (protectedText.some(value => !content.includes(value))) throw Error('提示词遗漏正式剧情、声音、可见信息或逐镜状态；不能写入');
  const artifact: Artifact = { id: id(), kind: 'prompt', createdAt: now(), sourceHash: contentHash(episode, segment), content };
  const trial = { ...segment, artifacts: [...segment.artifacts, artifact], selected: { ...segment.selected, prompt: artifact.id } };
  const issues = selectedPromptContractIssues(episode, trial, project);
  if (issues.length) throw Error(issues.join('；'));
  return artifact;
}

export function installWrittenPrompt(episode: Episode, segment: Segment, artifact: Artifact, archivePrevious = false) {
  const previous = segment.artifacts.find(item => item.id === segment.selected.prompt && item.kind === 'prompt');
  if (archivePrevious && previous && previous.id !== artifact.id && !previous.promptArchive)
    previous.promptArchive = { archivedAt: now(), reason: '用户写入并选用新版，停用原选版' };
  segment.artifacts.push(artifact);
  segment.selected.prompt = artifact.id;
  delete segment.promptSelectionPaused;
  episode.auditApprovedHash = undefined;
}

export function managePrompts(project: Project, episode: Episode, input: Record<string, unknown>) {
  const operation = String(input.operation || '') as Operation;
  if (!['archive', 'restore', 'unselect', 'select', 'replace'].includes(operation)) throw Error('未知提示词管理操作');
  const entries = input.entries as Entry[];
  if (!Array.isArray(entries) || !entries.length || entries.length > 2000) throw Error('请提供1至2000项明确的提示词管理目标');
  const unique = new Set<string>(), segments = new Set<string>();
  const targets = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw Error('提示词管理目标无效');
    const segment = episode.segments.find(item => item.id === entry.segmentId);
    if (!segment) throw Error('片段不存在或不属于当前分集');
    if (['select', 'replace', 'unselect'].includes(operation) && segments.has(segment.id)) throw Error('同一片段一次只能选用或写入一个版本');
    segments.add(segment.id);
    if (Object.hasOwn(entry, 'expectedPromptId') && (entry.expectedPromptId ?? null) !== (segment.selected.prompt ?? null))
      throw Error('提示词选用状态已变化，请刷新后重新核对');
    if (operation === 'replace') return { segment, artifact: prepareWrittenPrompt(project, episode, segment, entry.content) };
    const artifact = segment.artifacts.find(item => item.id === entry.artifactId && item.kind === 'prompt');
    if (!artifact) throw Error('提示词版本不存在');
    const key = `${segment.id}:${artifact.id}`;
    if (unique.has(key)) throw Error('提示词管理目标重复');
    unique.add(key);
    if (operation === 'unselect' && segment.selected.prompt && segment.selected.prompt !== artifact.id)
      throw Error('当前选版已变化，不能取消另一版本');
    if (operation === 'select') {
      if (artifact.promptArchive) throw Error('已停用提示词不能选用，请先恢复并重新核对');
      const issues = selectedPromptContractIssues(episode, { ...segment, selected: { ...segment.selected, prompt: artifact.id } }, project);
      if (issues.length) throw Error(issues.join('；'));
    }
    return { segment, artifact };
  });
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : '用户清理停用旧版提示词';
  if (reason.length > 2000) throw Error('停用说明过长');
  // Validate the entire batch before mutating even one segment.
  for (const { segment, artifact } of targets) {
    if (operation === 'replace') { installWrittenPrompt(episode, segment, artifact, input.archivePrevious === true); continue; }
    if (operation === 'restore') { delete artifact.promptArchive; continue; }
    if (operation === 'select') {
      const previous = segment.artifacts.find(item => item.id === segment.selected.prompt && item.kind === 'prompt');
      if (input.archivePrevious === true && previous && previous.id !== artifact.id && !previous.promptArchive)
        previous.promptArchive = { archivedAt: now(), reason: '用户换选新版，停用原选版' };
      if (segment.selected.prompt !== artifact.id) episode.auditApprovedHash = undefined;
      segment.selected.prompt = artifact.id;
      delete segment.promptSelectionPaused;
      continue;
    }
    if (operation === 'archive' && !artifact.promptArchive) artifact.promptArchive = { archivedAt: now(), reason };
    if (operation === 'unselect' || segment.selected.prompt === artifact.id) {
      if (segment.selected.prompt) { delete segment.selected.prompt; episode.auditApprovedHash = undefined; }
      segment.promptSelectionPaused = true;
    }
  }
}
