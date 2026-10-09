import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usableVideo } from '../shared/generation.js';
import {adapterTimeout,terminateChild} from './process-contract.js';
import {verifyReferenceProvenance} from './reference-provenance.js';
import { expectedResolution, validateGeneratedMedia } from '../shared/media-contract.js';
import { digest, beatFor, subshotsFor } from '../shared/model.js';
import { finalPlaybackChecks } from '../shared/execution-plan.js';
import { speechChecklist, validateSpeechEvidence } from '../shared/speech-contract.js';
import { approvalHash, auditEpisode, contentHash, selectedArtifact, shouldIncludePreview, type Artifact, type Episode, type Project } from '../shared/model.js';
import { dataDir, getProject } from './store.js';
import { mediaPath, mediaRoot, relativeMedia, probe } from './media.js';
import { renderMp4 } from './mp4-render.js';
import { configuredUpscaleTool } from './upscale-settings.js';

type ExportOptions = { upscale?: boolean; onlyBelow1080?: boolean; editingDraft?: boolean; useProductionSettings?:boolean; installedDestination?: boolean; nameSuffix?:string; artifactIds?: Record<string,string> };
type TimelineClip = { file: string; sourceStartUs: number; durationUs: number; mediaDurationUs: number; speed: number; width: number;
  height: number; hasAudio: boolean; segmentId: string; preview: boolean };
const uid = () => randomUUID().toUpperCase();
let exportRunning = false;

export function installedDraftIndexRoot(): string {
  return path.resolve(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
}

export function installedDraftsRoot(): string {
  return path.resolve(process.env.MANJU_JIANYING_INSTALLED_DRAFTS_DIR || installedDraftIndexRoot());
}

export function draftsRoot(): string {
  return path.resolve(process.env.MANJU_JIANYING_DRAFTS_DIR || installedDraftsRoot());
}

export function safeName(value: string): string {
  const name = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90);
  return name && !/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(name) ? name : '漫剧草稿';
}

export function upscaleAdapter(): string | undefined {
  if (process.env.MANJU_UPSCALE_ADAPTER) return process.env.MANJU_UPSCALE_ADAPTER;
  if (configuredUpscaleTool()) return path.join(process.cwd(), 'adapters', 'upscale-external.mjs');
  if (!process.env.MANJU_REALESRGAN_DIR) return undefined;
  const bundled = path.join(process.cwd(), 'adapters', 'upscale-realesrgan.mjs');
  const toolRoot = path.resolve(process.env.MANJU_REALESRGAN_DIR);
  return [bundled, path.join(toolRoot, 'realesrgan-ncnn-vulkan.exe'),
    path.join(toolRoot, 'models', 'realesr-animevideov3-x2.bin'),
    path.join(toolRoot, 'models', 'realesr-animevideov3-x2.param')].every(existsSync) ? bundled : undefined;
}

async function runAdapter(script: string, request: object, output: string): Promise<void> {
  const requestPath = `${output}.json`;
  writeFileSync(requestPath, JSON.stringify({ ...request, outputPath: output }, null, 2));
  const executable = path.resolve(script);
  const command = /\.(?:mjs|cjs|js)$/i.test(executable) ? process.execPath : executable;
  const args = command === process.execPath ? [executable, requestPath, output] : [requestPath, output];
  try { await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { terminateChild(child); reject(new Error('超分适配器超时，结果未发布')); }, adapterTimeout(40 * 60_000));
    let error = '';
    child.stderr.on('data', chunk => error = (error + chunk.toString()).slice(-1500));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`超分适配器失败：${error.slice(-500)}`)); });
  }); } finally { if (existsSync(requestPath)) rmSync(requestPath); }
}

export async function upscaleIfNeeded(file: string, enabled: boolean, onlyBelow1080: boolean): Promise<string> {
  if (!enabled) return file;
  const source = await probe(file);
  if (onlyBelow1080 && Math.min(source.width, source.height) >= 1080) return file;
  const adapter = upscaleAdapter();
  if (!adapter) throw new Error('已选择超分，但尚未配置真实 2 倍超分适配器');
  const sourceDigest = createHash('sha256');
  for await (const chunk of createReadStream(file)) sourceDigest.update(chunk);
  const toolRoot = path.resolve(process.env.MANJU_REALESRGAN_DIR || '.');
  const external = !process.env.MANJU_UPSCALE_ADAPTER ? configuredUpscaleTool() : undefined;
  const resources = [adapter, path.join(toolRoot, 'realesrgan-ncnn-vulkan.exe'),
    path.join(toolRoot, 'models', 'realesr-animevideov3-x2.bin'),
    path.join(toolRoot, 'models', 'realesr-animevideov3-x2.param')].map(file => {
      try { const item = statSync(file); return [file, item.size, item.mtimeMs]; } catch { return [file, 'missing']; }
    });
  const key = createHash('sha256').update(JSON.stringify({ source: sourceDigest.digest('hex'), resources, external:external?.resources })).digest('hex');
  const folder = path.join(dataDir, 'upscaled');
  mkdirSync(folder, { recursive: true });
  const output = path.join(folder, `${key}.mp4`);
  if (existsSync(output)) {
    try { const found = await probe(output); if (found.width >= source.width * 2 && found.height >= source.height * 2
      && Math.abs(found.width/found.height-source.width/source.height)<=0.02 && Math.abs(found.duration - source.duration) <= 0.15 && (!source.hasAudio || found.hasAudio)) return output; } catch { /* invalid cache is regenerated */ }
    renameSync(output, path.join(folder, `${key}.invalid-${uid()}.mp4`));
  }
  const temp = path.join(folder, `${key}.${uid()}.tmp.mp4`);
  await runAdapter(adapter, { sourcePath: file, scale: 2, preserveOriginalAudio: true, toolDirectory:external?.root }, temp);
  const result = await probe(temp);
  if (result.width < source.width * 2 || result.height < source.height * 2 || Math.abs(result.width/result.height-source.width/source.height)>0.02 || Math.abs(result.duration - source.duration) > 0.15 || (source.hasAudio && !result.hasAudio))
    throw new Error('超分结果未保持时长、画幅、2倍分辨率或原声');
  renameSync(temp, output);
  return output;
}

function reviewIssue(artifact: Artifact, file: string, label: string): string | undefined {
  if (artifact.demo) return `${label}是技术演示视频`;
  if (!existsSync(file)) return `${label}文件丢失`;
  const stat = statSync(file);
  if (!artifact.technical?.inspectedAt || artifact.technical.size !== stat.size ||
    artifact.technical.modifiedAt !== stat.mtimeMs) return `${label}尚未完成当前文件的技术检查`;
  if (artifact.review?.status !== 'approved') return `${label}尚未人工审片通过`;
  return undefined;
}

export async function preflightEpisode(project: Project, episode: Episode) {
  const issues = auditEpisode(episode, project);
  const warnings: string[] = [];
  if (!episode.segments.length || episode.auditApprovedHash !== approvalHash(episode))
    issues.push('五层无损核对尚未人工放行');
  for (const segment of [...episode.segments].sort((a, b) => a.number - b.number)) {
    const selected = selectedArtifact(segment, 'video');
    const beat = beatFor(episode,segment);
    const playback=finalPlaybackChecks(beat,segment,subshotsFor(beat,segment),selected);
    warnings.push(...playback.warnings.map(warning=>`片段 ${segment.number}：${warning}`));
    issues.push(...playback.issues.map(issue=>`片段 ${segment.number}：${issue}`));
    if (!selected?.mediaPath) { issues.push(`片段 ${segment.number} 尚未选定视频`); continue; }
    if (!usableVideo(project, episode, segment, selected))
      issues.push(`片段 ${segment.number} 的选中视频对应旧分镜，请重生成或重新核对`);
    try {verifyReferenceProvenance(project,episode,segment,selected);} catch(error) {issues.push(`片段 ${segment.number}：${(error as Error).message}`);}
    const file = mediaPath(selected.mediaPath), issue = reviewIssue(selected, file, `片段 ${segment.number}`);
    if (issue) issues.push(issue);
    try { validateSpeechEvidence(speechChecklist(episode, segment), selected.review?.speech, segment.durationSec); }
    catch (error) { issues.push(`片段 ${segment.number}：${(error as Error).message}`); }
    if (existsSync(file)) {
      try {
        const media = await probe(file);
        validateGeneratedMedia(media, segment.durationSec, project.aspectRatio || '16:9', Boolean(beatFor(episode, segment).dialogue.length || beatFor(episode, segment).os.length), expectedResolution(project));
        const beat = beatFor(episode,segment);
        if ((beat?.dialogue.length || beat?.os.length) && !media.hasAudio)
          issues.push(`片段 ${segment.number} 有对白或OS，但视频没有声音轨`);
      } catch { issues.push(`片段 ${segment.number} 视频文件无法读取`); }
    }
  }
  if (shouldIncludePreview(project.mode, episode, Math.min(...project.episodes.map(item => item.number)))) {
    if (episode.previewCuts?.length) {
      for (const cut of episode.previewCuts) {
        const segment = episode.segments.find(item => item.id === cut.segmentId);
        const selected = segment && selectedArtifact(segment, 'video');
        if (!selected?.mediaPath || selected.id !== cut.artifactId) {
          issues.push(`高光片段 ${segment?.number ?? '?'} 的选中视频已变化`); continue;
        }
        try {
          const media = await probe(mediaPath(selected.mediaPath));
          const length = cut.durationSec ?? media.duration - cut.startSec;
          if (cut.startSec < 0 || length <= 0 || cut.startSec + length > media.duration + 0.05)
            issues.push(`高光片段 ${segment!.number} 的时间范围超出视频时长`);
        } catch { issues.push(`高光片段 ${segment!.number} 文件无法读取`); }
      }
    } else if (episode.previewMediaPath) {
      try { await probe(mediaPath(episode.previewMediaPath)); }
      catch { issues.push('独立高光预告视频文件无法读取'); }
    } else issues.push('本集需要高光预告，请选正片片段或导入预告 MP4');
  }
  return { ready: issues.length === 0, issues, warnings };
}

async function timeline(project: Project, episode: Episode, options: ExportOptions): Promise<TimelineClip[]> {
  if (options.editingDraft) return editingTimeline(project,episode,options);
  const preflight = await preflightEpisode(project, episode);
  if (!preflight.ready) throw new Error(preflight.issues.join('；'));
  const entries: { file: string; speed: number; segmentId: string; preview: boolean;
    startSec?: number; durationSec?: number }[] = [];
  if (shouldIncludePreview(project.mode, episode, Math.min(...project.episodes.map(item => item.number)))) {
    if (episode.previewCuts?.length) {
      for (const cut of episode.previewCuts) {
        const segment = episode.segments.find(item => item.id === cut.segmentId);
        const selected = segment && selectedArtifact(segment, 'video');
        if (!selected?.mediaPath || selected.id !== cut.artifactId || selected.demo)
          throw new Error(`高光片段 ${segment?.number ?? '?'} 的视频版本已变化，请重新选定高光`);
        entries.push({ file: mediaPath(selected.mediaPath), speed: 1, segmentId: segment!.id,
          preview: true, startSec: cut.startSec, durationSec: cut.durationSec });
      }
    } else if (episode.previewMediaPath) {
      entries.push({ file: mediaPath(episode.previewMediaPath), speed: 1, segmentId: 'preview', preview: true });
    } else throw new Error('本集需要高光预告：请从已选正片中勾选高光片段，或导入预告 MP4');
  }
  for (const segment of [...episode.segments].sort((a, b) => a.number - b.number)) {
    const selected = selectedArtifact(segment, 'video');
    if (!selected?.mediaPath) throw new Error(`片段 ${segment.number} 尚未选定视频`);
    if (selected.demo) throw new Error(`片段 ${segment.number} 选中的是技术演示视频，请改选正式素材`);
    entries.push({ file: mediaPath(selected.mediaPath), speed: segment.speedOverride ?? (segment.action ? 1.5 : 1.15),
      segmentId: segment.id, preview: false });
  }
  const clips: TimelineClip[] = [];
  for (const entry of entries) {
    if (!existsSync(entry.file)) throw new Error(`素材丢失：${entry.segmentId}`);
    const file = await upscaleIfNeeded(entry.file, options.upscale === true, options.onlyBelow1080 === true);
    const media = await probe(file);
    const startSec = entry.startSec ?? 0;
    const durationSec = entry.durationSec ?? media.duration - startSec;
    if (startSec < 0 || durationSec <= 0 || startSec + durationSec > media.duration + 0.05)
      throw new Error(`高光片段 ${entry.segmentId} 超出选中视频时长（${media.duration.toFixed(2)} 秒）`);
    if (!entry.preview) {
      const segment = episode.segments.find(item => item.id === entry.segmentId)!;
      const beat = beatFor(episode,segment);
      if ((beat.dialogue.length || beat.os.length) && !media.hasAudio)
        throw new Error(`片段 ${segment.number} 有对白或OS，但选中视频没有声音轨`);
    }
    clips.push({ file, sourceStartUs: Math.round(startSec * 1e6),
      durationUs: Math.round(durationSec * 1e6), mediaDurationUs: Math.round(media.duration * 1e6),
      speed: entry.speed, width: media.width, height: media.height, hasAudio: media.hasAudio,
      segmentId: entry.segmentId, preview: entry.preview });
  }
  return clips;
}

// Explicit editing output is not a production approval. It never changes adopted
// versions, review history or speech evidence, and retains all preflight warnings.
export function editingSelection(episode:Episode, artifactIds:Record<string,string>={}) {
  if(Object.keys(artifactIds).some(id=>!episode.segments.some(s=>s.id===id)))throw new Error('Unknown editing segment selection');
  return [...episode.segments].sort((a,b)=>a.number-b.number).map(segment=>{
    const artifactId=artifactIds[segment.id]||segment.selected.video;
    const video=segment.artifacts.find(a=>a.id===artifactId&&a.kind==='video');
    if(!video?.mediaPath||video.demo||video.userAcceptance?.status==='withdrawn'||video.review?.status==='rejected'&&video.userAcceptance?.status!=='accepted')throw new Error(`Segment ${segment.number}: explicitly select a real, non-rejected editing candidate`);
    if(segment.selected.video&&artifactId!==segment.selected.video)throw new Error('Editing export must retain the adopted version');
    return {segment,video};
  });
}
async function editingTimeline(project:Project,episode:Episode,options:ExportOptions):Promise<TimelineClip[]> {
  if(!episode.segments.length)throw new Error('No editing segments');
  const clips:TimelineClip[]=[];
  for(const {segment,video} of editingSelection(episode,options.artifactIds)) {
    let file=mediaPath(video.mediaPath!);if(!existsSync(file))throw new Error('Editing media missing');
    const original=await probe(file),beat=beatFor(episode,segment);
    validateGeneratedMedia(original,segment.durationSec,project.aspectRatio||'16:9',Boolean(beat.dialogue.length||beat.os.length),expectedResolution(project));
    if(options.useProductionSettings)file=await upscaleIfNeeded(file,options.upscale===true,options.onlyBelow1080===true);
    const media=await probe(file);
    validateGeneratedMedia(media,segment.durationSec,project.aspectRatio||'16:9',Boolean(beat.dialogue.length||beat.os.length));
    clips.push({file,sourceStartUs:0,durationUs:Math.round(media.duration*1e6),mediaDurationUs:Math.round(media.duration*1e6),speed:options.useProductionSettings?(segment.speedOverride??(segment.action?1.5:1.15)):1,width:media.width,height:media.height,hasAudio:media.hasAudio,segmentId:segment.id,preview:false});
  }
  return clips;
}

function draftFiles(name: string, target: string, clips: TimelineClip[]) {
  const videos: object[] = [], speeds: object[] = [], segments: object[] = [], materials: object[] = [];
  let cursor = 0;
  for (const clip of clips) {
    const materialId = uid(), speedId = uid(), file = clip.file.replace(/\\/g, '/');
    videos.push({ id: materialId, type: 'video', path: file, material_name: path.basename(file),
      duration: clip.mediaDurationUs, width: clip.width, height: clip.height, has_audio: clip.hasAudio,
      check_flag: 0, local_material_id: '', material_id: '', crop_ratio: 'free', crop_scale: 1,
      crop: { lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1,
        upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0 },
      source_platform: 0, category_id: '', category_name: 'local', extra_type_option: 0,
      matting: { flag: 0, has_use_quick_brush: false, interactiveTime: [], path: '', strokes: [] },
      video_algorithm: { algorithms: [], deflicker: null, motion_blur_config: null, noise_reduction: null, path: '', time_range: null } });
    materials.push({ id: materialId, path: file, type: 'video' });
    speeds.push({ id: speedId, type: 'speed', mode: 0, speed: clip.speed, curve_speed: null });
    const length = Math.max(1, Math.round(clip.durationUs / clip.speed));
    segments.push({ id: uid(), material_id: materialId,
      source_timerange: { start: clip.sourceStartUs, duration: clip.durationUs }, target_timerange: { start: cursor, duration: length },
      speed: clip.speed, volume: 1, last_nonzero_volume: 1, visible: true, reverse: false, is_tone_modify: false,
      clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0,
        scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
      extra_material_refs: [speedId], keyframe_refs: [], render_index: 0, track_render_index: 0, track_attribute: 0,
      enable_adjust: true, enable_color_curves: true, enable_color_wheels: true, enable_lut: true,
      enable_smart_color_adjust: false, is_placeholder: false, cartoon: false, group_id: '', template_id: '' });
    cursor += length;
  }
  const draftId = uid(), stamp = Date.now(), normalized = target.replace(/\\/g, '/');
  const draft = { id: draftId, name, duration: cursor, max_time: cursor, fps: 30,
    canvas_config: { width: clips[0].width, height: clips[0].height, ratio: 'original' }, color_space: 0,
    config: { fps: 30, maintrack_adsorb: true, original_sound_last_index: 1, video_mute: false },
    materials: { videos, audios: [], texts: [], speeds, transitions: [], effects: [] },
    tracks: [{ id: uid(), type: 'video', attribute: 0, flag: 0, segments }],
    version: '80000002', new_version: '8.2.0.15985', platform: 'pc', type: 'EDIT',
    extra_info: { adapter: 'PC', platform: 'JianyingPro' }, revision: 0, save_ts: stamp };
  const meta = { draft_id: draftId, draft_name: name, draft_fold_path: normalized, draft_root_path: normalized,
    draft_removed: false, draft_type: 1, draft_materials: materials,
    draft_timeline_materials_size_: 0, tm_duration: cursor, tm_draft_create: stamp * 1000,
    tm_draft_modified: stamp * 1000, draft_timestamp: stamp };
  return { draft, meta, manifest: { source: '万灵漫剧', portable: true, effectsApplied: false, subtitlesAdded: false, createdAt: new Date().toISOString(),
    clips: clips.map(clip => ({ segmentId: clip.segmentId, preview: clip.preview, source: clip.file,
      speed: clip.speed, sourceStartSeconds: clip.sourceStartUs / 1e6,
      durationSeconds: clip.durationUs / 1e6, relativePath: path.relative(target, clip.file).replace(/\\/g,'/') })) } };
}

function ensureJianyingClosed(root=draftsRoot()): void {
  if (process.platform !== 'win32') return;
  if (root.toLowerCase() !== installedDraftsRoot().toLowerCase()) return;
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq JianyingPro.exe', '/NH'],
    { encoding: 'utf8', windowsHide: true });
  if (result.status === 0 && /JianyingPro\.exe/i.test(result.stdout))
    throw new Error('请先退出剪映，再写入草稿目录；已生成视频和超分结果仍保留');
}

export async function exportEpisode(projectId: string, episodeId: string, options: ExportOptions = {}) {
  if (exportRunning) throw new Error('已有草稿导出在进行，请稍后重试');
  exportRunning = true;
  try {
    const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
    if (!episode) throw new Error('分集不存在');
    const exportFingerprint=(p:Project)=>options.editingDraft?digest({name:p.name,aspectRatio:p.aspectRatio,videoModel:p.videoModel,episode:p.episodes.find(e=>e.id===episodeId)}):digest(p);
    const frozen = exportFingerprint(project);
    const root = options.installedDestination ? installedDraftsRoot() : draftsRoot();
    ensureJianyingClosed(root);
    if (exportFingerprint(getProject(projectId)) !== frozen) throw new Error('导出期间项目已变化，请重新检查后导出');
    const clips = await timeline(project, episode, options);
    ensureJianyingClosed(root);
    if (exportFingerprint(getProject(projectId)) !== frozen) throw new Error('导出期间项目已变化，请重新检查后导出');
    mkdirSync(root, { recursive: true });
    const name = safeName(`${project.name} EP${episode.number}${options.nameSuffix ? '_'+safeName(options.nameSuffix).slice(0,20) : ''}_${Date.now()}_${uid().slice(0, 6)}`);
    const target = path.join(root, name);
    if (existsSync(target)) throw new Error('草稿目录已存在，未覆盖');
    // Some compressed Jianying draft folders on Windows reject a directory rename
    // despite allowing file creation. Jianying is closed for the full write.
    mkdirSync(target);
    const mediaFolder = path.join(target, 'media'); mkdirSync(mediaFolder);
    const portable = clips.map((clip, index) => {
      const file = path.join(mediaFolder, `${String(index + 1).padStart(3,'0')}.mp4`);
      copyFileSync(clip.file, file); return { ...clip, file };
    });
    const files = draftFiles(name, target, portable);
    Object.assign(files.manifest, { generationInputs: episode.segments.map(segment => {
      const video = options.editingDraft ? editingSelection(episode,options.artifactIds).find(x=>x.segment.id===segment.id)?.video : selectedArtifact(segment,'video');
      return {segmentId: segment.id, artifactId: video?.id, generationHash: video?.generationHash, referenceHashes: video?.referenceHashes,
        ...(video?.labelRepair?{labelRepair:video.labelRepair}:{}),...(segment.executionPlan?{executionPlan:segment.executionPlan}:{})};
    }) });
    if(options.editingDraft)Object.assign(files.manifest,{purpose:'editing-draft',productionApproved:false,originalSpeed:!options.useProductionSettings,exportSettings:{upscale:options.useProductionSettings&&options.upscale===true,onlyBelow1080:options.onlyBelow1080===true,useProductionSettings:options.useProductionSettings===true},reviewWarnings:(await preflightEpisode(project,episode)).issues,acceptance:editingSelection(episode,options.artifactIds).map(({segment,video})=>({segmentId:segment.id,artifactId:video.id,userAcceptance:video.userAcceptance?.status||'pending',independentSpeechEvidence:video.review?.speech||null}))});
    writeFileSync(path.join(target, 'README_素材迁移.txt'), '此草稿已自带media素材。移动草稿目录后运行 node scripts/relocate-draft.mjs 新目录，重新定位路径。原声保留；未加入后期对白/OS字幕；特效描述由视频模型执行，非剪映原生特效。');
    writeFileSync(path.join(target, 'draft_meta_info.json'), JSON.stringify(files.meta), { flag: 'wx' });
    writeFileSync(path.join(target, 'manju_manifest.json'), JSON.stringify(files.manifest, null, 2), { flag: 'wx' });
    writeFileSync(path.join(target, 'draft_content.json.bak'), JSON.stringify(files.draft), { flag: 'wx' });
    writeFileSync(path.join(target, 'draft_content.json'), JSON.stringify(files.draft), { flag: 'wx' });
    if(options.installedDestination){
      // Jianying keeps its registry in LOCALAPPDATA even when its draft storage
      // is configured on another drive. Media and metadata must use the actual target.
      const indexFile=path.join(installedDraftIndexRoot(),'root_meta_info.json');
      if(!existsSync(indexFile))throw new Error('Draft files saved; installed draft index missing, registration not attempted');
      const original=readFileSync(indexFile,'utf8'),index=JSON.parse(original);
      if(!Array.isArray(index.all_draft_store)||!(Array.isArray(index.draft_ids)||Number.isSafeInteger(index.draft_ids)))throw new Error('Draft files saved; unsupported installed index structure');
      ensureJianyingClosed(root);
      copyFileSync(indexFile,path.join(target,'root_meta_info.before-export.json'));
      index.all_draft_store.push({...files.meta,draft_root_path:root.replace(/\\/g,'/'),draft_json_file:path.join(target,'draft_content.json').replace(/\\/g,'/'),draft_is_invisible:false,draft_new_version:files.draft.new_version,tm_draft_removed:0});
      if(Array.isArray(index.draft_ids))index.draft_ids.push(files.draft.id);else index.draft_ids+=1;
      if(readFileSync(indexFile,'utf8')!==original)throw new Error('Draft files saved; installed index changed concurrently, no overwrite');
      const temp=path.join(path.dirname(indexFile),'manju-index-'+uid()+'.tmp');writeFileSync(temp,JSON.stringify(index),{flag:'wx'});renameSync(temp,indexFile);
    }
    return { draftDir: target, clips: clips.length, durationSeconds: files.draft.duration / 1e6,
      previewIncluded: clips[0].preview, upscaled: options.upscale === true };
  } finally { exportRunning = false; }
}

export async function exportEpisodeMp4(projectId: string, episodeId: string, options: ExportOptions = {}) {
  if (options.editingDraft) throw new Error('MP4 成片须通过正式导出预检');
  if (exportRunning) throw new Error('已有导出在进行，请稍后重试');
  exportRunning = true;
  const workDir = path.join(dataDir, 'mp4-work', uid());
  try {
    const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
    if (!episode) throw new Error('分集不存在');
    const frozen = digest(project);
    const clips = await timeline(project, episode, options);
    const sourceStats = clips.map(clip => { const s = statSync(clip.file); return { size: s.size, mtime: s.mtimeMs }; });
    const rendered = await renderMp4(clips, workDir);
    const checked = await preflightEpisode(project, episode);
    if (!checked.ready) throw new Error(checked.issues.join('；'));
    if (digest(getProject(projectId)) !== frozen) throw new Error('合成期间项目已变化，请重新检查后导出');
    clips.forEach((clip, i) => {
      const s = statSync(clip.file);
      if (s.size !== sourceStats[i].size || s.mtimeMs !== sourceStats[i].mtime) throw new Error('合成期间素材已变化，未发布成片');
    });
    const folder = path.join(mediaRoot, 'exports'); mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, `${safeName(project.name)}_EP${episode.number}_${Date.now()}_${uid().slice(0, 8)}.mp4`);
    if (existsSync(filePath)) throw new Error('成片文件已存在，未覆盖');
    const manifest = { format: 'mp4', projectId, episodeId, projectHash: frozen, createdAt: new Date().toISOString(),
      originalAudioPreserved: true, subtitlesAdded: false, effectsApplied: false,
      width: rendered.width, height: rendered.height, durationSeconds: rendered.duration,
      clips: clips.map(clip => ({ ...clip, sourceStartSeconds: clip.sourceStartUs / 1e6, durationSeconds: clip.durationUs / 1e6 })),
      generationInputs: episode.segments.map(segment => { const video = selectedArtifact(segment, 'video');
        return { segmentId: segment.id, artifactId: video?.id, generationHash: video?.generationHash, referenceHashes: video?.referenceHashes }; }) };
    writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    renameSync(path.join(workDir, 'manifest.json'), filePath + '.json');
    renameSync(rendered.file, filePath);
    const relative = relativeMedia(filePath);
    return { filePath, mediaPath: relative, url: '/media/' + relative.split('/').map(encodeURIComponent).join('/'),
      clips: clips.length, durationSeconds: rendered.duration, width: rendered.width, height: rendered.height,
      previewIncluded: clips[0].preview };
  } finally {
    exportRunning = false;
    // The UUID directory is created under our fixed work root, never a user path.
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function exportProject(projectId: string, options: ExportOptions = {}) {
  const project = getProject(projectId);
  const results: { episode: number; title: string; draftDir?: string; error?: string }[] = [];
  for (const episode of [...project.episodes].sort((a, b) => a.number - b.number)) {
    try {
      const result = await exportEpisode(projectId, episode.id, options);
      results.push({ episode: episode.number, title: episode.title, draftDir: result.draftDir });
    } catch (error) {
      results.push({ episode: episode.number, title: episode.title,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, completed: results.filter(item => item.draftDir).length, failed: results.filter(item => item.error).length };
}
