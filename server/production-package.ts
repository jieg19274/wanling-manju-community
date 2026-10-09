import { beatFor } from '../shared/model.js';
import {referenceHashes} from './reference-provenance.js';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { approvalHash, auditEpisode, composeImport, composeStoryboard, minimumSpokenDuration, segmentReferences, videoReferences, subshotsFor,
  selectedArtifact } from '../shared/model.js';
import { dataDir, getProject } from './store.js';
import { mediaPath } from './media.js';
import { safeName } from './export.js';
import { preparedVideoPrompt } from './video-prompt.js';

export function exportProductionPackage(projectId: string, episodeId: string) {
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  if (!episode) throw new Error('分集不存在');
  const issues = auditEpisode(episode, project);
  if (issues.length || episode.auditApprovedHash !== approvalHash(episode))
    throw new Error(`正式生产包须先完成五层无损核对：${issues.slice(0, 3).join('；') || '待人工放行'}`);
  const prepared = new Map(episode.segments.map(segment => [segment.id, preparedVideoPrompt(project, episode, segment)]));
  for (const segment of episode.segments) for (const ref of videoReferences(project, episode, segment)) {
    if (!ref.mediaPath || !existsSync(mediaPath(ref.mediaPath)))
      throw new Error(`片段 ${segment.number} 的资产“${ref.name}”参考图文件丢失`);
  }
  const folder = path.join(dataDir, 'production-packages',
    safeName(`${project.name}_EP${episode.number}_${Date.now()}`));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, '原文高光报告.txt'), episode.highlightReport);
  writeFileSync(path.join(folder, '正式剧本.json'), JSON.stringify({ version: episode.scriptVersion,
    beats: episode.scriptBeats }, null, 2));
  const manifest: object[] = [];
  for (const segment of episode.segments) {
    const dir = path.join(folder, `片段${String(segment.number).padStart(3, '0')}`);
    mkdirSync(dir);
    const prompt = selectedArtifact(segment, 'prompt')!, anchor = selectedArtifact(segment, 'anchor');
    writeFileSync(path.join(dir, '正式分镜.txt'), composeStoryboard(episode, segment));
    writeFileSync(path.join(dir, '导入版.txt'), composeImport(episode, segment));
    if(segment.executionPlan)writeFileSync(path.join(dir,'特效战斗浮签执行计划.json'),JSON.stringify(segment.executionPlan,null,2));
    writeFileSync(path.join(dir, '最终视频提示词.txt'), prepared.get(segment.id)!.content);
    if (anchor?.content) writeFileSync(path.join(dir, '占位站位示意.svg'), anchor.content);
    const hashes=referenceHashes(project,episode,segment);
    const references = videoReferences(project, episode, segment).map((ref, index) => {
      if (!ref.mediaPath) throw new Error(`片段 ${segment.number} 的资产“${ref.name}”没有参考图`);
      const source = mediaPath(ref.mediaPath), filename =
        `${String(index + 1).padStart(2, '0')}_${safeName(ref.name)}${path.extname(source)}`;
      copyFileSync(source, path.join(dir, filename));
      return { kind: ref.kind, role: ref.role, referenceLayout: ref.referenceLayout, name: ref.name, state: ref.stateLabel, voice: ref.voice,
        filename, imageId:ref.imageId,fileHash:hashes.find(item=>item.imageId===ref.imageId)?.hash,
        ...(ref.referenceAcceptance ? { referenceAcceptance: ref.referenceAcceptance } : {}) };
    });
    writeFileSync(path.join(dir, '参考图顺序.json'), JSON.stringify({ references }, null, 2));
    manifest.push({ segment: segment.number, directory: path.basename(dir),
      references: references.length, promptVersion: prompt.id, promptTemplateVersion: prompt.promptTemplateVersion || 'historical',
      promptHash: prepared.get(segment.id)!.hash, promptCharacters: prepared.get(segment.id)!.characters,
      anchorVersion: anchor?.id || null });
  }
  writeFileSync(path.join(folder, '清单.json'), JSON.stringify({ project: project.name,
    episode: episode.number, aspectRatio: project.aspectRatio || '16:9',
    style: episode.visualStyle, generatedAt: new Date().toISOString(), segments: manifest }, null, 2));
  writeFileSync(path.join(folder, '00_自动验收表.md'), [
    `# ${project.name} EP${episode.number} 自动验收`,
    '', '自动检查通过：原文/报告确认、剧本版本、子镜时间轴、声音与可见文字分配、提示词来源、参考图状态。',
    '自动检查不能判断剧情是否编造、人物是否演对、声音是否说对。', '',
    '| 片段 | 原文依据 | 时长 | 子镜 | 最短可听时长估算 | 参考资产 | 提示词字符 |',
    '| --- | --- | ---: | ---: | ---: | --- | ---: |',
    ...episode.segments.map(segment => {
      const beat = beatFor(episode, segment);
      return `| ${segment.number} | ${(beat.sourceQuote || '旧版待人工追溯').replaceAll('|', '｜').slice(0, 36)} | ${segment.durationSec}s | ${subshotsFor(beat, segment).length} | ${minimumSpokenDuration(beat).toFixed(1)}s | ${segmentReferences(project, episode, segment).map(ref => ref.name).join('、') || '无'} | ${prepared.get(segment.id)!.characters} |`;
    }), '', `自动结构问题：${issues.length}`, '',
  ].join('\n'));
  writeFileSync(path.join(folder, '00_人工核对表.md'), [
    `# ${project.name} EP${episode.number} 人工核对`, '',
    `本集已于导出前通过人工放行，版本签名：${episode.auditApprovedHash}`, '',
    ...episode.segments.flatMap(segment => {
      const beat = beatFor(episode, segment);
      return [`## 片段 ${segment.number}`, '', `原文依据：${beat.sourceQuote || '旧版剧本：依据需按原文人工追溯'}`,
        `正式事件：${beat.event}`, `人物反应：${beat.reaction}`,
        '核对项：因果与原文、子镜场景/动作/结果/末帧、对白与OS原句、浮签/系统信息、资产身份与状态。', ''];
    }),
  ].join('\n'));
  return { folder, segments: episode.segments.length };
}
