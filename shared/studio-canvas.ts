import { beatFor, selectedArtifact, type Project, type Episode, type Artifact } from './model.js';
import { effectiveState } from './asset-state.js';
import { isCharacterSheet, requiresPortraitReference } from './asset-references.js';

export type CanvasPoint = { x: number; y: number; width?: number; height?: number };
export type StudioNode = {
  id: string; type: 'source' | 'asset' | 'shot' | 'video' | 'anchor' | 'note';
  title: string; position: { x: number; y: number }; width: number; height: number;
  content: string; media?: string; tags: string[]; status?: string; selected?: boolean;
  segmentId?: string; artifactId?: string; assetId?: string; stateId?: string; role?: string; imageId?: string;
  local?: boolean; fontSize?: number;
};
export type StudioConnection = { id: string; fromNodeId: string; toNodeId: string; kind: string };
export const canvasMediaUrl = (file: string) => `/media/${file.split('/').map(encodeURIComponent).join('/')}`;
export const videoState = (item: Artifact) => item.userAcceptance?.status === 'accepted' ? '验收通过' :
  item.review?.status === 'approved' ? '审片通过' : item.review?.status === 'rejected' ? '已判废' : '待审片';

export function validCanvasPoint(value: unknown): value is CanvasPoint {
  if (!value || typeof value !== 'object') return false;
  const p = value as CanvasPoint;
  return Number.isFinite(p.x) && Number.isFinite(p.y) &&
    (p.width === undefined || Number.isFinite(p.width) && p.width >= 160) &&
    (p.height === undefined || Number.isFinite(p.height) && p.height >= 100);
}

// A display projection only. Locked story, prompts, bindings and selected versions remain authoritative.
export function studioCanvas(project: Project, episode: Episode, selectedSegmentId: string, includedAssetIds: string[] = []) {
  const nodes: StudioNode[] = [], connections: StudioConnection[] = [];
  const selected = episode.segments.find(s => s.id === selectedSegmentId) || episode.segments[0];
  const link = (from: string, to: string, kind: string) => connections.push({
    id: `${kind}:${from}:${to}`, fromNodeId: from, toNodeId: to, kind,
  });
  const sourceId = `source:${episode.id}`;
  nodes.push({ id: sourceId, type: 'source', title: '正式剧本', position: { x: 40, y: 160 },
    width: 290, height: 300, content: episode.scriptBeats.map(b => [b.event, b.reaction,
      ...b.dialogue, ...b.os.map(t => `内心 OS：${t}`), ...b.floatLabels, ...b.systemPanels].filter(Boolean).join('\n')).join('\n\n'),
    tags: [`EP ${episode.number}`, `${episode.segments.length} 个片段`, episode.scriptLockedHash ? '已锁定' : '待锁定'] });
  const episodeAssetIds = new Set([...episode.segments.flatMap(s => [
    ...(s.assetBindings || []).map(b => b.assetId), ...(s.subshots || []).flatMap(shot => shot.assetIds || []),
  ]), ...includedAssetIds]);
  const storyText = [...episode.scriptBeats.flatMap(b => [b.event, b.reaction, ...b.dialogue, ...b.os, ...b.floatLabels, ...b.systemPanels]),
    ...episode.segments.flatMap(s => [s.visualPlan, ...(s.subshots || []).flatMap(shot => [shot.location, shot.action, shot.priorState, shot.result, shot.endFrame])])]
    .filter(Boolean).join('\n');
  for (const asset of project.assets || []) if (asset.name.trim() && storyText.includes(asset.name.trim())) episodeAssetIds.add(asset.id);
  const episodeAssets = (project.assets || []).filter(asset => episodeAssetIds.has(asset.id));
  for (const [index, asset] of episodeAssets.entries()) {
    const binding = selected?.assetBindings?.find(b => b.assetId === asset.id);
    const state = effectiveState(asset, episode, selected || { number: 1 }, binding?.stateId);
    const roles = requiresPortraitReference(asset) ? ['turnaround'] : ['main'];
    for (const [roleIndex, role] of roles.entries()) {
      const selectedId = binding?.imageId;
      const explicit = asset.images.find(i => i.id === selectedId);
      const stateId = explicit?.stateId || state?.id || '';
      const images = asset.images.filter(i => (i.role || 'main') === role && (i.stateId || '') === stateId);
      const image = explicit || images.at(-1);
      const nodeId = `asset:${asset.id}:${role}`;
      nodes.push({ id: nodeId, type: 'asset', title: `${asset.name} · ${role === 'turnaround' ? (image && !isCharacterSheet(image) ? '历史参考（需更新四视图）' : '完整四视图＋大头照') : ({character:'人物',scene:'场景',prop:'道具'})[asset.kind]}`,
        position: { x: 400 + roleIndex * 305, y: 80 + index * 360 }, width: 275, height: 310,
        assetId: asset.id, stateId, role, imageId: image?.id, segmentId: selected?.id,
        content: [asset.identity, state?.appearance, asset.voice && `声线：${asset.voice}`].filter(Boolean).join('\n'),
        media: image?.mediaPath ? canvasMediaUrl(image.mediaPath) : undefined,
        tags: [state?.label || '基础状态', `${images.length} 个版本`, binding ? explicit ? '当前选用' : '已绑定' : '未绑定当前片段'],
        status: image ? image.review?.status || 'pending' : 'missing' });
    }
  }
  const rowHeight = episode.segments.some(s => s.selected.anchor) ? 620 : 410;
  episode.segments.forEach((segment, row) => {
    const beat = beatFor(episode, segment), shotId = `shot:${segment.id}`, y = 80 + row * rowHeight;
    const prompt = selectedArtifact(segment, 'prompt');
    const candidate = !prompt ? segment.artifacts.filter(a => a.kind === 'prompt' && !a.promptArchive).at(-1) : undefined;
    const displayedPrompt = prompt || candidate;
    nodes.push({ id: shotId, type: 'shot', title: `片段 ${String(segment.number).padStart(2, '0')} · 分镜与提示词`,
      position: { x: 1050, y }, width: 330, height: 340, segmentId: segment.id, artifactId: displayedPrompt?.id,
      content: [beat.event, `人物反应：${beat.reaction}`, ...beat.dialogue, ...beat.os.map(t => `内心 OS：${t}`),
        ...beat.floatLabels.map(t => `浮签：${t}`), ...beat.systemPanels.map(t => `系统信息：${t}`),
        displayedPrompt?.content && `\n【${prompt ? '完整视频提示词' : '候选提示词（未选用）'}】\n${displayedPrompt.content}`].filter(Boolean).join('\n'),
      tags: [`${segment.durationSec} 秒`, `${segment.subshots?.length || 0} 个子镜`, prompt ? '提示词就绪' : candidate ? '候选提示词·未选用' : '待提示词'],
      status: prompt ? 'ready' : candidate ? 'candidate' : 'missing' });
    link(sourceId, shotId, 'story');
    // Every segment retains its own asset relationships, even when another segment is selected.
    for (const binding of segment.assetBindings || []) {
      for (const assetNode of nodes.filter(n => n.type === 'asset' && n.assetId === binding.assetId)) link(assetNode.id, shotId, 'reference');
    }
    const anchor = segment.artifacts.find(a => a.kind === 'anchor' && a.id === segment.selected.anchor);
    if (anchor) {
      const anchorId = `anchor:${segment.id}`;
      nodes.push({ id: anchorId, type: 'anchor', title: `片段 ${segment.number} · 无字动作建议板`,
        position: { x: 1050, y: y + 365 }, width: 330, height: 160, segmentId: segment.id,
        content: '核对站位、动作方向与末帧', media: anchor.content ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(anchor.content)}` : undefined,
        tags: ['可选', '内部视觉核对'] });
      link(shotId, anchorId, 'anchor');
    }
    const videos = segment.artifacts.filter(a => a.kind === 'video');
    if (!videos.length) {
      const nodeId = `video:pending:${segment.id}`;
      nodes.push({ id: nodeId, type: 'video', title: `片段 ${String(segment.number).padStart(2, '0')} · 待生成视频`,
        position: { x: 1480, y }, width: 325, height: 310, segmentId: segment.id,
        content: prompt ? '核对最终提示词和参考图后，确认输入与费用，再生成本片段视频。' : candidate ? '已有提示词候选；在左侧分镜节点打开提示词管理，核对并选用后再生成视频。' : '先在左侧分镜节点生成提示词，再核对本集内容与参考图，最后确认生成视频。',
        status: 'missing', tags: ['待生成', `${segment.durationSec} 秒`, prompt ? '提示词就绪' : candidate ? '先核对并选用提示词' : '先生成提示词'] });
      link(shotId, nodeId, 'planned');
    }
    const selectedIndex = videos.findIndex(v => v.id === segment.selected.video);
    videos.forEach((video, index) => {
      const nodeId = `video:${video.id}`;
      const slot = index === selectedIndex ? 0 : selectedIndex < 0 ? index : index < selectedIndex ? index + 1 : index;
      nodes.push({ id: nodeId, type: 'video', title: `片段 ${String(segment.number).padStart(2, '0')} · 视频 v${index + 1}`,
        position: { x: 1480 + slot * 365, y }, width: 325, height: 310, segmentId: segment.id, artifactId: video.id,
        media: video.mediaPath ? canvasMediaUrl(video.mediaPath) : undefined, content: video.review?.notes || '',
        selected: segment.selected.video === video.id, status: video.review?.status || 'pending',
        tags: [videoState(video), video.modelName || video.modelId || '本地素材', segment.selected.video === video.id ? '当前选用' : '保留版本'] });
      link(shotId, nodeId, segment.selected.video === video.id ? 'chosen' : 'version');
    });
  });
  return { nodes, connections };
}

export function canvasConnectionAction(nodes: StudioNode[], source: string, target: string) {
  const from = nodes.find(n => n.id === source), to = nodes.find(n => n.id === target);
  if (from?.type === 'shot' && to?.type === 'video' && to.artifactId && to.status !== 'rejected' && from.segmentId === to.segmentId)
    return { segmentId: from.segmentId!, artifactId: to.artifactId! };
  return null;
}
