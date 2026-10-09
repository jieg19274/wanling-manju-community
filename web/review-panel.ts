import type {Episode} from '../shared/model';
import {storyUnits} from '../shared/segmentation';
import {storyReviewHash} from '../shared/story-review';
const esc=(value:unknown)=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function reviewPanel(ep:Episode,configured:boolean) {
  if(!ep.scriptLockedHash) return '';
  const units=storyUnits(ep),numbered=new Map(units.map((unit,index)=>[unit.id,index+1]));
  const groups=ep.segments.map(segment=>(segment.storyUnitIds || units.filter(unit=>unit.beatId===segment.beatId).map(unit=>unit.id)).map(id=>numbered.get(id)).join(',')).join('\n');
  const candidate=ep.semanticCandidate?.hash===storyReviewHash(ep) ? ep.semanticCandidate : undefined;
  return `<section class="panel"><h2>原文语义与高光覆盖核对</h2><p>结构通过与内容已核对分别记录。模型候选仅辅助定位，由人逐项确认后放行。</p>
    <button data-action="suggest-semantic" ${configured?'':'disabled'}>生成语义复核候选</button>${candidate?`<p>候选警告：${esc(candidate.warnings.join('；') || '模型未报告警告，仍须人工核对')}</p>`:''}
    ${ep.scriptBeats.map((beat,index)=>{
      const entry=ep.storyReview?.hash===storyReviewHash(ep) ? ep.storyReview.entries.find(item=>item.beatId===beat.id) : undefined;
      const proposal=candidate?.entries.find(item=>item.beatId===beat.id),start=entry?.sourceStart ?? proposal?.sourceStart ?? Math.max(0,ep.sourceText.indexOf(beat.sourceQuote || ''));
      return `<details data-story-review-beat="${beat.id}"><summary>节点${index+1}：${esc(beat.event)}</summary><pre>${esc(ep.sourceText.slice(Math.max(0,start-100),Math.min(ep.sourceText.length,start+300)))}</pre>
        ${proposal?`<p>模型候选依据：${esc(proposal.notes)}</p>`:''}<label>原文起点<input name="source-start" type="number" value="${start}"></label><label>终点<input name="source-end" type="number" value="${entry?.sourceEnd ?? proposal?.sourceEnd ?? start+(beat.sourceQuote?.length || 0)}"></label>
        ${(ep.highlightItems || []).map(item=>`<label><input type="checkbox" name="highlight-ref" value="${item.id}" ${entry?.highlightIds?.includes(item.id)?'checked':''}>覆盖高光 ${esc(item.text)}</label>`).join('')}
        ${['highlight','event','reaction','speech','labels'].map(key=>`<label><input type="checkbox" name="story-check" value="${key}">${({highlight:'高光覆盖',event:'事件与因果',reaction:'人物反应',speech:'对白/OS及顺序',labels:'浮签/系统信息'} as Record<string,string>)[key]}</label>`).join('')}
        <textarea name="story-notes" placeholder="具体对应关系与核对结论，至少8字">${esc(entry?.notes || '')}</textarea></details>`;
    }).join('')}<button data-action="review-story">保存逐节点语义核对</button>
    <details><summary>固定30秒分段计划</summary><button data-action="suggest-segment-plan" ${configured && !ep.segments.some(segment=>segment.artifacts.length)?'':'disabled'}>文本模型建议声音/动作/反应预算</button>${ep.segmentPlanCandidate?`<pre>${esc(JSON.stringify(ep.segmentPlanCandidate,null,2))}</pre><button data-action="apply-segment-candidate" ${ep.segmentPlanCandidate.warnings.length?'disabled':''}>采用分段候选并重新核对分镜</button>`:''}<p>每行一个片段，按序填写剧情单元序号，必须完整覆盖且不重复。</p><ol>${units.map(unit=>`<li>${esc(unit.text)}</li>`).join('')}</ol><textarea name="segment-plan">${esc(groups)}</textarea><button data-action="apply-segment-plan" ${ep.segments.some(segment=>segment.artifacts.length)?'disabled':''}>采用分段并重新核对分镜</button></details>
    ${ep.segments.length>1?`<details><summary>逐边界独立衔接证据</summary>${ep.segments.slice(1).map((right,index)=>{
      const left=ep.segments[index],record=ep.continuityReview?.entries?.find(entry=>entry.left===left.id && entry.right===right.id);
      return `<fieldset data-boundary-left="${left.id}" data-boundary-right="${right.id}"><legend>片段${left.number} → ${right.number}</legend><p>末帧：${esc(left.subshots?.at(-1)?.endFrame || '待规划')}；入镜：${esc(right.subshots?.[0]?.priorState || '待规划')}</p>${['space','state','frame'].map(key=>`<label><input type="checkbox" name="boundary-check" value="${key}">${({space:'空间一致',state:'人物状态一致',frame:'末帧与入镜衔接'} as Record<string,string>)[key]}</label>`).join('')}<textarea name="boundary-notes" placeholder="本边界具体核对结果，至少8字">${esc(record?.notes)}</textarea></fieldset>`;
    }).join('')}<button data-action="review-continuity">保存每个边界核对</button></details>`:''}</section>`;
}
