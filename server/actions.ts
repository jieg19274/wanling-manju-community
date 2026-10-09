import { usableVideo, invalidateAsset, assetInputHash, assetDependencies, invalidateChangedAssets } from '../shared/generation.js';
import { expectedResolution, validateGeneratedMedia } from '../shared/media-contract.js';
import { speechChecklist, validateSpeechEvidence } from '../shared/speech-contract.js';
import {declaredCapabilities} from '../shared/provider-capabilities.js';
import {verifyReferenceProvenance} from './reference-provenance.js';
import { applySegmentation, automaticSegmentGroups, orderedSpeech,segmentPlanHash,validateSegmentPlan } from '../shared/segmentation.js';
import { recordStoryReview, boundaryHash, highlightItems,recordContinuityReview } from '../shared/story-review.js';
import { existsSync, statSync, readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import { approvalHash, auditEpisode, beatFor, defaultSubshots, highlightHash, id, knownVideoCapabilities, lockScript, makeBeat, makeEpisode, minimumSpokenDuration, modelSegmentDuration, now, sampleGateHash, scriptHash, storyboardSourceHash, validateSubshots,validMentionOnly,
  sourceHash, contentHash, selectedPromptContractIssues, type AssetKind, type Episode, type ModelKind, type Project, type ProjectMode, type ScriptBeat, type Segment } from '../shared/model.js';
import { catalogVersion, checkedEffectEvidence, effectVersion, suggestEffects, visualDescription } from './effects.js';
import { executionPlanIssues, validateLabelStyle, type ExecutionPlan } from '../shared/execution-plan.js';
import { subshotsFor } from '../shared/model.js';
import { planEpisodes, planChapterGroups } from '../shared/episode-plan.js';
import { productionRules } from '../shared/production-rules.js';
import { MAX_SOURCE_CHARACTERS } from '../shared/source-limits.js';
import { digest } from '../shared/model.js';
import { stylePreset } from '../shared/style-presets.js';
import { mediaPath } from './media.js';
import {isCharacterSheet,requiresPortraitReference} from '../shared/asset-references.js';
import { installWrittenPrompt, managePrompts, prepareWrittenPrompt } from './prompt-management.js';

type Action = Record<string, unknown> & { type: string };
const str = (value: unknown) => String(value ?? '').trim();
const array = (value: unknown) => Array.isArray(value) ? value.map(str).filter(Boolean) : [];

function episodeOf(project: Project, id: string): Episode {
  const episode = project.episodes.find(item => item.id === id);
  if (!episode) throw new Error('分集不存在');
  return episode;
}

function segmentOf(episode: Episode, id: string): Segment {
  const segment = episode.segments.find(item => item.id === id);
  if (!segment) throw new Error('片段不存在');
  return segment;
}

function legacyAutoSubshots(segment: Segment, beat: ScriptBeat): boolean {
  const shots = segment.subshots || [];
  return segment.subshotsAuto == null && shots.length === 2 &&
    shots[0].action === beat.event && shots[1].action === beat.reaction &&
    shots[0].startSec === 0 && shots[0].endSec === segment.durationSec / 2 &&
    shots[1].startSec === segment.durationSec / 2 && shots[1].endSec === segment.durationSec;
}

function unlocked(episode: Episode): void {
  if (episode.scriptLockedHash) throw new Error('正式剧本已锁定；需要改剧情时请先建立新版本');
}

function invalidateAssets(project: Project): void { invalidateAsset(project); }

export function applyAction(project: Project, action: Action): void {
  if (project.archivedAt && action.type !== 'project.restore') throw new Error('项目已移入回收区，请先恢复');
  const episodeId = str(action.episodeId);
  const episode = episodeId && action.type !== 'episode.restore' ? episodeOf(project, episodeId) : undefined;
  switch (action.type) {
    case 'project.rename': {
      const name=str(action.name);if(!name||name.length>100)throw Error('项目名称须为1–100字');
      project.name=name;break;
    }
    case 'project.productionRules': {
      if (project.episodes.length || project.archivedEpisodes?.length) throw Error('已有分集，制作规则请用于新项目');
      project.productionRules = productionRules({ ...project.productionRules, ...action.rules as object });
      project.episodePlan = undefined;
      return;
    }
    case 'project.planChapterGroups': {
      if (project.mode !== 'standard' || project.episodes.length || project.archivedEpisodes?.length)
        throw Error('当前项目不能重新分集');
      project.episodePlan = planChapterGroups(project.sourceCorpus || '', action.chapterEnds, project.productionRules);
      return;
    }
    case 'episode.storyReview': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      recordStoryReview(episode, action.entries); return;
    }
    case 'episode.continuityReview': {
      if(!episode) throw new Error('分集不存在');
      recordContinuityReview(episode,action.entries);return;
    }
    case 'episode.segmentPlan': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      if (episode.segments.some(segment => segment.artifacts.length)) throw new Error('已有生成版本，请先建立新剧本版本再调整分段计划');
      applySegmentation(episode, action.groups);
      return;
    }
    case 'episode.applySegmentCandidate': {
      const candidate=episode?.segmentPlanCandidate;
      if(!episode || !candidate || candidate.hash!==segmentPlanHash(episode) || episode.segments.some(segment=>segment.artifacts.length))throw new Error('分段候选过期或已有生成版本');
      const checked=validateSegmentPlan(episode,candidate.groups,candidate.budgets);
      if(checked.warnings.length)throw new Error('候选内容预算不足，须重新规划；不能以确认按钮绕过30秒内容要求');
      applySegmentation(episode,checked.groups);return;
    }
    case 'project.archive': {
      project.archivedAt = now();
      return;
    }
    case 'project.restore': {
      project.archivedAt = undefined;
      return;
    }
    case 'project.mode': {
      if (action.mode !== 'standard' && action.mode !== 'douyin-story') throw new Error('未知项目类型');
      project.mode = action.mode as ProjectMode;
      return;
    }
    case 'project.aspectRatio': {
      if (!['16:9', '9:16', '1:1'].includes(str(action.aspectRatio))) throw new Error('未知项目画幅');
      if (project.aspectRatio !== action.aspectRatio) {
        project.aspectRatio = action.aspectRatio as Project['aspectRatio'];
        invalidateAssets(project);
      }
      return;
    }
    case 'asset.imageReview': {
      const asset = project.assets?.find(item => item.id === str(action.assetId));
      const image = asset?.images.find(item => item.id === str(action.imageId));
      if (!asset || !image) throw new Error('图片版本不存在');
      const status = str(action.status);
      if (!['approved', 'rejected'].includes(status)) throw new Error('审图状态无效');
      const input = (action.checks || {}) as Record<string, unknown>;
      const checks = { identity: input.identity === true, state: input.state === true, shape: input.shape === true, clothing: input.clothing === true };
      const layout = action.layout === undefined ? image.layout : str(action.layout);
      if (layout !== undefined && (layout !== 'three-view-portrait' || asset.kind !== 'character' || image.role !== 'turnaround'))
        throw new Error('完整四视图布局只能用于带正面、侧面、背面和大头照的人物设定图');
      if (status === 'approved' && Object.values(checks).some(value => !value)) throw new Error('请逐项核对身份、状态、形态与服饰');
      const currentInputHash=assetInputHash(project, asset.id, image.stateId);
      if (status==='approved' && image.inputHash && image.inputHash !== currentInputHash) throw new Error('图片对应旧资产描述，请重新生成或上传');
      if (status==='approved' || !image.inputHash) image.inputHash = currentInputHash;
      const fileHash=status==='approved' ? createHash('sha256').update(readFileSync(mediaPath(image.mediaPath))).digest('hex') : image.fileHash;
      if (image.review?.status === status && image.fileHash===fileHash && image.layout===layout && JSON.stringify(image.review.checks) === JSON.stringify(checks)) return;
      image.layout = layout as typeof image.layout;
      image.fileHash=fileHash;
      image.review = { status: status as 'approved' | 'rejected', checks, reviewedAt: now() };
      invalidateAsset(project, asset.id, image.id);
      return;
    }
    case 'asset.add': {
      const kind = str(action.kind) as AssetKind, name = str(action.name);
      if (!['character', 'scene', 'prop'].includes(kind) || !name || name.length > 80)
        throw new Error('请选择资产类型并填写名称（最多 80 字）');
      project.assets ??= [];
      if (project.assets.some(item => item.kind === kind && item.name === name)) throw new Error('同类资产名称已存在');
      project.assets.push({ id: id(), kind, name, identity: str(action.identity),
        voice: kind === 'character' ? str(action.voice) : '', states: [], images: [] });
      return;
    }
    case 'episode.applyAssetCandidate': {
      const dependencies = assetDependencies(project);
      if (!episode?.scriptLockedHash || episode.scriptLockedHash !== scriptHash(episode))
        throw new Error('请先锁定正式剧本');
      const candidate = episode.assetCandidate;
      if (!candidate || candidate.scriptHash !== episode.scriptLockedHash)
        throw new Error('资产建议已过期，请重新提取');
      project.assets ??= [];
      for (const entry of candidate.entries) {
        let asset = project.assets.find(item => item.kind === entry.kind && item.name === entry.name);
        if (!asset) {
          asset = { id: id(), kind: entry.kind, name: entry.name, identity: entry.identity,
            voice: entry.kind === 'character' ? entry.voice || '' : '', states: [], images: [] };
          project.assets.push(asset);
        }
        if (entry.state && !asset.states.some(state => state.label === entry.state!.label &&
          state.startEpisode === episode.number && state.startSegment === entry.state!.startSegment))
          asset.states.push({ id: id(), label: entry.state.label, appearance: entry.state.appearance,
            trigger: entry.state.trigger, startEpisode: episode.number,
            startSegment: entry.state.startSegment });
      }
      for (const segment of episode.segments) {
        const beat = beatFor(episode, segment);
        const text = [beat.event, beat.reaction, ...beat.dialogue, ...beat.os,
          ...beat.floatLabels, ...beat.systemPanels, segment.visualPlan].join('\n');
        const bound = new Set((segment.assetBindings || []).map(item => item.assetId));
        for (const asset of project.assets) if (text.includes(asset.name) && !bound.has(asset.id)) {
          (segment.assetBindings ||= []).push({ assetId: asset.id });
          bound.add(asset.id);
        }
        segment.subshotCandidate = undefined;
        if (segment.shotContractVersion === 2) segment.subshotsReviewed = false;
      }
      episode.assetCandidate = undefined;
      invalidateChangedAssets(project, dependencies);
      return;
    }
    case 'asset.update': {
      const asset = project.assets?.find(item => item.id === str(action.assetId));
      if (!asset) throw new Error('资产不存在');
      const name = str(action.name), identity = str(action.identity), voice = str(action.voice);
      if (!name || name.length > 80 || identity.length > 2000 || voice.length > 300) throw new Error('资产描述无效或过长');
      if (project.assets!.some(item => item.id !== asset.id && item.kind === asset.kind && item.name === name))
        throw new Error('同类资产名称已存在');
      asset.name = name; asset.identity = identity; asset.voice = asset.kind === 'character' ? voice : '';
      invalidateAsset(project, asset.id);
      return;
    }
    case 'asset.state': {
      const dependencies = assetDependencies(project);
      const asset = project.assets?.find(item => item.id === str(action.assetId));
      if (!asset) throw new Error('资产不存在');
      const startEpisode = Number(action.startEpisode), startSegment = Number(action.startSegment);
      const label = str(action.label), appearance = str(action.appearance), trigger = str(action.trigger);
      const target = project.episodes.find(item => item.number === startEpisode)?.segments
        .find(item => item.number === startSegment);
      if (!target || !label || !appearance || label.length > 80 || appearance.length > 2000)
        throw new Error('资产状态需要有效的起始片段、名称与外观描述');
      if (trigger) {
        const ep = project.episodes.find(item => item.number === startEpisode)!;
        const beat = beatFor(ep, target);
        if (!(beat.event + '\n' + beat.reaction).includes(trigger))
          throw new Error('状态触发依据须逐字来自正式事件或人物反应');
      }
      const existing = asset.states.find(item => item.id === str(action.stateId));
      if (existing) Object.assign(existing, { label, appearance, trigger, startEpisode, startSegment });
      else asset.states.push({ id: id(), label, appearance, trigger, startEpisode, startSegment });
      invalidateChangedAssets(project, dependencies);
      return;
    }
    case 'segment.assets': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId));
      if (!Array.isArray(action.bindings) || action.bindings.length > 30) throw new Error('片段资产绑定无效');
      const seen = new Set<string>();
      const bindings = action.bindings.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('片段资产格式无效');
        const input = value as Record<string, unknown>;
        const assetId = str(input.assetId), stateId = str(input.stateId), imageId = str(input.imageId), portraitImageId = str(input.portraitImageId);
        const asset = project.assets?.find(item => item.id === assetId);
        if (!asset || seen.has(assetId)) throw new Error('资产不存在或重复绑定');
        seen.add(assetId);
        if (stateId && !asset.states.some(item => item.id === stateId)) throw new Error('资产状态不存在');
        if (imageId && !asset.images.some(item => item.id === imageId && item.role !== 'portrait'))
          throw new Error('片段主图不能选择头部特写');
        if (portraitImageId && !asset.images.some(item => item.id === portraitImageId && item.role === 'portrait')) throw new Error('头图版本不存在');
        const integrated = asset.kind === 'character' && isCharacterSheet(asset.images.find(item => item.id === imageId));
        const old = segment.assetBindings?.find(item => item.assetId === assetId);
        const unchangedHistory = old && old.imageId === (imageId || undefined) && (old.stateId || '') === stateId && (old.portraitImageId || '') === portraitImageId;
        if(requiresPortraitReference(asset) && !integrated && (imageId || portraitImageId) && !unchangedHistory)
          throw new Error('人物绑定只接受完整四视图＋大头照；独立全身照与头图已退出制作流程');
        let priorReference: {imageId:string;untilSec:number;sourceEvidence:string}|undefined;
        if(input.priorReference!==undefined){
          const prior=input.priorReference as Record<string,unknown>,priorImage=asset.images.find(item=>item.id===str(prior?.imageId));
          const untilSec=Number(prior?.untilSec),sourceEvidence=str(prior?.sourceEvidence),beat=beatFor(episode,segment);
          if(!integrated||!priorImage||!isCharacterSheet(priorImage)||priorImage.id===imageId||priorImage.review?.status!=='approved'||
            priorImage.inputHash!==assetInputHash(project,asset.id,priorImage.stateId)||!Number.isFinite(untilSec)||untilSec<=0||untilSec>=segment.durationSec||
            sourceEvidence.length<4||!(beat.event+'\n'+beat.reaction).includes(sourceEvidence))throw new Error('段内变化前参考须有锁定事件依据、有效时窗和同角色已审完整四视图');
          priorReference={imageId:priorImage.id,untilSec,sourceEvidence};
        }
        return { assetId, ...(stateId ? { stateId } : {}), ...(imageId ? { imageId } : {}), ...(portraitImageId && !integrated ? { portraitImageId } : {}),...(priorReference?{priorReference}:{}) };
      });
      if(JSON.stringify(bindings)===JSON.stringify(segment.assetBindings || []))return;
      segment.assetBindings=bindings;
      segment.subshotCandidate = undefined;
      if (segment.shotContractVersion === 2) segment.subshotsReviewed = false;
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'episode.autoBindAssets': {
      if (!episode?.scriptLockedHash) throw new Error('请先锁定正式剧本');
      for (const segment of episode.segments) {
        const beat = beatFor(episode, segment);
        const text = [beat.event, beat.reaction, ...beat.dialogue, ...beat.os, ...beat.floatLabels,
          ...beat.systemPanels, segment.visualPlan, ...(segment.subshots || []).flatMap(shot =>
            [shot.location || '', shot.action])].join('\n');
        const existing = new Set((segment.assetBindings || []).map(item => item.assetId));
        for (const asset of project.assets || []) {
          if (text.includes(asset.name) && !existing.has(asset.id))
            (segment.assetBindings ||= []).push({ assetId: asset.id });
        }
        segment.subshotCandidate = undefined;
        if (segment.shotContractVersion === 2) segment.subshotsReviewed = false;
      }
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'project.style': {
      const name = str(action.name), description = str(action.description), presetId = str(action.presetId);
      if (name.length > 80 || description.length > 2000) throw new Error('风格名称或视觉描述过长');
      if (presetId && !stylePreset(presetId)) throw new Error('未知 3D 风格预设');
      const style = { name, description, ...(presetId ? { presetId } : {}) };
      if (JSON.stringify(project.visualStyle || { name: '', description: '' }) === JSON.stringify(style)) return;
      project.visualStyle = style;
      for (const item of [...project.episodes, ...(project.archivedEpisodes || [])]) {
        item.visualStyle = structuredClone(style);
        item.auditApprovedHash = undefined;
        for (const segment of item.segments) segment.selected = {};
      }
      return;
    }
    case 'project.model': {
      const kind = (str(action.kind) || 'video') as ModelKind;
      if (!['text', 'image', 'video'].includes(kind)) throw new Error('未知模型类型');
      const name = str(action.name), modelId = str(action.modelId), adapterPath = str(action.adapterPath);
      if (name.length > 100 || modelId.length > 160 || adapterPath.length > 1000)
        throw new Error('模型设置过长');
      if (adapterPath && (!path.isAbsolute(adapterPath) || !/\.(?:mjs|cjs|js|exe)$/i.test(adapterPath)
        || !existsSync(adapterPath) || !statSync(adapterPath).isFile()))
        throw new Error('适配器路径须指向本机存在的 .mjs、.cjs、.js 或 .exe 文件');
      const previous = project[`${kind}Model`];
      let capabilities = previous?.modelId === modelId ? previous.capabilities :
        kind === 'video' ? knownVideoCapabilities(modelId) : undefined;
      if (kind === 'video' && action.capabilities && typeof action.capabilities === 'object') {
        const input = action.capabilities as Record<string, unknown>;
        const minDurationSec = input.minDurationSec === '' || input.minDurationSec == null ? undefined : Number(input.minDurationSec);
        const outputResolution = str(input.outputResolution);
        const resolutions = Array.isArray(input.resolutions) ? input.resolutions.map(str) : [];
        const maxDurationSec = input.maxDurationSec === '' || input.maxDurationSec == null ? undefined : Number(input.maxDurationSec);
        const fixedDurationSec = input.fixedDurationSec === '' || input.fixedDurationSec == null ? undefined : Number(input.fixedDurationSec);
        const maxReferences = input.maxReferences === '' || input.maxReferences == null ? undefined : Number(input.maxReferences);
        const maxPromptChars = input.maxPromptChars === '' || input.maxPromptChars == null ? undefined : Number(input.maxPromptChars);
        const aspectRatios = Array.isArray(input.aspectRatios) ? input.aspectRatios.map(str) : [];
        if ((minDurationSec !== undefined && (!Number.isFinite(minDurationSec) || minDurationSec < 1 || minDurationSec > 1800 || (maxDurationSec !== undefined && minDurationSec > maxDurationSec))) ||
          (outputResolution && (!/^\d{2,5}x\d{2,5}$/u.test(outputResolution) || (resolutions.length > 0 && !resolutions.includes(outputResolution)))) || resolutions.some(value => !/^\d{2,5}x\d{2,5}$/u.test(value)) ||
          (maxDurationSec !== undefined && (!Number.isFinite(maxDurationSec) || maxDurationSec < 1 || maxDurationSec > 1800)) ||
          (fixedDurationSec !== undefined && (!Number.isFinite(fixedDurationSec) || fixedDurationSec < 1 || fixedDurationSec > 1800 ||
            (maxDurationSec !== undefined && fixedDurationSec > maxDurationSec))) ||
          (maxReferences !== undefined && (!Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 100)) ||
          (maxPromptChars !== undefined && (!Number.isInteger(maxPromptChars) || maxPromptChars < 100 || maxPromptChars > 1000000)) ||
          aspectRatios.some(value => !['16:9', '9:16', '1:1'].includes(value))) throw new Error('视频模型能力参数无效');
        capabilities = { ...knownVideoCapabilities(modelId), ...(maxDurationSec ? { maxDurationSec } : {}),
          ...(minDurationSec ? { minDurationSec } : {}), ...(outputResolution ? { outputResolution } : {}),
          ...(resolutions.length ? { resolutions } : {}), confirmedAt: now(),
          ...(typeof input.referenceVideo === 'boolean' ? { referenceVideo: input.referenceVideo } : {}),
          ...(typeof input.referenceAudio === 'boolean' ? { referenceAudio: input.referenceAudio } : {}),
          ...(fixedDurationSec ? { fixedDurationSec } : {}), ...(maxReferences ? { maxReferences } : {}),
          ...(maxPromptChars ? { maxPromptChars } : {}),
          ...(typeof input.nativeAudio === 'boolean' ? { nativeAudio: input.nativeAudio } : {}),
          ...(aspectRatios.length ? { aspectRatios: aspectRatios as ('16:9' | '9:16' | '1:1')[] } : {}) };
      }
      project[`${kind}Model`] = { name, modelId, adapterPath, ...(capabilities ? { capabilities } : {}) };
      if(kind==='video' && action.declaredCapabilities && typeof action.declaredCapabilities==='object') {
        project.videoModel!.declaredCapabilities=declaredCapabilities(action.declaredCapabilities as Record<string,unknown>);
        project.videoModel!.catalogFetchedAt=str(action.catalogFetchedAt);
      }
      if (project.modelChecks) delete project.modelChecks[kind];
      return;
    }
    case 'episode.archive': {
      if (!episode) throw new Error('分集不存在');
      project.archivedEpisodes ??= [];
      project.archivedEpisodes.push(episode);
      project.episodes = project.episodes.filter(item => item.id !== episode.id);
      return;
    }
    case 'episode.restore': {
      const archived = project.archivedEpisodes?.find(item => item.id === episodeId);
      if (!archived) throw new Error('回收区中没有该分集');
      if (project.episodes.some(item => item.number === archived.number))
        archived.number = Math.max(0, ...project.episodes.map(item => item.number)) + 1;
      project.episodes.push(archived);
      project.episodes.sort((a, b) => a.number - b.number);
      project.archivedEpisodes = project.archivedEpisodes!.filter(item => item.id !== episodeId);
      return;
    }
    case 'episode.add': {
      if (project.mode !== 'douyin-story') throw new Error('常规漫剧请先导入完整原文并自动分集');
      const number = Math.max(0, ...[...project.episodes, ...(project.archivedEpisodes || [])].map(item => item.number)) + 1;
      project.episodes.push(makeEpisode(number, str(action.title) || `第 ${number} 集`, project.visualStyle));
      return;
    }
    case 'episode.addMany': {
      if (project.mode !== 'douyin-story') throw new Error('只有推文漫剧可以手动填写集数');
      const count = Number(action.count);
      if (!Number.isInteger(count) || count < 1 || count > 100 || project.episodes.length + count > 200)
        throw new Error('本次集数须为 1–100，项目总集数最多 200');
      for (let index = 0; index < count; index++) {
        const number = Math.max(0, ...[...project.episodes, ...(project.archivedEpisodes || [])].map(item => item.number)) + 1;
        project.episodes.push(makeEpisode(number, `第 ${number} 集`, project.visualStyle));
      }
      return;
    }
    case 'project.source': {
      if (project.mode !== 'standard') throw new Error('仅常规漫剧使用项目原文自动分集');
      if (project.episodes.length || project.archivedEpisodes?.length) throw new Error('已有分集或回收区内容，不能替换项目原文');
      const source = String(action.sourceText ?? '');
      if (source.length > MAX_SOURCE_CHARACTERS) throw new Error('原文超过单次 700 万字符限制');
      project.sourceCorpus = source;
      project.episodePlan = undefined;
      project.episodePlanProgress = undefined;
      return;
    }
    case 'project.plan': {
      if (project.mode !== 'standard' || project.episodes.length || project.archivedEpisodes?.length) throw new Error('当前项目不能重新自动分集');
      project.episodePlan = planEpisodes(project.sourceCorpus || '', Number(action.chaptersPerEpisode ?? productionRules(project.productionRules).fixedChapters));
      return;
    }
    case 'project.createEpisodes': {
      if (project.mode !== 'standard' || project.episodes.length || project.archivedEpisodes?.length) throw new Error('当前项目不能重新自动分集');
      const source = project.sourceCorpus || '', plan = project.episodePlan;
      if (!plan || plan.sourceHash !== digest(source)) throw new Error('分集建议已失效，请重新预览');
      if (plan.ranges[0]?.start !== 0 || plan.ranges.at(-1)?.end !== source.length ||
          plan.ranges.some((range, index) => range.end <= range.start ||
            (index > 0 && range.start !== plan.ranges[index - 1].end)))
        throw new Error('原文分集范围不连续，请重新预览');
      for (const [index, range] of plan.ranges.entries()) {
        const episode = makeEpisode(index + 1, range.chapters[0] || `第 ${index + 1} 集`, project.visualStyle);
        episode.sourceText = source.slice(range.start, range.end);
        episode.sourceRange = structuredClone(range);
        project.episodes.push(episode);
      }
      return;
    }
    case 'episode.update': {
      if (!episode) throw new Error('分集不存在');
      if (action.title != null) episode.title = str(action.title);
      if (action.sourceText != null) {
        unlocked(episode);
        if (episode.sourceRange) throw new Error('自动分集的原文与项目原文绑定，请在分集规划时调整章节数');
        episode.sourceText = String(action.sourceText); episode.sourceReviewedHash = undefined;
      }
      if (action.highlightReport != null) { unlocked(episode); episode.highlightReport = String(action.highlightReport); episode.highlightReviewedHash = undefined; }
      if (action.previewOverride === null || typeof action.previewOverride === 'boolean')
        episode.previewOverride = action.previewOverride ?? undefined;
      return;
    }
    case 'episode.confirmSource': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      if (episode.sourceText.trim().length < 50) throw new Error('原文过短，请完整导入拟采用章节');
      episode.sourceReviewedHash = sourceHash(episode);
      return;
    }
    case 'episode.applyHighlightCandidate': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      if (episode.sourceReviewedHash !== sourceHash(episode) ||
        episode.highlightCandidate?.sourceHash !== sourceHash(episode))
        throw new Error('原文或高光建议已变化，请重新生成');
      episode.highlightReport = episode.highlightCandidate.content;
      episode.highlightReviewedHash = undefined;
      return;
    }
    case 'episode.confirmHighlight': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      if (episode.sourceReviewedHash !== sourceHash(episode)) throw new Error('请先完整阅读并确认原文');
      if (!episode.highlightReport.trim()) throw new Error('请先填写高光剧情报告');
      episode.highlightReviewedHash = highlightHash(episode);
      episode.highlightItems=highlightItems(episode.highlightReport);
      return;
    }
    case 'beat.add': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      if (episode.highlightReviewedHash !== highlightHash(episode)) throw new Error('请先核对高光剧情报告');
      episode.scriptBeats.push(makeBeat());
      return;
    }
    case 'episode.writeScript': {
      if (!episode) throw Error('分集不存在');
      unlocked(episode);
      if (episode.highlightReviewedHash !== highlightHash(episode)) throw Error('请先核对高光剧情报告');
      if (!Array.isArray(action.beats) || !action.beats.length || action.beats.length > 500) throw Error('须提供完整剧情节点数组');
      episode.scriptBeats = action.beats.map(value => {
        if (!value || typeof value !== 'object') throw Error('剧情节点格式无效');
        const item = value as Record<string, unknown>, beat = makeBeat();
        for (const key of ['event', 'reaction', 'sourceQuote'] as const) {
          if (typeof item[key] !== 'string' || !item[key].trim()) throw Error('每个节点须写事件、人物反应与原文证据');
          beat[key] = item[key].trim();
        }
        if (!episode!.sourceText.includes(beat.sourceQuote!)) throw Error('节点原文证据未出现在完整原文中');
        for (const key of ['dialogue', 'os', 'floatLabels', 'systemPanels'] as const) {
          if (!Array.isArray(item[key]) || (item[key] as unknown[]).some(line => typeof line !== 'string')) throw Error('对白、OS、浮签及系统信息须为字符串数组');
          beat[key] = [...item[key] as string[]];
        }
        if (item.speechOrder !== undefined) beat.speechOrder = item.speechOrder as ScriptBeat['speechOrder'];
        orderedSpeech(beat);
        return beat;
      });
      episode.scriptCandidate = undefined;
      return;
    }
    case 'episode.applyScriptCandidate': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      const candidate = episode.scriptCandidate;
      if (!candidate || candidate.sourceHash !== sourceHash(episode) ||
        candidate.highlightHash !== highlightHash(episode) ||
        episode.highlightReviewedHash !== highlightHash(episode))
        throw new Error('原文或高光报告已变化，请重新生成剧本建议');
      episode.scriptBeats = structuredClone(candidate.beats);
      return;
    }
    case 'beat.update': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      const beat = episode.scriptBeats.find(item => item.id === str(action.beatId));
      if (!beat) throw new Error('剧情节点不存在');
      for (const key of ['event', 'reaction', 'sourceQuote'] as const) if (action[key] != null) beat[key] = str(action[key]);
      for (const key of ['dialogue', 'os', 'floatLabels', 'systemPanels'] as const)
        if (action[key] != null) beat[key] = array(action[key]) as ScriptBeat[typeof key];
      if (action.speechOrder != null) {
        if (!Array.isArray(action.speechOrder)) throw new Error('声音顺序须为引用数组');
        beat.speechOrder = action.speechOrder.map(ref => {
          const value = ref as Record<string, unknown>;
          if ((value.kind !== 'dialogue' && value.kind !== 'os') || !Number.isInteger(value.index)) throw new Error('无效声音引用');
          return {kind: value.kind, index: Number(value.index)};
        });
      }
      orderedSpeech(beat);
      return;
    }
    case 'beat.delete': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      episode.scriptBeats = episode.scriptBeats.filter(item => item.id !== str(action.beatId));
      return;
    }
    case 'script.lock': {
      if (!episode) throw new Error('分集不存在');
      unlocked(episode);
      episode.sourceTraceRequired = true;
      lockScript(episode);
      applySegmentation(episode, automaticSegmentGroups(episode));
      for (const segment of episode.segments) {
        segment.shotContractVersion = 2;
        const beat = beatFor(episode, segment);
        const maxDuration = knownVideoCapabilities(project.videoModel?.modelId || '')?.maxDurationSec ||
          project.videoModel?.capabilities?.maxDurationSec || 30;
        segment.durationSec = modelSegmentDuration(beat, project.videoModel);
        if (minimumSpokenDuration(beat) > segment.durationSec + 0.25)
          throw new Error(`片段 ${segment.number} 的正式对白/OS无法在当前模型最长 ${maxDuration} 秒内说完；请在锁稿前拆分剧情节点，不能删词`);
        segment.subshots = defaultSubshots(beat, segment.durationSec, segment.number);
        const matches = suggestEffects(`${beat.event}\n${beat.reaction}`);
        segment.effectIds = matches.map(item => item.id);
        segment.effectVersions = Object.fromEntries(matches.map(item => [item.id, effectVersion(item.id)]));
        segment.effectEvidence = Object.fromEntries(matches.map(item => [item.id, item.evidence]));
      }
      return;
    }
    case 'script.newVersion': {
      if (!episode?.scriptLockedHash || episode.scriptLockedHash !== scriptHash(episode))
        throw new Error('只有已锁定的正式剧本可以建立修订版');
      const version = episode.scriptVersion ?? 1;
      episode.scriptHistory ??= [];
      episode.scriptHistory.push(structuredClone({ version, archivedAt: now(),
        sourceText: episode.sourceText, sourceReviewedHash: episode.sourceReviewedHash,
        highlightReport: episode.highlightReport, highlightReviewedHash: episode.highlightReviewedHash,
        scriptBeats: episode.scriptBeats, sourceTraceRequired: episode.sourceTraceRequired,
        visualStyle: episode.visualStyle,
        scriptLockedHash: episode.scriptLockedHash,
        segments: episode.segments, auditApprovedHash: episode.auditApprovedHash,
        sampleApprovedHash: episode.sampleApprovedHash,
        previewCuts: episode.previewCuts }));
      episode.scriptVersion = version + 1;
      episode.scriptBeats = structuredClone(episode.scriptBeats);
      episode.scriptLockedHash = undefined;
      episode.segments = [];
      episode.auditApprovedHash = undefined;
      episode.sampleApprovedHash = undefined;
      episode.previewCuts = [];
      return;
    }
    case 'episode.previewCuts': {
      if (!episode) throw new Error('分集不存在');
      if (!episode.scriptLockedHash || episode.scriptLockedHash !== scriptHash(episode))
        throw new Error('请先锁定本集正式剧本');
      const raw = action.cuts;
      if (!Array.isArray(raw) || raw.length > 30) throw new Error('高光片段须为列表，最多 30 段');
      const seen = new Set<string>();
      episode.previewCuts = raw.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('高光片段格式错误');
        const input = value as Record<string, unknown>;
        const segmentId = str(input.segmentId), artifactId = str(input.artifactId);
        const segment = segmentOf(episode, segmentId);
        if (seen.has(segmentId)) throw new Error(`片段 ${segment.number} 在高光中重复`);
        seen.add(segmentId);
        if (!segment.artifacts.some(item => item.id === artifactId && item.kind === 'video' && item.mediaPath && !item.demo)
          || segment.selected.video !== artifactId) throw new Error(`片段 ${segment.number} 请先选定正式视频`);
        const startSec = Number(input.startSec);
        const durationSec = input.durationSec === '' || input.durationSec == null ? undefined : Number(input.durationSec);
        if (!Number.isFinite(startSec) || startSec < 0 || startSec > 180
          || (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 180)))
          throw new Error(`片段 ${segment.number} 的高光时间范围无效`);
        return { segmentId, artifactId, startSec, ...(durationSec === undefined ? {} : { durationSec }) };
      });
      return;
    }
    case 'segment.referenceExclude': {
      if(!episode)throw new Error('分集不存在');
      const segment=segmentOf(episode,str(action.segmentId)),imageId=str(action.imageId);
      const reason=str(action.reason),expectedScene=str(action.expectedScene),observedScene=str(action.observedScene);
      if(!reason||!expectedScene||!observedScene||[reason,expectedScene,observedScene].some(s=>s.length>800))throw new Error('需要明确参考图用途冲突和场景证据');
      if(!segment.assetBindings?.some(b=>[b.imageId,b.portraitImageId].includes(imageId)&&project.assets?.find(a=>a.id===b.assetId)?.images.some(i=>i.id===imageId)))throw new Error('只能排除本片段实际绑定的参考图');
      if(segment.referenceExclusions?.some(item=>item.imageId===imageId))return;
      (segment.referenceExclusions||=[]).push({imageId,reason,expectedScene,observedScene,createdAt:now()});
      episode.auditApprovedHash=undefined;episode.sampleApprovedHash=undefined;
      return;
    }
    case 'segment.mentionOnly': {
      if(!episode||episode.scriptLockedHash!==scriptHash(episode))throw new Error('正式剧本尚未锁定');
      const segment=segmentOf(episode,str(action.segmentId)),asset=project.assets?.find(a=>a.id===str(action.assetId));
      const declaration={assetId:str(action.assetId),sourceEvidence:str(action.sourceEvidence),reason:str(action.reason)};
      if(!asset||declaration.reason.length>800||declaration.sourceEvidence.length>800)throw new Error('提及角色信息无效');
      const trial={...segment,mentionOnlyAssets:[...(segment.mentionOnlyAssets||[]).filter(x=>x.assetId!==asset.id),declaration]};
      if(!validMentionOnly(trial,beatFor(episode,segment),asset))throw new Error('只可声明有正式依据、没有当前台词与画内引用的未绑定资产为仅被提及');
      segment.mentionOnlyAssets=trial.mentionOnlyAssets;episode.auditApprovedHash=undefined;return;
    }
    case 'segment.update': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('正式剧本尚未锁定或已变化');
      const segment = segmentOf(episode, str(action.segmentId));
      if(action.voiceOverrides!==undefined){
        if(!action.voiceOverrides||typeof action.voiceOverrides!=='object'||Array.isArray(action.voiceOverrides))throw new Error('片段声线配置无效');
        const entries=Object.entries(action.voiceOverrides as Record<string,unknown>);
        if(entries.some(([key,value])=>!segment.assetBindings?.some(b=>b.assetId===key)||typeof value!=='string'||!value.trim()||value.length>800))throw new Error('声线必须对应本段绑定资产');
        segment.voiceOverrides=Object.fromEntries(entries.map(([key,value])=>[key,str(value)]));segment.subshotsReviewed=false;episode.auditApprovedHash=undefined;
      }
      if (action.visualPlan != null && segment.visualPlan !== str(action.visualPlan)) {
        segment.visualPlan = str(action.visualPlan);
        segment.subshotsReviewed = false;
        segment.subshotCandidate = undefined;
      }
      if (action.durationSec != null) {
        const duration = Number(action.durationSec);
        if (duration !== 30) throw new Error('每个生成片段必须固定30秒；请通过分段规划承载完整剧情');
        if (duration !== segment.durationSec) {
          const beat = beatFor(episode, segment);
          if (segment.subshotsAuto === true || legacyAutoSubshots(segment, beat)) {
            segment.subshots = defaultSubshots(beat, duration, segment.number);
            segment.subshotsAuto = true;
          } else if (segment.subshots?.length) {
            const ratio = duration / segment.durationSec;
            segment.subshots = segment.subshots.map((shot, index) => ({ ...shot,
              startSec: index === 0 ? 0 : Math.round(shot.startSec * ratio * 1000) / 1000,
              endSec: index === segment.subshots!.length - 1 ? duration :
                Math.round(shot.endSec * ratio * 1000) / 1000 }));
          }
          segment.subshotsReviewed = false;
          segment.subshotCandidate = undefined;
        }
        segment.durationSec = duration;
      }
      if (typeof action.action === 'boolean') segment.action = action.action;
      if (action.speedOverride === null) segment.speedOverride = undefined;
      else if (action.speedOverride != null) {
        const speed = Number(action.speedOverride);
        if (!Number.isFinite(speed) || speed < 0.1 || speed > 4) throw new Error('倍速须在 0.1–4 之间');
        segment.speedOverride = speed;
      }
      if (action.anchorPlan && typeof action.anchorPlan === 'object') {
        const input = action.anchorPlan as Record<string, unknown>;
        const fromX = Number(input.fromX), toX = Number(input.toX), level = input.level;
        if (![fromX, toX].every(value => Number.isFinite(value) && value >= 10 && value <= 90)
          || !['wide', 'medium', 'close'].includes(String(level))) throw new Error('动作锚点参数无效');
        segment.anchorPlan = { fromX, toX, level: level as Segment['anchorPlan']['level'] };
      }
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.subshot.add': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId));
      if (!segment.subshots?.length) {
        segment.subshots = defaultSubshots(beatFor(episode, segment), segment.durationSec, segment.number);
        segment.subshotsAuto = true;
        segment.subshotsReviewed = false;
        segment.subshotCandidate = undefined;
        episode.auditApprovedHash = undefined;
        return;
      }
      const shots = segment.subshots;
      if (!shots.length || shots.length >= 12) throw new Error('子镜数量须为 2–12');
      const last = shots.at(-1)!;
      if (last.endSec - last.startSec < 0.4) throw new Error('末子镜太短，无法再拆分');
      const midpoint = Math.round((last.startSec + last.endSec) * 500) / 1000;
      shots.push({ id: id(), startSec: midpoint, endSec: last.endSec, framing: last.framing,
        action: '', lineRefs: { dialogue: [], os: [], floatLabels: [], systemPanels: [] } });
      last.endSec = midpoint;
      segment.subshotsAuto = false;
      segment.subshotsReviewed = false;
      segment.subshotCandidate = undefined;
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.subshot.delete': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId)), shots = segment.subshots || [];
      if (shots.length <= 2 || shots.at(-1)?.id !== str(action.subshotId)) throw new Error('只可删除末尾新增的空子镜');
      const last = shots.at(-1)!;
      if (last.action.trim() || Object.values(last.lineRefs).some(refs => refs.length))
        throw new Error('子镜已有内容，不能直接删除');
      shots[shots.length - 2].endSec = last.endSec;
      shots.pop();
      segment.subshotsAuto = false;
      segment.subshotsReviewed = false;
      segment.subshotCandidate = undefined;
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.subshot.update': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId)), beat = beatFor(episode, segment);
      const shot = segment.subshots?.find(item => item.id === str(action.subshotId));
      if (!shot) throw new Error('子镜不存在');
      const startSec = Number(action.startSec), endSec = Number(action.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 ||
        endSec > segment.durationSec || endSec - startSec < 0.1) throw new Error('子镜时间范围无效');
      const input = action.lineRefs as Record<string, unknown> | undefined;
      if (!input) throw new Error('子镜对白与可见信息分配缺失');
      const lineRefs = {} as typeof shot.lineRefs;
      for (const kind of ['dialogue', 'os', 'floatLabels', 'systemPanels'] as const) {
        const refs = input[kind];
        if (!Array.isArray(refs) || refs.some(ref => !Number.isInteger(ref) || ref < 0 || ref >= beat[kind].length))
          throw new Error(`${kind} 序号超出正式剧本范围`);
        lineRefs[kind] = refs as number[];
      }
      const assetIds = Array.isArray(action.assetIds) ? action.assetIds.map(str) : [];
      if (assetIds.some(assetId => !(segment.assetBindings || []).some(binding => binding.assetId === assetId)))
        throw new Error('子镜选择了片段未绑定的资产');
      Object.assign(shot, { startSec, endSec, framing: str(action.framing), action: str(action.sceneAction),
        evidence: str(action.evidence), location: str(action.location), priorState: str(action.priorState),
        result: str(action.result), endFrame: str(action.endFrame), assetIds, lineRefs });
      segment.subshotsAuto = false;
      segment.subshotsReviewed = false;
      segment.subshotCandidate = undefined;
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.subshots.approve': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId));
      const issues = validateSubshots(beatFor(episode, segment), segment);
      if (!segment.visualPlan.trim()) issues.push('视觉与机位计划未填写');
      if (issues.length) throw new Error(issues.join('；'));
      segment.subshotsAuto = false;
      segment.subshotsReviewed = true;
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'project.labelStyle': {
      project.labelStyle = validateLabelStyle(action.style);
      return;
    }
    case 'segment.executionPlan': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId)), beat = beatFor(episode,segment);
      if (action.clear === true) { segment.executionPlan = undefined; episode.auditApprovedHash = undefined; return; }
      if (!action.plan || typeof action.plan !== 'object') throw Error('请填写逐镜执行计划');
      const plan = structuredClone(action.plan) as ExecutionPlan;
      plan.labelStyle = validateLabelStyle(plan.labelStyle);
      if (!Array.isArray(plan.effects)) throw Error('逐镜特效必须为清单');
      plan.effects = plan.effects.map(cue => ({ ...cue, evidence: checkedEffectEvidence(cue.effectId, cue.evidence, beat.event+'\n'+beat.reaction), description: visualDescription(cue.effectId) }));
      const usedAssets=new Set([...plan.effects.flatMap(c=>[c.actorId,c.targetId]),
        ...(Array.isArray(plan.combat)?plan.combat:[]).flatMap(c=>[c.attackerId,c.defenderId]),
        ...(Array.isArray(plan.visible)?plan.visible:[]).map(c=>c.ownerId)].filter(Boolean));
      plan.assetNames = Object.fromEntries((project.assets || []).filter(asset=>usedAssets.has(asset.id)).map(asset=>[asset.id,asset.name]));
      const issues = executionPlanIssues(beat,{...segment,executionPlan:plan},subshotsFor(beat,segment),project);
      if (issues.length) throw Error(issues.join('；'));
      for(const cue of plan.effects) {segment.effectVersions[cue.effectId]=effectVersion(cue.effectId);segment.effectEvidence[cue.effectId]=cue.evidence;}
      segment.executionPlan = plan; segment.subshotsReviewed = false; episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.writeSubshots': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId));
      if (!Array.isArray(action.shots)) throw Error('须提供完整子镜数组');
      const existingIds=new Set(segment.subshots?.map(shot=>shot.id));
      const shots = structuredClone(action.shots).map(shot => ({ ...shot as object, id: existingIds.has(shot?.id) ? shot.id : id() })) as NonNullable<Segment['subshots']>;
      if(new Set(shots.map(shot=>shot.id)).size!==shots.length)throw Error('子镜编号重复，请保留唯一子镜');
      const speechPlan = action.speechPlan === undefined ? undefined : structuredClone(action.speechPlan) as Segment['speechPlan'];
      if (speechPlan !== undefined && !Array.isArray(speechPlan)) throw Error('逐句声音时序须为数组');
      const issues = validateSubshots(beatFor(episode, segment), { ...segment, subshots: shots, speechPlan });
      if (issues.length) throw Error(issues.join('；'));
      segment.subshots = shots; segment.speechPlan = speechPlan; segment.subshotsAuto = false; segment.subshotsReviewed = false;
      segment.subshotCandidate = undefined; episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.subshots.applyCandidate': {
      if (!episode || episode.scriptLockedHash !== scriptHash(episode)) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId));
      const candidate = segment.subshotCandidate;
      if (!candidate || candidate.sourceHash !== storyboardSourceHash(episode, segment))
        throw new Error('分镜建议已过期，请重新规划');
      const issues = validateSubshots(beatFor(episode, segment), { ...segment, subshots: candidate.shots });
      if (issues.length) throw new Error(issues.join('；'));
      segment.subshots = structuredClone(candidate.shots);
      segment.subshotsAuto = false;
      segment.subshotsReviewed = false;
      segment.subshotCandidate = undefined;
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.effects': {
      if (!episode) throw new Error('分集不存在');
      const segment = segmentOf(episode, str(action.segmentId));
      const beat = beatFor(episode, segment);
      const entries = Array.isArray(action.entries) ? action.entries as { id: string; evidence: string }[] : [];
      const ids = new Set<string>();
      const versions: Record<string, string> = {}, evidence: Record<string, string> = {};
      for (const entry of entries) {
        const effectId = str(entry.id), quote = str(entry.evidence);
        const checked = checkedEffectEvidence(effectId, quote, beat.event + '\n' + beat.reaction);
        ids.add(effectId); versions[effectId] = effectVersion(effectId); evidence[effectId] = checked;
      }
      segment.effectIds = [...ids]; segment.effectVersions = versions; segment.effectEvidence = evidence;
      if (segment.executionPlan) segment.executionPlan.effects = segment.executionPlan.effects.filter(cue => ids.has(cue.effectId));
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.applyEffectCandidates': {
      if (!episode?.scriptLockedHash) throw new Error('请先锁定正式剧本');
      const segment = segmentOf(episode, str(action.segmentId)), beat = beatFor(episode, segment);
      const candidate = segment.effectCandidates;
      if (!candidate || candidate.sourceHash !== digest({ beat, catalogVersion }))
        throw new Error('特效建议已过期，请重新匹配');
      const checkedEntries=candidate.entries.map(entry=>({...entry,evidence:checkedEffectEvidence(entry.id,entry.evidence,beat.event+'\n'+beat.reaction),version:effectVersion(entry.id)}));
      for (const entry of checkedEntries) {
        if (!segment.effectIds.includes(entry.id)) segment.effectIds.push(entry.id);
        segment.effectVersions[entry.id] = entry.version;
        segment.effectEvidence[entry.id] = entry.evidence;
      }
      episode.auditApprovedHash = undefined;
      return;
    }
    case 'segment.writePrompt': {
      if (!episode) throw Error('分集不存在');
      const segment = segmentOf(episode, str(action.segmentId));
      if (Object.hasOwn(action, 'expectedPromptId') && (action.expectedPromptId ?? null) !== (segment.selected.prompt ?? null))
        throw Error('提示词选用状态已变化，请刷新后重新核对');
      installWrittenPrompt(episode, segment, prepareWrittenPrompt(project, episode, segment, action.content), action.archivePrevious === true);
      return;
    }
    case 'episode.prompts.manage': {
      if (!episode) throw Error('分集不存在');
      managePrompts(project, episode, action);
      return;
    }
    case 'segment.prompt.unselect':
    case 'segment.prompt.archive':
    case 'segment.prompt.restore': {
      if (!episode) throw Error('分集不存在');
      managePrompts(project, episode, { ...action, operation: action.type.split('.').at(-1),
        entries: [{ segmentId: action.segmentId, artifactId: action.artifactId,
          ...(Object.hasOwn(action, 'expectedPromptId') ? { expectedPromptId: action.expectedPromptId } : {}) }] });
      return;
    }
    case 'segment.select': {
      if (!episode) throw new Error('分集不存在');
      const segment = segmentOf(episode, str(action.segmentId));
      const kind = str(action.kind);
      if (!['anchor', 'prompt', 'video'].includes(kind)) throw new Error('未知版本类型');
      const artifact = segment.artifacts.find(item => item.id === str(action.artifactId) && item.kind === kind);
      if (!artifact) throw new Error('版本不存在');
      if (kind === 'prompt') {
        if (artifact.promptArchive) throw Error('已停用提示词不能选用，请先恢复并重新核对');
        const issues = selectedPromptContractIssues(episode, { ...segment, selected: { ...segment.selected, prompt: artifact.id } }, project);
        if (issues.length) throw new Error(issues.join('；'));
      }
      if (kind === 'video' && !usableVideo(project, episode, segment, artifact)) throw new Error('视频生成输入已变化，请选择当前版本');
      if (kind === 'video') verifyReferenceProvenance(project,episode,segment,artifact);
      if (kind === 'video' && artifact.review?.status === 'rejected' && !(artifact.userAcceptance?.status==='accepted'&&artifact.userAcceptance.generationHash===artifact.generationHash&&usableVideo(project,episode,segment,artifact))) throw new Error('废片不能选为正式视频，请选成功片段或待审片段');
      if (segment.selected[kind as 'anchor' | 'prompt' | 'video'] === artifact.id) return;
      segment.selected[kind as 'anchor' | 'prompt' | 'video'] = artifact.id;
      if (kind === 'prompt') { delete segment.promptSelectionPaused; episode.auditApprovedHash = undefined; }
      return;
    }
    case 'segment.userWithdraw': {
      if(!episode)throw new Error('分集不存在');
      const segment=segmentOf(episode,str(action.segmentId)),artifact=segment.artifacts.find(item=>item.id===str(action.artifactId)&&item.kind==='video');
      const statement=str(action.statement),sourceMessageId=str(action.sourceMessageId);
      if(!artifact?.userAcceptance||action.confirmed!==true||!statement||statement.length>2000||!sourceMessageId||sourceMessageId.length>200)throw new Error('必须对应原用户验收版本并保存撤回原话和来源');
      if(artifact.userAcceptance.status==='withdrawn'&&artifact.userAcceptance.sourceMessageId===sourceMessageId)return;
      (artifact.userAcceptanceHistory||=[]).push({...artifact.userAcceptance});
      artifact.userAcceptance={...artifact.userAcceptance,status:'withdrawn',statement,sourceMessageId,withdrawnAt:now()};
      if(artifact.review)(artifact.reviewHistory||=[]).push(structuredClone(artifact.review));
      artifact.review={status:'rejected',notes:'用户听验反馈：'+statement+'；需要修改，未通过。此前检查及验收记录保留在历史中；没有将未核验的音频写为通过。',reviewedAt:now(),checks:{story:false,voice:false,assets:false,labels:false,pacing:false,continuity:false}};
      if(segment.selected.video===artifact.id)delete segment.selected.video;
      return;
    }
    case 'segment.userAccept': {
      if(!episode)throw new Error('分集不存在');
      const segment=segmentOf(episode,str(action.segmentId));
      const artifact=segment.artifacts.find(item=>item.id===str(action.artifactId)&&item.kind==='video');
      if(!artifact?.mediaPath||artifact.demo||!usableVideo(project,episode,segment,artifact))throw new Error('用户验收必须对应当前输入的真实视频版本');
      verifyReferenceProvenance(project,episode,segment,artifact);
      const statement=str(action.statement),sourceMessageId=str(action.sourceMessageId);
      if(action.confirmed!==true||!statement||statement.length>2000||!sourceMessageId||sourceMessageId.length>200)throw new Error('必须保存明确用户验收原话和来源');
      const stat=statSync(mediaPath(artifact.mediaPath));
      if(!artifact.technical||artifact.technical.size!==stat.size||artifact.technical.modifiedAt!==stat.mtimeMs)throw new Error('视频文件变化，请重新检测后确认用户验收');
      artifact.userAcceptance={status:'accepted',statement,sourceMessageId,acceptedAt:now(),generationHash:artifact.generationHash!};
      // User acceptance chooses this version, but never manufactures speech
      // evidence or overwrites prior technical/editorial review findings.
      segment.selected.video=artifact.id;
      return;
    }
    case 'segment.videoReview': {
      if (!episode) throw new Error('分集不存在');
      const segment = segmentOf(episode, str(action.segmentId));
      const artifact = segment.artifacts.find(item => item.id === str(action.artifactId) && item.kind === 'video');
      if (!artifact?.mediaPath) throw new Error('视频版本不存在');
      const status = str(action.status);
      if (status !== 'approved' && status !== 'rejected') throw new Error('审片状态无效');
      if (status === 'approved' && artifact.demo) throw new Error('技术演示视频不能作为正式审片通过');
      if (status === 'approved') {
        if (!usableVideo(project, episode, segment, artifact)) throw new Error('视频对应旧生成输入');
        verifyReferenceProvenance(project,episode,segment,artifact);
        if (artifact.technical) validateGeneratedMedia(artifact.technical, segment.durationSec, project.aspectRatio || '16:9', Boolean(beatFor(episode, segment).dialogue.length || beatFor(episode, segment).os.length), expectedResolution(project));
        const stat = statSync(mediaPath(artifact.mediaPath));
        if (!artifact.technical?.inspectedAt || artifact.technical.size !== stat.size ||
          artifact.technical.modifiedAt !== stat.mtimeMs) throw new Error('审片通过前请先对当前视频运行技术检查');
      }
      const notes = str(action.notes);
      if (notes.length > 2000) throw new Error('审片备注过长');
      const inputChecks = action.checks && typeof action.checks === 'object' && !Array.isArray(action.checks) ?
        action.checks as Record<string, unknown> : {};
      const keys = ['story', 'voice', 'assets', 'labels', 'pacing', 'continuity'] as const;
      const checks = Object.fromEntries(keys.map(key => [key, inputChecks[key] === true])) as
        Record<(typeof keys)[number], boolean>;
      if (status === 'approved' && keys.some(key => !checks[key]))
        throw new Error('审片通过前请逐项确认剧情、声音、资产、可见文字、节奏与连续性');
      const speech = status === 'approved' ? validateSpeechEvidence(speechChecklist(episode, segment), action.speech, segment.durationSec) : undefined;
      if(artifact.review)(artifact.reviewHistory||=[]).push(structuredClone(artifact.review));
      artifact.review = { status, notes, reviewedAt: now(), checks, speech };
      if (status === 'rejected' && segment.selected.video === artifact.id) {
        segment.selected.video = segment.artifacts.find(item => item.kind === 'video' &&
          item.id !== artifact.id && item.review?.status === 'approved')?.id;
      } else if (status === 'approved' && !segment.selected.video) segment.selected.video = artifact.id;
      return;
    }
    case 'audit.approve': {
      if (!episode) throw new Error('分集不存在');
      const issues = auditEpisode(episode, project);
      if (issues.length) throw new Error(issues.join('；'));
      episode.auditApprovedHash = approvalHash(episode);
      return;
    }
    case 'episode.sampleApprove': {
      if (!episode || episode.auditApprovedHash !== approvalHash(episode))
        throw new Error('请先通过本集五层无损核对');
      const approved = episode.segments.some(segment => {
        const video = segment.artifacts.find(item => item.id === segment.selected.video && item.kind === 'video');
        return video?.review?.status === 'approved' && !video.demo && usableVideo(project, episode!, segment, video);
      });
      if (!approved) throw new Error('请先完成至少一个正式试片的技术检查与人工审片');
      episode.sampleApprovedHash = sampleGateHash(project, episode);
      return;
    }
    default: throw new Error('未知操作');
  }
}
