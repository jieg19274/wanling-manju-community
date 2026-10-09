import { assetInputHash } from '../shared/generation.js';
import {assetImageReferences,type ImageReference} from './asset-image-references.js';
import {assertAssetImageRole} from '../shared/asset-references.js';
import {assetEvidenceName,reviewedAssetEvidence} from '../shared/asset-evidence.js';
import {storyReviewHash} from '../shared/story-review.js';
import {storyUnits,segmentPlanHash,validateSegmentPlan} from '../shared/segmentation.js';
import {analysisBudget, storyPlanFingerprint} from '../shared/analysis-budget.js';
import {storyIndex} from '../shared/story-index.js';
import {fitSummaryBudget} from '../shared/summary-budget.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { paragraphBoundaries, storyBatches, sourceChapters, planChapterGroups, type EpisodePlan, type StoryBatch, type StoryPlanProgress } from '../shared/episode-plan.js';
import { beatFor, digest, highlightHash, id, knownVideoCapabilities, now, pacingWarnings, scriptHash, segmentReferences, sourceHash, storyboardSourceHash,
  validateSubshots, type AssetSuggestion, type ScriptBeat, type Subshot } from '../shared/model.js';
import { runFileAdapter, runJsonAdapter } from './adapter-runner.js';
import { mediaPath, relativeMedia } from './media.js';
import { db, getProject, updateProject } from './store.js';
import type {Project} from '../shared/model.js';
import {candidatePrompt} from '../shared/candidate-contract.js';
import { productionRules } from '../shared/production-rules.js';
import { catalogVersion, checkedEffectEvidence, effectVersion, listEffects, visualDescription } from './effects.js';

function configured(adapter: string | undefined, kind: string): string {
  if (!adapter || !existsSync(adapter)) throw new Error(`请先在项目设置中配置可用的${kind}适配器`);
  return adapter;
}

const activeStoryPlans = new Set<string>();

function planInput(projectId: string) {
  const project = getProject(projectId), source = project.sourceCorpus || '';
  if (project.mode !== 'standard' || project.episodes.length || project.archivedEpisodes?.length)
    throw new Error('只有尚未创建分集的常规漫剧可生成剧情分集建议');
  if (source.trim().length < 50) throw new Error('请先保存完整原文');
  const adapter = configured(project.textModel?.adapterPath, '文本模型');
  const batches = storyBatches(source);
  const fingerprint = storyPlanFingerprint(source, adapter, project.textModel?.modelId, project.productionRules);
  return { project, source, adapter, batches, fingerprint };
}

function batchBoundaries(raw: unknown, batch: StoryBatch, source?: string): number[] {
  const allowed = new Set(source === undefined ? [0, ...batch.chapters.slice(1).map(item => item.start - batch.start), batch.end - batch.start] : paragraphBoundaries(source.slice(batch.start, batch.end)));
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 201 ||
    raw[0] !== 0 || raw.at(-1) !== batch.end - batch.start ||
    raw.some((value, index) => !Number.isInteger(value) || !allowed.has(value) ||
      (index > 0 && value <= raw[index - 1])))
    throw new Error('文本模型给出的章节边界无效，本批结果未采用');
  return raw as number[];
}

function assembleStoryPlan(source: string, batches: StoryBatch[], results: StoryPlanProgress['results']): EpisodePlan {
  if (results.length !== batches.length) throw new Error('分批分析尚未覆盖全部原文');
  const ranges: EpisodePlan['ranges'] = [];
  for (const [index, batch] of batches.entries()) {
    const result = results[index];
    if (result.start !== batch.start || result.end !== batch.end) throw new Error('分批原文范围发生变化');
    const boundaries = batchBoundaries(result.boundaries, batch, source);
    for (let part = 0; part < boundaries.length - 1; part++) {
      const start = batch.start + boundaries[part], end = batch.start + boundaries[part + 1];
      ranges.push({ start, end, charCount: end - start,
        chapters: batch.chapters.filter(chapter => chapter.start < end && chapter.end > start)
          .map(chapter => chapter.title) });
    }
  }
  if (ranges.length > 200 || ranges[0]?.start !== 0 || ranges.at(-1)?.end !== source.length ||
    ranges.some((range, index) => !range.chapters.length || range.end <= range.start ||
      (index > 0 && range.start !== ranges[index - 1].end)) ||
    ranges.map(range => source.slice(range.start, range.end)).join('') !== source)
    throw new Error('模型分集未连续覆盖全部原文，未采用');
  return { sourceHash: digest(source), chaptersPerEpisode: 0, hasHeadings: true, method: 'story', ranges };
}

export function storyPlanStatus(projectId: string) {
  const progress = getProject(projectId).episodePlanProgress;
  if (!progress) return null;
  return { status: progress.status === 'running' && !activeStoryPlans.has(projectId) ? 'interrupted' : progress.status,
    totalBatches: progress.totalBatches, completedBatches: progress.completedBatches,
    error: progress.error || '', updatedAt: progress.updatedAt };
}

async function runStoryPlan(projectId: string, fingerprint: string): Promise<void> {
  try {
    const { source, adapter, batches } = planInput(projectId);
    for (let index = 0; index < batches.length; index++) {
      const current = getProject(projectId);
      if (current.episodePlanProgress?.fingerprint !== fingerprint ||
        current.episodePlanProgress.results.length < index)
        throw new Error('分批分析状态已变化，请重新开始');
      if (current.episodePlanProgress.results.length > index) continue;
      const batch = batches[index], excerpt = source.slice(batch.start, batch.end);
      const allowed = paragraphBoundaries(excerpt);
      const result = await runJsonAdapter<{ boundaries?: unknown; summary?: string;events?:unknown }>(adapter, {
        task: 'episode-plan', projectId, model: current.textModel?.modelId, sourceText: excerpt,
        productionRules: productionRules(current.productionRules),
        chapterBoundaries: allowed, chapterTitles: batch.chapters.map(item => item.title),
        instruction: `这是完整原文的第 ${index + 1}/${batches.length} 批，共 ${batch.chapters.length} 章。每集取${productionRules(current.productionRules).minChapters}–${productionRules(current.productionRules).maxChapters}章，按完整剧情转折选断点，不以分析批次强制切集；不得改写或遗漏。`,
      });
      const boundaries = batchBoundaries(result.boundaries, batch, source);
      const events=storyIndex(source,batch.start,batch.end,result.events);
      if (typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 2000)
        throw new Error('分批结果须提供不超过2000字符的完整事件/因果/状态摘要；不采用截取原文开头作为全局依据');
      updateProject(projectId, project => {
        if (project.episodePlanProgress?.fingerprint !== fingerprint ||
          project.episodePlanProgress.results.length !== index || project.episodes.length ||
          storyPlanFingerprint(project.sourceCorpus || '', project.textModel?.adapterPath || '', project.textModel?.modelId, project.productionRules) !== fingerprint)
          throw new Error('分析期间原文或模型发生变化，请重新开始');
        project.episodePlanProgress.results.push({ start: batch.start, end: batch.end, boundaries,
          summary: result.summary,events });
        project.episodePlanProgress.completedBatches = index + 1;
        project.episodePlanProgress.updatedAt = now();
      });
    }
    const current = getProject(projectId);
    const candidate = assembleStoryPlan(source, batches, current.episodePlanProgress!.results);
    const allowedGlobal = [...new Set([0, ...candidate.ranges.map(range => range.start), source.length])].sort((a,b) => a-b);
    const chapters = sourceChapters(source), rules = productionRules(current.productionRules);
    for (const range of candidate.ranges) {
      const group = chapters.filter(c => c.start >= range.start && c.start < range.end);
      for (let index = rules.maxChapters; index < group.length; index += rules.maxChapters) allowedGlobal.push(group[index].start);
    }
    allowedGlobal.sort((a,b) => a-b);
    const summaries = await fitSummaryBudget(current.episodePlanProgress!.results.map(result => ({ start: result.start, end: result.end, summary: JSON.stringify({summary:result.summary,events:result.events}) })),
      JSON.stringify(allowedGlobal).length+1000, async items=> {
        const result=await runJsonAdapter<{summary:string}>(adapter,{task:'episode-plan-summary',projectId,model:current.textModel?.modelId,summaries:items,
          instruction:'按原文范围保留关键事件、因果、人物状态与跨批悬念；压缩叙述但不得编造或删除关键转折。'});
        return result.summary;
      });
    const globalResult = await runJsonAdapter<{ boundaries?: unknown }>(adapter, { task: 'episode-plan-global', projectId,
      model: current.textModel?.modelId, sourceLength: source.length, chapterBoundaries: allowedGlobal,
      productionRules: rules,
      summaries,
      instruction: `根据全局事件摘要和跨批因果衔接统一分集，每集${rules.minChapters}–${rules.maxChapters}章。可跨分析批次合并，不得因为批次强制切集；只选给定边界并完整覆盖原文。` });
    const globalBoundaries = globalResult.boundaries;
    if (!Array.isArray(globalBoundaries) || globalBoundaries.length < 2 || globalBoundaries.length > 201 ||
      globalBoundaries[0] !== 0 || globalBoundaries.at(-1) !== source.length ||
      globalBoundaries.some((value, index) => !Number.isInteger(value) || !allowedGlobal.includes(value) || (index > 0 && value <= globalBoundaries[index-1])))
      throw new Error('全局分集范围无效，已保留分批结果以便重试');
    const unified: EpisodePlan = { ...candidate, ranges: globalBoundaries.slice(0,-1).map((start,index) => {
      const end = globalBoundaries[index+1]; return { start, end, charCount: end-start,
        chapters: [...new Set(batches.flatMap(batch => batch.chapters).filter(chapter => chapter.start < end && chapter.end > start).map(chapter => chapter.title))] };
    }) };
    validateStoryChapterLimits(source, unified, current);
    updateProject(projectId, project => {
      const progress = project.episodePlanProgress;
      if (progress?.fingerprint !== fingerprint || project.episodes.length ||
        storyPlanFingerprint(project.sourceCorpus || '', project.textModel?.adapterPath || '', project.textModel?.modelId, project.productionRules) !== fingerprint)
        throw new Error('分析期间原文或模型发生变化，请重新开始');
      project.episodePlan = unified;
      progress.status = 'completed'; progress.error = undefined; progress.updatedAt = now();
    });
  } catch (error) {
    updateProject(projectId, project => {
      const progress = project.episodePlanProgress;
      if (progress?.fingerprint === fingerprint) {
        progress.status = 'failed'; progress.error = error instanceof Error ? error.message : String(error);
        progress.updatedAt = now();
      }
    });
  } finally { activeStoryPlans.delete(projectId); }
}

export function storyPlanPreview(projectId:string) {
  const {source,adapter,project}=planInput(projectId);
  return analysisBudget(source,adapter,project.textModel?.modelId,project.productionRules);
}
export async function suggestEpisodePlan(projectId: string, budgetHash?:string) {
  const { project, source, adapter, batches, fingerprint } = planInput(projectId);
  if(budgetHash!==fingerprint) throw new Error('请先确认当前原文、模型及批次预算预览；未提交付费分析');
  if (batches.length > 1) {
    if (activeStoryPlans.has(projectId)) return storyPlanStatus(projectId);
    updateProject(projectId, current => {
      const prior = current.episodePlanProgress;
      current.episodePlanProgress = prior?.fingerprint === fingerprint && prior.status !== 'completed' ?
        { ...prior, status: 'running', error: undefined, updatedAt: now() } :
        { fingerprint, totalBatches: batches.length, completedBatches: 0,
          status: 'running', updatedAt: now(), results: [] };
    });
    activeStoryPlans.add(projectId);
    void runStoryPlan(projectId, fingerprint);
    return storyPlanStatus(projectId);
  }
  const result = await runJsonAdapter<{ boundaries?: unknown;events?:unknown;summary?:string }>(adapter, {
    task: 'episode-plan', projectId, model: project.textModel?.modelId, sourceText: source,
    productionRules: productionRules(project.productionRules),
    chapterBoundaries: paragraphBoundaries(source),
    chapterTitles: batches[0].chapters.map(item => item.title),
    instruction: `每集${productionRules(project.productionRules).minChapters}–${productionRules(project.productionRules).maxChapters}章，按完整剧情转折选章节边界。只返回从0到原文长度的递增字符边界，连续覆盖全文，不得改写或遗漏。`,
  });
  const boundaries = batchBoundaries(result.boundaries, batches[0], source);
  const events=storyIndex(source,0,source.length,result.events);
  if(typeof result.summary!=='string' || result.summary.length>2000 || !result.summary.trim())throw new Error('单批分析须提供完整事件摘要');
  const plan = assembleStoryPlan(source, batches,
    [{ start: 0, end: source.length, boundaries }]);
  validateStoryChapterLimits(source, plan, project);
  updateProject(projectId, current => {
    if (digest(current.sourceCorpus || '') !== plan.sourceHash || current.episodes.length ||
      storyPlanFingerprint(current.sourceCorpus || '', current.textModel?.adapterPath || '', current.textModel?.modelId, current.productionRules) !== fingerprint)
      throw new Error('原文在分析期间发生变化，请重新规划');
    current.episodePlan = plan;
    current.episodePlanProgress={fingerprint,totalBatches:1,completedBatches:1,status:'completed',updatedAt:now(),results:[{start:0,end:source.length,boundaries,summary:result.summary,events}]};
  });
  return plan;
}

function validateStoryChapterLimits(source: string, plan: EpisodePlan, project: Project) {
  if (!project.productionRules) return; // Existing projects retain their original planning contract.
  const chapters = sourceChapters(source);
  if (chapters[0].title === '未识别到章节标题') return;
  const ends = plan.ranges.map(range => {
    const index = chapters.findIndex(c => c.end === range.end);
    if (index < 0) throw Error('分集断在章内，请按完整章节重新规划');
    return index + 1;
  });
  planChapterGroups(source, ends, project.productionRules);
}

export async function suggestHighlight(projectId: string, episodeId: string) {
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  if (!episode || episode.scriptLockedHash) throw new Error('分集不存在或正式剧本已锁定');
  if (episode.sourceReviewedHash !== sourceHash(episode)) throw new Error('请先完整阅读并确认原文');
  const adapter = configured(project.textModel?.adapterPath, '文本模型');
  const result = await runJsonAdapter<{ highlightReport?: unknown }>(adapter, {
    task: 'highlight-report', projectId, model: project.textModel?.modelId, sourceText: episode.sourceText,
    sourceRange: episode.sourceRange,
    required: ['章节范围', '事件起因与结果', '人物目的与反应', '名场面与原文金句', '专名映射', '未采用素材'],
    instruction: '仅依据完整原文写待审核报告；逐项保留因果与人物反应，不得编造。',
  });
  if (typeof result.highlightReport !== 'string' || !result.highlightReport.trim())
    throw new Error('文本模型未返回高光剧情报告');
  const content = result.highlightReport.trim();
  updateProject(projectId, current => {
    const target = current.episodes.find(item => item.id === episodeId);
    if (!target || target.sourceReviewedHash !== sourceHash(target) || sourceHash(target) !== sourceHash(episode))
      throw new Error('原文在分析期间发生变化，请重新生成建议');
    target.highlightCandidate = { sourceHash: sourceHash(target), content };
  });
  return { ready: true };
}

export async function suggestSemanticReview(projectId:string,episodeId:string) {
  const project=getProject(projectId),episode=project.episodes.find(item=>item.id===episodeId);
  if(!episode?.scriptLockedHash) throw new Error('请先锁定正式剧本，语义建议不能修改权威剧情');
  const hash=storyReviewHash(episode),adapter=configured(project.textModel?.adapterPath,'文本模型');
  const result=await runJsonAdapter<{entries:unknown[];warnings?:unknown[]}>(adapter,{task:'semantic-review',projectId,model:project.textModel?.modelId,
    sourceText:episode.sourceText,beats:episode.scriptBeats,highlights:episode.highlightItems || [],
    instruction:'逐节点复核原文跨度、因果、人物反应、统一声音顺序和高光覆盖。每项说明实际依据与缺失，无法证明须列警告；不得改写剧情、锁稿或自行批准。'});
  if(!Array.isArray(result.entries) || result.entries.length!==episode.scriptBeats.length) throw new Error('语义候选须完整覆盖节点');
  const entries=episode.scriptBeats.map(beat=>{
    const entry=result.entries.find(value=>(value as {beatId?:unknown})?.beatId===beat.id) as Record<string,unknown> | undefined;
    if(!entry || !Number.isInteger(entry.sourceStart) || !Number.isInteger(entry.sourceEnd) || Number(entry.sourceStart)<0 || Number(entry.sourceEnd)>episode.sourceText.length || Number(entry.sourceEnd)<=Number(entry.sourceStart) ||
      (beat.sourceQuote && !episode.sourceText.slice(Number(entry.sourceStart),Number(entry.sourceEnd)).includes(beat.sourceQuote)) || typeof entry.notes!=='string' || entry.notes.trim().length<8 ||
      !Array.isArray(entry.highlightIds) || entry.highlightIds.some(id=>!episode.highlightItems?.some(highlight=>highlight.id===id))) throw new Error('语义候选的原文范围、高光引用或依据无效');
    return {beatId:beat.id,sourceStart:Number(entry.sourceStart),sourceEnd:Number(entry.sourceEnd),notes:entry.notes.trim(),highlightIds:entry.highlightIds as string[]};
  });
  if(new Set(result.entries.map(value=>(value as {beatId?:unknown}).beatId)).size!==entries.length) throw new Error('语义候选含重复节点');
  const warnings=(result.warnings || []).map(value=>String(value).slice(0,1000));
  updateProject(projectId,current=>{
    const target=current.episodes.find(item=>item.id===episodeId);
    if(!target || storyReviewHash(target)!==hash) throw new Error('语义复核期间原文、高光或剧本变化，候选未采用');
    target.semanticCandidate={hash,entries,warnings,createdAt:now()};
  });
  return {ready:true,warnings};
}
export async function suggestSegmentPlan(projectId:string,episodeId:string) {
  const project=getProject(projectId),episode=project.episodes.find(item=>item.id===episodeId);
  if(!episode?.scriptLockedHash || episode.segments.some(segment=>segment.artifacts.length)) throw new Error('分段建议须在锁稿后、生成版本前进行');
  const hash=segmentPlanHash(episode),adapter=configured(project.textModel?.adapterPath,'文本模型');
  const result=await runJsonAdapter<{groups:unknown;budgets:unknown}>(adapter,{task:'segment-plan',projectId,model:project.textModel?.modelId,units:storyUnits(episode),durationSec:30,
    instruction:'按已锁定剧情规划固定30秒声音、动作表演、人物反应时间预算。允许连续单元合段/拆段，不删改台词，不新增动作或剧情；内容无法撑满须明确报告。'});
  const checked=validateSegmentPlan(episode,result.groups,result.budgets);
  updateProject(projectId,current=>{const target=current.episodes.find(item=>item.id===episodeId);if(!target || segmentPlanHash(target)!==hash || target.segments.some(segment=>segment.artifacts.length))throw new Error('分段建议期间输入变化，候选未采用');target.segmentPlanCandidate={hash,...checked,createdAt:now()};});
  return {ready:true,warnings:checked.warnings};
}

export async function suggestScript(projectId: string, episodeId: string) {
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  if (!episode || episode.scriptLockedHash) throw new Error('分集不存在或正式剧本已锁定');
  if (episode.sourceReviewedHash !== sourceHash(episode) ||
    episode.highlightReviewedHash !== highlightHash(episode))
    throw new Error('请先阅读完整原文并确认高光剧情报告');
  const adapter = configured(project.textModel?.adapterPath, '文本模型');
  const capability = { ...project.videoModel?.capabilities,
    ...knownVideoCapabilities(project.videoModel?.modelId || '') };
  const targetDurationSec = 30;
  const result = await runJsonAdapter<{ beats?: unknown }>(adapter, {
    task: 'script-beats', projectId, model: project.textModel?.modelId,
    sourceText: episode.sourceText, highlightReport: episode.highlightReport,
    targetDurationSec,
    fixedDurationSec: 30,
    maxDurationSec: capability.maxDurationSec || 30,
    instruction: '每个生成片段固定30秒，按完整因果动作、声音与人物反应组织剧情密度；装不下则拆段，不能删词、填空镜或编造动作。剧本节点可以在锁稿后按完整剧情单元无损合段或拆段。首集开头直接进入剧情，保留有依据的对白、OS、浮签与系统信息。',
  });
  if (!Array.isArray(result.beats) || !result.beats.length || result.beats.length > 200)
    throw new Error('文本模型未返回有效剧本节点');
  const beats: ScriptBeat[] = result.beats.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('剧本节点格式错误');
    const value = raw as Record<string, unknown>;
    const list = (key: string) => {
      if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(item => typeof item === 'string'))
        throw new Error(`剧本节点 ${key} 格式错误`);
      return (value[key] as string[]).map(item => item.trim()).filter(Boolean);
    };
    if (typeof value.event !== 'string' || !value.event.trim() ||
      typeof value.reaction !== 'string' || !value.reaction.trim()) throw new Error('剧本节点缺少事件或反应');
    const sourceQuote = typeof value.sourceQuote === 'string' ? value.sourceQuote.trim() : '';
    if (sourceQuote.length < 6 || !episode.sourceText.includes(sourceQuote))
      throw new Error('剧本节点缺少本集原文中的逐字依据，不能采用此模型建议');
    const dialogue = list('dialogue'), os = list('os');
    if ([...dialogue, ...os].some(line => !/^[^：:]+[：:].+/u.test(line)))
      throw new Error('对白或OS未按“角色：内容”格式返回');
    return { id: id(), sourceQuote, event: value.event.trim(), reaction: value.reaction.trim(),
      dialogue, os, floatLabels: list('floatLabels'), systemPanels: list('systemPanels') };
  });
  updateProject(projectId, current => {
    const target = current.episodes.find(item => item.id === episodeId);
    if (!target || target.sourceReviewedHash !== sourceHash(target) ||
      target.highlightReviewedHash !== highlightHash(target) ||
      sourceHash(target) !== sourceHash(episode) || highlightHash(target) !== highlightHash(episode))
      throw new Error('原文或高光报告在分析期间变化，请重新生成建议');
    target.scriptCandidate = { sourceHash: sourceHash(target), highlightHash: highlightHash(target), beats };
  });
  return { beats: beats.length };
}

export async function suggestAssets(projectId: string, episodeId: string, recoveryTaskId?: string, reviewedSourceNames:Record<string,string>={},reviewedEvidence:Record<string,string>={},reviewedStateTriggers:Record<string,string>={}) {
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  if (!episode || !episode.scriptLockedHash || episode.scriptLockedHash !== scriptHash(episode))
    throw new Error('请先锁定正式剧本');
  const adapter = configured(project.textModel?.adapterPath, '文本模型');
  const fingerprint = episode.scriptLockedHash;
  const request = {
    task: 'asset-extract', projectId, model: project.textModel?.modelId, beats: episode.scriptBeats,
    existingAssets: (project.assets || []).map(asset => ({ kind: asset.kind, name: asset.name,
      identity: asset.identity, states: asset.states.map(state => state.label) })),
  };
  let result: {assets?:unknown};
  if(recoveryTaskId){
    const row=db.prepare("SELECT snapshot,output_path FROM adapter_tasks WHERE id=? AND project_id=? AND task='asset-extract' AND status='completed'").get(recoveryTaskId,projectId);
    if(!row)throw new Error('No completed asset response for this project');
    const saved=JSON.parse(String(row.snapshot));
    const { compatibleAssetRecoveryInput } = await import('./asset-recovery-input.js');
    if(saved.adapter!==adapter||!compatibleAssetRecoveryInput(saved.request,request))throw new Error('Saved asset input differs from current locked script/model/assets');
    result=JSON.parse(readFileSync(String(row.output_path),'utf8'));
  }else result=await runJsonAdapter<{assets?:unknown}>(adapter,request);
  if (!Array.isArray(result.assets) || result.assets.length > 100)
    throw new Error('文本模型未返回有效的资产清单');
  const scriptText = episode.scriptBeats.flatMap(beat => [beat.sourceQuote, beat.event, beat.reaction,
    ...beat.dialogue, ...beat.os, ...beat.floatLabels, ...beat.systemPanels]).join('\n');
  const entries: AssetSuggestion[] = result.assets.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('资产建议格式无效');
    const item = raw as Record<string, unknown>;
    const kind = String(item.kind || ''), name = String(item.name || '').trim();
    const identity = String(item.identity || '').trim(), voice = String(item.voice || '').trim();
    const checkedEvidence=reviewedAssetEvidence(String(item.evidence||'').trim(),scriptText,recoveryTaskId?reviewedEvidence[name]:undefined);
    const evidence = checkedEvidence.evidence;
    const sourceName=assetEvidenceName(name,evidence,scriptText,recoveryTaskId?reviewedSourceNames[name]:undefined);
    if (!['character', 'scene', 'prop'].includes(kind) || !name || name.length > 80 ||
      !evidence.includes(sourceName) || !scriptText.includes(evidence) || evidence.length < 4 ||
      identity.length > 2000 || voice.length > 300)
      throw new Error(`资产“${name || '未命名'}”缺少正式剧本中的逐字依据`);
    let state: AssetSuggestion['state'];
    if (item.state != null) {
      if (!item.state || typeof item.state !== 'object' || Array.isArray(item.state))
        throw new Error(`资产“${name}”的状态格式无效`);
      const value = item.state as Record<string, unknown>;
      const startSegment = Number(value.startSegment), modelTrigger = String(value.trigger || '').trim();
      const beat = episode.scriptBeats[startSegment - 1];
      const trigger = recoveryTaskId && reviewedStateTriggers[name]!==undefined
        ? reviewedAssetEvidence(modelTrigger,beat ? beat.event+'\n'+beat.reaction : '',reviewedStateTriggers[name]).evidence : modelTrigger;
      if (!Number.isInteger(startSegment) || !beat || !trigger ||
        !(beat.event + '\n' + beat.reaction).includes(trigger))
        throw new Error(`资产“${name}”的状态变化缺少对应片段的正式依据`);
      const label = String(value.label || '').trim(), appearance = String(value.appearance || '').trim();
      if (!label || !appearance || label.length > 80 || appearance.length > 2000)
        throw new Error(`资产“${name}”的状态描述无效`);
      const actualSegment=episode.segments.find(s=>s.beatId===beat.id||s.storyUnitIds?.some(unit=>unit.startsWith(beat.id+':')))?.number;
      if(!actualSegment)throw new Error(`Asset state trigger beat has no segment`);
      state = { label, appearance, trigger, startSegment:actualSegment, ...(trigger!==modelTrigger?{modelTrigger}:{}) };
    }
    return { kind: kind as AssetSuggestion['kind'], name, identity, ...checkedEvidence, ...(sourceName!==name?{sourceName}:{}),
      ...(kind === 'character' ? { voice } : {}), ...(state ? { state } : {}) };
  });
  updateProject(projectId, current => {
    const target = current.episodes.find(item => item.id === episodeId);
    if (!target || target.scriptLockedHash !== fingerprint || scriptHash(target) !== fingerprint)
      throw new Error('生成期间正式剧本已变化，请重新提取资产');
    target.assetCandidate = { scriptHash: fingerprint, entries, createdAt: now() };
  });
  return { assets: entries.length };
}

export async function suggestSubshots(projectId: string, episodeId: string, segmentId: string, attemptLimit?:number) {
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  const segment = episode?.segments.find(item => item.id === segmentId);
  if (!episode || !segment || episode.scriptLockedHash !== scriptHash(episode))
    throw new Error('请先锁定正式剧本并选择片段');
  if (!segment.visualPlan.trim()) throw new Error('请先保存本片段的视觉与机位计划');
  const beat = beatFor(episode, segment), fingerprint = storyboardSourceHash(episode, segment);
  const previous = episode.segments[segment.number - 2], next = episode.segments[segment.number];
  const availableAssets = segmentReferences(project, episode, segment).map(ref => ({
    id: ref.assetId, kind: ref.kind, name: ref.name, state: ref.stateLabel }));
  const adapter = configured(project.textModel?.adapterPath, '文本模型');
  const spokenLines = [...beat.dialogue.map((line, index) => ({ kind: '对白', index, line })),
    ...beat.os.map((line, index) => ({ kind: '内心OS', index, line }))]
    .map(item => ({ ...item, minimumSec: Math.round(item.line.replace(/^[^：:]+[：:]/u, '')
      .replace(/[，。！？；、\s…]/gu, '').length / 3.5 * 10) / 10 }));
  let feedback = '';
  const profileFile = process.env.MANJU_BATCH_BUDGET_PROFILE;
  const maxAttempts = attemptLimit===1 || profileFile && JSON.parse(readFileSync(profileFile, 'utf8')).projectId === projectId ? 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const result = await runJsonAdapter<{ shots?: unknown }>(adapter, {
    task: 'storyboard-shots', projectId, model: project.textModel?.modelId,
    segmentNumber: segment.number, durationSec: segment.durationSec,
    beat, visualPlan: segment.visualPlan, availableAssets, spokenLines,
    previousEndFrame: previous?.subshots?.at(-1)?.endFrame || '',
    nextBeat: next ? beatFor(episode, next) : undefined,
    instruction: `只依据锁定剧本及视觉计划规划子镜。先按 spokenLines 中逐句最低发声秒数安排声音时间窗，再确定切镜时间和动作。每句对白/OS 从标注子镜开始，到下一句开始前必须有足够时间说完；声音可跨镜，镜头切换不得截断或让角色赶词。lineRefs 的 dialogue、os、floatLabels、systemPanels 四类都必须是从 0 开始的整数数组，只有该类存在的条目才能引用；第 1 条写 0，不可写字符串或 1。每镜给出正式事件/人物反应的逐字依据、唯一物理场景、前置状态、动作、可见结果、末帧，以及本镜实际资产 ID；资产只可从已绑定清单选。战斗镜头明确攻防双方、起始左右关系与持械手、原定路径、接触/格挡/闪避判定、受力方向、人物反馈和收势；只拆解已经写出的攻击，不凑满五阶段、不增加攻击次数或伤势。白闪、爆墨与冲击声只在一次真实接触同拍出现，闪避和落空不能表现为命中；特效不能遮挡正式反应或文字。浮签/系统全文须留足可读窗口和画面留白，不能缩写或漏项，过载时指出需要正式拆分。禁止新增剧情、纯空镜、重复动作、冗余反应、长静态停留和长运镜。首镜承接上一片段末帧，末镜交接下一剧情节点；对白/OS仅标起始镜。${feedback}`,
  });
  try {
  if (!Array.isArray(result.shots) || result.shots.length < 2 || result.shots.length > 12)
    throw new Error('文本模型未返回有效子镜列表');
  const shots: Subshot[] = result.shots.map((raw: unknown, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`子镜 ${index + 1} 格式无效`);
    const value = raw as Record<string, unknown>;
    const evidence = String(value.evidence || '').trim();
    if (evidence.length < 4 || !(beat.event + '\n' + beat.reaction).includes(evidence))
      throw new Error(`子镜 ${index + 1} 缺少正式剧本中的逐字依据`);
    const framing = String(value.framing || '').trim(), action = String(value.action || '').trim();
    const location = String(value.location || '').trim(), priorState = String(value.priorState || '').trim();
    const visibleResult = String(value.result || '').trim(), endFrame = String(value.endFrame || '').trim();
    const assetIds = value.assetIds;
    if (!Array.isArray(assetIds) || assetIds.some(assetId =>
      typeof assetId !== 'string' || !availableAssets.some(asset => asset.id === assetId)))
      throw new Error(`子镜 ${index + 1} 引用了未绑定资产`);
    if (framing.length > 100 || action.length > 800)
      throw new Error(`子镜 ${index + 1} 描述过长，请拆分镜头，不能截断正式剧情`);
    const lineRefs = {} as Subshot['lineRefs'];
    const input = value.lineRefs;
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error(`子镜 ${index + 1} 缺少正式声音与可见信息分配`);
    for (const kind of ['dialogue', 'os', 'floatLabels', 'systemPanels'] as const) {
      const refs = (input as Record<string, unknown>)[kind];
      if (!Array.isArray(refs) || refs.some(ref => !Number.isInteger(ref)))
        throw new Error(`子镜 ${index + 1} 的 ${kind} 序号无效`);
      lineRefs[kind] = refs as number[];
    }
    return { id: id(), startSec: Number(value.startSec), endSec: Number(value.endSec),
      framing, action, evidence, location, priorState, result: visibleResult, endFrame,
      assetIds: assetIds as string[], lineRefs };
  });
  const issues = validateSubshots(beat, { ...segment, subshots: shots });
  if (issues.length) throw new Error(`分镜校验失败：${issues.join('；')}`);
  const warnings = pacingWarnings(beat, { ...segment, subshots: shots });
  if (warnings.some(item => item.startsWith('子镜')) && attempt === 0 && maxAttempts > 1) {
    feedback = `上次结果存在节奏风险，请在不改变锁定剧情和对白的前提下修正：${warnings.join('；')}`;
    continue;
  }
  updateProject(projectId, current => {
    const target = current.episodes.find(item => item.id === episodeId);
    const currentSegment = target?.segments.find(item => item.id === segmentId);
    if (!target || !currentSegment || storyboardSourceHash(target, currentSegment) !== fingerprint)
      throw new Error('生成期间正式剧本、时长或视觉计划已变化，请重新规划');
    currentSegment.subshotCandidate = { sourceHash: fingerprint, shots, warnings, createdAt: now() };
  });
  return { shots: shots.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (attempt === 0 && maxAttempts > 1) { feedback = `上次结果被拒绝，请纠正格式与时间分配，不得删词或改剧情：${reason}`; continue; }
    throw new Error(`文本模型两次规划的子镜均未通过校验：${reason}`);
  }
  }
  throw new Error('文本模型未返回可用分镜');
}

export async function generateAssetImage(projectId: string, assetId: string, stateId: string, role = 'main',candidate?:{project:Project;candidateId:string;batchId?:string;feedback?:string},options:{sourceImageId?:string;references?:ImageReference[]}={}) {
  const project = candidate?.project || getProject(projectId), asset = project.assets?.find(item => item.id === assetId);
  if (!asset) throw new Error('资产不存在');
  const state = stateId ? asset.states.find(item => item.id === stateId) : undefined;
  if (stateId && !state) throw new Error('资产状态不存在');
  assertAssetImageRole(asset,role);
  const fingerprint = assetInputHash(project, assetId, stateId);
  if(candidate) {
    const live=getProject(projectId);
    if(assetInputHash(live,assetId,stateId)!==fingerprint || JSON.stringify(live.imageModel)!==JSON.stringify(project.imageModel)) throw new Error('排队后资产或图片模型已变化；未提交生成');
  }
  const adapter = configured(project.imageModel?.adapterPath, '图片模型');
  const references = assetImageReferences(project,assetId,stateId,role,options.sourceImageId);
  if(options.references&&JSON.stringify(options.references)!==JSON.stringify(references))throw Error('排队后参考图已变化；未提交生成');
  if(candidate&&JSON.stringify(assetImageReferences(getProject(projectId),assetId,stateId,role,options.sourceImageId))!==JSON.stringify(references))throw Error('排队后参考图选用已变化；未提交生成');
  const output = await runFileAdapter(adapter, { task: 'asset-image', projectId, ...(candidate?{candidateId:candidate.candidateId,batchId:candidate.batchId}:{}), model: project.imageModel?.modelId,
      ...(references.length ? { references } : {}),
      asset: { id:asset.id, kind: asset.kind, name: asset.name, identity: asset.identity, referenceRole: role,
      state: state ? { label: state.label, appearance: state.appearance } : null },
    visualStyle: project.visualStyle, aspectRatio: project.aspectRatio || '16:9',
      instruction: candidatePrompt(role === 'turnaround' ?
        `只生成“${asset.name}”当前剧情形态的一张完整四视图＋大头照设定图：横向依次正面完整全身、90°侧面完整全身、背面完整全身、正面大头近照（可含肩领，脸或对应动物头部占本格至少60%）。前三格顶脚完整、同一比例；第四格不是45°全身图。四格必须是同一身份、同一发型、衣着、配色或鳞甲与当前伤势。数量按登记身份或当前状态，成组资产不缩成单只。白色或浅灰纯净背景，无格内文字、标题、水印、额外人物、道具小窗或剧情场面。整张图直接作为同一角色的身份、体态与服装参考，不裁切、不拆成独立全身照或头图；剧情视频按正式镜头执行，不模仿拼图布局。` : asset.kind === 'scene' ?
      '只生成场景环境参考图：画面中不得出现人、动物、蛇、龙、怪物、角色或可读文字。依据场景描述呈现地形、光照与空间，不加入剧情事件或伤口。' :
      asset.kind === 'character' ?
        `只生成“${asset.name}”登记的角色外形。数量严格按当前状态，基础图按身份描述，一组动物不缩成一只。单幅、完整形态、灰底，无额外演员、文字或剧情场面；仅保留登记当前形态的伤势、服装及持物，不提前加入其他状态。` :
          '只生成登记的道具或明确必要的一组组成。单幅一个视角、完整轮廓、中性灰色空背景；无桌台、展示架、房间、其他道具、人手或可读文字，道具本身为桌椅时独立展示。',candidate?.feedback) }, '.png', 65 * 60_000);
  if (!statSync(output).size || !readFileSync(output).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error('图片适配器未返回有效 PNG');
  const folder = mediaPath(path.join('assets', assetId));
  mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `${id()}.png`);
  copyFileSync(output, target);
  const relative = relativeMedia(target);
  let retainedAsOldVersion=false;
  updateProject(projectId, current => {
    const currentAsset = current.assets?.find(item => item.id === assetId);
    if (!currentAsset) throw new Error(`资产已删除；生成结果已保留在 ${relative}`);
    retainedAsOldVersion=assetInputHash(current, assetId, stateId) !== fingerprint || !!(stateId && !currentAsset.states.some(item => item.id === stateId));
    currentAsset.images.push({ id: id(), ...(role==='turnaround'?{layout:'three-view-portrait' as const}:{}),...(references.length?{referenceImages:references.map(r=>({imageId:r.imageId,fileHash:r.fileHash}))}:{}), ...(candidate?{candidateId:candidate.candidateId,batchId:candidate.batchId}:{}), ...(stateId ? { stateId } : {}), role: role as 'main' | 'turnaround' | 'portrait', mediaPath: relative,
      createdAt: now(), source: 'model', inputHash: fingerprint, retainedAsOldVersion,
      generationInput:{asset:{id:asset.id,kind:asset.kind,name:asset.name,identity:asset.identity,voice:asset.voice,state},
        visualStyle:project.visualStyle,aspectRatio:project.aspectRatio,modelId:project.imageModel?.modelId} });
  });
  return { mediaPath: relative, retainedAsOldVersion };
}

export async function suggestSemanticEffects(projectId: string, episodeId: string) {
  const project = getProject(projectId), episode = project.episodes.find(item => item.id === episodeId);
  if (!episode?.scriptLockedHash) throw new Error('请先锁定正式剧本');
  const adapter = configured(project.textModel?.adapterPath, '文本模型');
  const catalog = listEffects('').filter(item => item.localAdaptation)
    .map(item => ({ id: item.id, name: item.name, category: item.category }));
  const result = await runJsonAdapter<{ matches?: unknown }>(adapter, {
    task: 'effect-match', projectId, model: project.textModel?.modelId, catalog,
    segments: episode.segments.map(segment => {
      const beat = beatFor(episode,segment);
      return { segmentId: segment.id, event: beat.event, reaction: beat.reaction };
    }),
    instruction: '只从现有可适配目录选择特效；每条给出逐字出自正式事件或人物反应的依据，不得从对白或假设句新增动作。',
  });
  if (!Array.isArray(result.matches) || result.matches.length > 100)
    throw new Error('模型特效建议格式错误');
  const grouped = new Map<string, { id: string; evidence: string }[]>();
  for (const raw of result.matches) {
    if (!raw || typeof raw !== 'object') throw new Error('模型特效建议条目格式错误');
    const match = raw as Record<string, unknown>, segmentId = String(match.segmentId || ''),
      effectId = String(match.effectId || ''), evidence = String(match.evidence || '').trim();
    const segment = episode.segments.find(item => item.id === segmentId);
    const beat = episode.scriptBeats.find(item => item.id === segment?.beatId);
    if (!segment || !beat || !evidence || !(beat.event + '\n' + beat.reaction).includes(evidence))
      throw new Error('特效建议没有正式事件/反应的逐字依据');
    checkedEffectEvidence(effectId, evidence, beat.event + '\n' + beat.reaction);
    effectVersion(effectId);
    const entries = grouped.get(segmentId) || [];
    if (!entries.some(item => item.id === effectId)) entries.push({ id: effectId, evidence });
    grouped.set(segmentId, entries);
  }
  updateProject(projectId, current => {
    const target = current.episodes.find(item => item.id === episodeId);
    if (!target || target.scriptLockedHash !== episode.scriptLockedHash)
      throw new Error('剧本在匹配期间变化，请重新生成建议');
    for (const segment of target.segments) {
      const beat = beatFor(target,segment);
      segment.effectCandidates = { sourceHash: digest({ beat, catalogVersion }),
        entries: grouped.get(segment.id) || [] };
    }
  });
  return { candidates: result.matches.length };
}
