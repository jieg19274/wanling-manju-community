import {approvalHash,auditEpisode,beatFor,contentHash,highlightHash,scriptHash,selectedArtifact,selectedPromptContractIssues,sourceHash,validateSubshots,videoReferences,promptReadiness,type Project} from './model.js';
import {assetInputHash,usableVideo} from './generation.js';
import {storyReviewHash} from './story-review.js';

export type ProgressDelivery='package'|'video';
export interface ProgressStep {label:string;message:string;tab:'source'|'script'|'assets'|'review'|'export';segmentId?:string}
export interface EpisodeProgress {
  id:string;number:number;title:string;sourceReviewed:boolean;highlightReviewed:boolean;scriptLocked:boolean;
  segments:number;storyboardsReviewed:number;promptsSaved:number;promptsCurrent:number;videosSaved:number;videosCurrent:number;videosApproved:number;audited:boolean;
  ready:Record<ProgressDelivery,boolean>;next:Record<ProgressDelivery,ProgressStep>;
}
export interface ProjectProgress {
  projectId:string;projectName:string;updatedAt:string;
  totals:{episodes:number;sourceReviewed:number;highlightReviewed:number;scriptsLocked:number;segments:number;storyboardsReviewed:number;promptsSaved:number;promptsCurrent:number;videosSaved:number;videosCurrent:number;videosApproved:number;auditedEpisodes:number;assets:number;referenceImages:number;referenceImagesCurrent:number};
  episodes:EpisodeProgress[];
  workflows:{episodeId:string;status:string;label:string;message:string;error?:string}[];
  deliverables:{episodeId:string;kind:string;available:boolean}[];
}

// Summarize saved project data, including projects made before software Agent chats.
// This is read-only: it neither approves a gate nor starts or retries generation.
export function summarizeProjectProgress(project:Project,mediaAvailable:(file:string)=>boolean=()=>true):ProjectProgress {
  const available=(file?:string)=>!!file&&mediaAvailable(file);
  const episodes=project.episodes.map(episode=>{
    const sourceReviewed=episode.sourceText.trim().length>=50&&episode.sourceReviewedHash===sourceHash(episode);
    const highlightReviewed=!!episode.highlightReport.trim()&&episode.highlightReviewedHash===highlightHash(episode);
    const scriptLocked=!!episode.scriptBeats.length&&episode.scriptLockedHash===scriptHash(episode);
    const rows=episode.segments.map(segment=>{
      const prompt=selectedArtifact(segment,'prompt'),video=selectedArtifact(segment,'video');
      let storyboard=false,references=false,promptCurrent=false;
      try{
        storyboard=scriptLocked&&!!segment.visualPlan.trim()&&segment.subshotsReviewed===true&&!!segment.subshots?.length&&validateSubshots(beatFor(episode,segment),segment).length===0;
      }catch{/* Invalid legacy storyboards remain pending. */}
      try{
        const refs=videoReferences(project,episode,segment);references=!!segment.assetBindings?.length&&refs.length>0&&refs.every(ref=>available(ref.mediaPath));
      }catch{/* Missing or outdated reference bindings remain pending. */}
      try{promptCurrent=scriptLocked&&!!prompt?.content&&prompt.sourceHash===contentHash(episode,segment)&&selectedPromptContractIssues(episode,segment,project).length===0;}catch{}
      const videoCurrent=!!video&&available(video.mediaPath)&&!video.demo&&usableVideo(project,episode,segment,video);
      const videoApproved=videoCurrent&&(video?.review?.status==='approved'||(video?.userAcceptance?.status==='accepted'&&video.userAcceptance.generationHash===video.generationHash));
      return {segment,storyboard,references,promptCurrent,videoCurrent,videoApproved};
    });
    const sum=(key:'storyboard'|'promptCurrent'|'videoCurrent'|'videoApproved')=>rows.filter(row=>row[key]).length;
    const storyReviewed=!episode.sourceTraceRequired||episode.storyReview?.hash===storyReviewHash(episode);
    let auditIssues:string[];
    try{auditIssues=auditEpisode(episode,project);}catch{auditIssues=['正式分镜结构不完整，请核对片段与锁定剧本的对应关系'];}
    const audited=sourceReviewed&&highlightReviewed&&scriptLocked&&rows.length>0&&rows.every(row=>row.storyboard&&row.references&&row.promptCurrent)&&storyReviewed&&auditIssues.length===0&&episode.auditApprovedHash===approvalHash(episode);
    const pending=rows.find(row=>!row.segment.assetBindings?.length),references=rows.find(row=>!row.references),storyboard=rows.find(row=>!row.storyboard),prompt=rows.find(row=>!row.promptCurrent),video=rows.find(row=>!row.videoApproved);
    const step=(label:string,message:string,tab:ProgressStep['tab'],segmentId?:string):ProgressStep=>({label,message,tab,...(segmentId?{segmentId}:{})});
    let common:ProgressStep|undefined;
    if(!sourceReviewed)common=step('确认完整原文','完整阅读本集原文并确认阅读记录。','source');
    else if(!highlightReviewed)common=step('核对高光报告','补齐或核对当前原文的高光剧情报告。','source');
    else if(!scriptLocked)common=step('核对并锁定剧本',episode.scriptLockedHash?'剧本版本已变化，重新核对后锁定。':'已有草稿或候选可继续核对，保留已保存内容。','script');
    else if(!storyReviewed)common=step('核对原文覆盖','正式剧本的原文覆盖记录尚未确认或已过期；核对后再制作资产与参考图。','script');
    else if(!rows.length)common=step('建立正式分镜片段','按锁定剧本建立片段，保留全部剧情和对白。','script');
    else if(episode.assetCandidate?.scriptHash===episode.scriptLockedHash)common=step('核对资产清单','已有资产提取候选，核对后采用并检查片段绑定。','assets');
    else if(pending)common=step('补齐资产绑定',`片段 ${pending.segment.number} 尚未绑定人物、场景或道具。`,'assets',pending.segment.id);
    else if(references)common=step('补齐并选用参考图',`从片段 ${references.segment.number} 检查起：当前状态的参考图尚未齐备、审核或选用。`,'assets',references.segment.id);
    else if(storyboard)common=step('逐镜核对分镜',`继续片段 ${storyboard.segment.number} 的视觉机位与正式分镜核对。`,'review',storyboard.segment.id);
    else if(prompt){const readiness=promptReadiness(episode,prompt.segment,project);common=readiness.state==='candidate'?
      step('核对并选用新提示词',`片段 ${prompt.segment.number} 的新版已生成，请比较并选用，无需重复生成。`,'review',prompt.segment.id):
      step('补齐完整视频提示词',`片段 ${prompt.segment.number} 的当前提示词缺失或有实际内容问题，请核对本片段。`,'review',prompt.segment.id);}
    else if(!audited)common=step('五层核对放行',auditIssues.slice(0,6).join('；')||'核对原文、高光、剧本、分镜、导入版与提示词后放行本集。','export');
    const packageStep=common||step('查看或导出生产包','本集已有当前版本的五层放行记录，可查看已有交付或导出生产包。','export');
    const videoStep=common||(video?step('继续生成与审片',`片段 ${video.segment.number} 尚无当前版本审核通过的选用视频；先检查已有候选或原任务。`,'review',video.segment.id):step('查看或合成成片','本集选用视频已审核或验收，可检查导出记录并合成成片。','export'));
    return {id:episode.id,number:episode.number,title:episode.title,sourceReviewed,highlightReviewed,scriptLocked,segments:rows.length,storyboardsReviewed:sum('storyboard'),promptsSaved:episode.segments.filter(s=>s.artifacts.some(a=>a.kind==='prompt'&&a.content)).length,promptsCurrent:sum('promptCurrent'),videosSaved:episode.segments.filter(s=>s.artifacts.some(a=>a.kind==='video'&&a.mediaPath&&!a.demo)).length,videosCurrent:sum('videoCurrent'),videosApproved:sum('videoApproved'),audited,ready:{package:audited,video:audited&&!video},next:{package:packageStep,video:videoStep}};
  });
  const count=(key:'sourceReviewed'|'highlightReviewed'|'scriptLocked'|'audited')=>episodes.filter(e=>e[key]).length;
  const sum=(key:'segments'|'storyboardsReviewed'|'promptsSaved'|'promptsCurrent'|'videosSaved'|'videosCurrent'|'videosApproved')=>episodes.reduce((n,e)=>n+e[key],0);
  const assets=project.assets||[],images=assets.flatMap(asset=>asset.images.map(image=>({asset,image})));
  return {projectId:project.id,projectName:project.name,updatedAt:project.updatedAt,episodes,workflows:[],deliverables:[],totals:{episodes:episodes.length,sourceReviewed:count('sourceReviewed'),highlightReviewed:count('highlightReviewed'),scriptsLocked:count('scriptLocked'),segments:sum('segments'),storyboardsReviewed:sum('storyboardsReviewed'),promptsSaved:sum('promptsSaved'),promptsCurrent:sum('promptsCurrent'),videosSaved:sum('videosSaved'),videosCurrent:sum('videosCurrent'),videosApproved:sum('videosApproved'),auditedEpisodes:count('audited'),assets:assets.length,referenceImages:images.filter(({image})=>available(image.mediaPath)).length,referenceImagesCurrent:images.filter(({asset,image})=>available(image.mediaPath)&&image.review?.status==='approved'&&image.inputHash===assetInputHash(project,asset.id,image.stateId)).length}};
}
