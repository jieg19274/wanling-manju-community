import { beatFor, subshotsFor, type Episode, type Project, type Segment } from '../shared/model';
import { DEFAULT_LABEL_STYLE, LABEL_PRESETS, TRIGGERS, PHASES, OUTCOMES, SCOPES, INTENSITIES, defaultExecutionPlan, labelAppearance, validateLabelStyle, visibleText, finalPlaybackWarnings,
  type ExecutionPlan, type EffectCue, type LabelStyle, type VisibleCue } from '../shared/execution-plan';
import './execution-panel.css';

const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const options=(values:Record<string,string>,selected:unknown)=>Object.entries(values).map(([id,label])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(label)}</option>`).join('');
const field=(root:Element,name:string)=>root.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[data-field="${name}"]`);
const value=(root:Element,name:string)=>field(root,name)?.value||'';
const checked=(root:Element,name:string)=>(field(root,name) as HTMLInputElement|null)?.checked===true;
const num=(root:Element,name:string)=>Number(value(root,name));
const input=(name:string,label:string,v:unknown,type='text',attrs='')=>`<label>${esc(label)}<input name="${esc(name)}" data-field="${esc(name)}" type="${type}" value="${esc(v)}" ${attrs}/></label>`;
const select=(name:string,label:string,list:Record<string,string>,v:unknown)=>`<label>${esc(label)}<select name="${esc(name)}" data-field="${esc(name)}">${options(list,v)}</select></label>`;
export type LabelFontStatus = {checked:boolean;families:string[];note?:string};
export function renderLabelStyle(style=DEFAULT_LABEL_STYLE, fonts?:LabelFontStatus, prefix='font'):string {
  const a=labelAppearance(style),b=labelAppearance(style,true);
  return `<div class="label-style-editor" data-label-style data-style-prefix="${prefix}"><div class="execution-grid">${select(`${prefix}-preset`,'字体风格',Object.fromEntries(Object.entries(LABEL_PRESETS).map(([id,p])=>[id,p.name])),style.preset)}${select(`${prefix}-size`,'字号',{normal:'正常字号',large:'加大字号'},style.size)}</div><div class="label-font-preview" aria-label="浮签字体预览"><span data-font-preview="label" style="font-family:'${a.font}','宋体',serif;color:${a.color}">人物：陆贤 · 场景：演武场</span><span data-font-preview="system" style="font-family:'${b.font}','微软雅黑',sans-serif;color:${b.color}">系统：体力 100/100 · 03:00</span></div><p class="muted">人物、场景和时间用雅致字形，系统数字保持清晰。模型生成按字形风格指导，本地纠字使用实际字体。</p>${fonts?`<small>${fonts.checked?`已检测本机中文字体：${esc(fonts.families.join('、')||'未找到可用字体')}`:esc(fonts.note||'本机字体检测暂不可用')}</small>`:''}</div>`;
}
export function readLabelStyle(root:Element):LabelStyle {
  const editor=root.matches('[data-label-style]')?root:root.querySelector('[data-label-style]');
  if(!editor)throw Error('字体样式入口不存在');
  const prefix=(editor as HTMLElement).dataset.stylePrefix||'font';
  return validateLabelStyle({preset:value(editor,`${prefix}-preset`),size:value(editor,`${prefix}-size`)});
}
function visibleRow(project:Project,beat:ReturnType<typeof beatFor>,cue:VisibleCue,index:number,prefix:string,repair=false) {
  const p=`${prefix}-${index}`,assets=Object.fromEntries((project.assets||[]).map(a=>[a.id,a.name]));
  return `<fieldset class="execution-row" data-visible-row data-kind="${cue.kind}" data-index="${cue.index}" data-subshot-id="${esc(cue.subshotId)}" data-prefix="${p}"><legend>${repair?`<label><input name="${p}-enabled" data-field="${p}-enabled" type="checkbox"/>修正此项</label> `:''}${esc(visibleText(beat,cue))}</legend><p class="formal-label-text">正式全文：${esc(visibleText(beat,cue))}</p><div class="execution-grid">${input(`${p}-start`,'出现（秒）',cue.startSec,'number','min="0" step="0.05"')}${input(`${p}-end`,'消失（秒）',cue.endSec,'number','min="0" step="0.05"')}${select(`${p}-placement`,'归属',{hud:'画面HUD',object:'对应人物/对象'},cue.placement)}${select(`${p}-owner`,'所属人物/对象',{'':'HUD不绑定实体',...assets},cue.ownerId||'')}${input(`${p}-x`,'左侧（%）',cue.x*100,'number','min="4" max="86" step="0.5"')}${input(`${p}-y`,'顶部（%）',cue.y*100,'number','min="4" max="87" step="0.5"')}${input(`${p}-width`,'区域宽（%）',cue.width*100,'number','min="10" max="92" step="0.5"')}${input(`${p}-height`,'区域高（%）',cue.height*100,'number','min="5" max="88" step="0.5"')}${!repair&&cue.kind==='systemPanels'?select(`${p}-layer`,'显示方式',{model:'模型原生显示',overlay:'原生空面板＋后期精确覆盖'},cue.layer):`<input type="hidden" data-field="${p}-layer" value="model"/>`}</div></fieldset>`;
}
export function renderExecutionPanel(project:Project,episode:Episode,segment:Segment) {
  const beat=beatFor(episode,segment),shots=subshotsFor(beat,segment),defaults=defaultExecutionPlan(beat,segment,shots,project.labelStyle);
  const saved=segment.executionPlan,plan=saved?{...saved,visible:defaults.visible.map(cue=>{
    const previous=saved.visible.find(c=>c.kind===cue.kind&&c.index===cue.index);
    return previous?{...previous,...(previous.subshotId===cue.subshotId?{}:{subshotId:cue.subshotId,startSec:cue.startSec,endSec:cue.endSec})}:cue;
  })}:defaults;
  const shotOptions=Object.fromEntries(shots.map((s,i)=>[s.id,`子镜${i+1} · ${s.startSec}–${s.endSec}秒 · ${s.framing}`])),assets=Object.fromEntries((project.assets||[]).map(a=>[a.id,a.name]));
  const effects:EffectCue[]=plan.effects.length?plan.effects:segment.effectIds.map(effectId=>({effectId,subshotId:shots[0].id,startSec:shots[0].startSec,endSec:shots[0].endSec,trigger:'cast' as const,scope:'local' as const,intensity:'medium' as const,evidence:segment.effectEvidence[effectId],description:''}));
  return `<details class="execution-editor" data-execution-editor data-segment-id="${segment.id}"><summary>特效、战斗与浮签执行计划${segment.executionPlan?' · 已保存':' · 按需启用'}</summary><p>只展开正式动作。保存计划会让本段进入核对；已有片段不自动套用新计划。</p>${renderLabelStyle(plan.labelStyle,undefined,'plan-font')}<h4>逐镜特效</h4>${effects.map((c,i)=>{const p=`effect-${i}`;return `<fieldset class="execution-row" data-effect-cue data-effect-id="${esc(c.effectId)}" data-prefix="${p}"><legend>${esc(c.effectId)}</legend><div class="execution-grid">${select(`${p}-shot`,'所属子镜',shotOptions,c.subshotId)}${input(`${p}-start`,'触发（秒）',c.startSec,'number','step="0.05"')}${input(`${p}-end`,'结束（秒）',c.endSec,'number','step="0.05"')}${select(`${p}-trigger`,'触发动作',TRIGGERS,c.trigger)}${select(`${p}-actor`,'施放者',{'':'正式动作对象',...assets},c.actorId||'')}${select(`${p}-target`,'作用对象',{'':'正式动作对象',...assets},c.targetId||'')}${select(`${p}-scope`,'范围',SCOPES,c.scope)}${select(`${p}-intensity`,'强度',INTENSITIES,c.intensity)}${input(`${p}-evidence`,'正式逐字依据',c.evidence)}</div><button type="button" data-action="add-effect-cue">另加一个正式触发时窗</button></fieldset>`;}).join('')||'<p class="muted">先在特效库绑定有正式依据的条目。</p>'}<h4>战斗动作与状态</h4><p class="muted">只勾选已有战斗动作的子镜；同一次攻击使用相同编号，保留左右关系、持械手与正式结果。</p>${shots.map((shot,index)=>{const c=plan.combat.find(c=>c.subshotId===shot.id),p=`combat-${index}`;return `<details class="combat-row" data-combat-cue data-subshot-id="${esc(shot.id)}" data-prefix="${p}" ${c?'open':''}><summary>子镜${index+1} · ${esc(shot.action)}</summary><label class="check"><input name="${p}-enabled" data-field="${p}-enabled" type="checkbox" ${c?'checked':''}/>本镜有正式战斗动作</label><div class="execution-grid">${input(`${p}-attackKey`,'同次攻击编号',c?.attackKey||'攻击1')}${select(`${p}-attackerId`,'攻方',{'':'选择正式人物',...assets},c?.attackerId||'')}${select(`${p}-defenderId`,'受方',{'':'选择正式人物',...assets},c?.defenderId||'')}${select(`${p}-phase`,'动作阶段',PHASES,c?.phase||'approach')}${select(`${p}-outcome`,'本镜判定',OUTCOMES,c?.outcome||'none')}${input(`${p}-origin`,'起始站位与持械手',c?.origin||shot.priorState||'')}${input(`${p}-path`,'移动/出招路径',c?.path||'')}${input(`${p}-contact`,'接触或避开位置',c?.contact||'')}${input(`${p}-direction`,'受力方向（未受力写无）',c?.direction||'')}${input(`${p}-reaction`,'人物反应',c?.reaction||'')}${input(`${p}-ending`,'结果与末帧',c?.ending||shot.endFrame||'')}${input(`${p}-evidence`,'正式逐字依据',c?.evidence||shot.evidence||'')}</div></details>`;}).join('')}<h4>正式浮签排程</h4><p class="muted">文字直接来自锁定剧本；位置避开脸、手、兵器接触和人物反应，同时显示的区域不能重叠。</p>${plan.visible.map((cue,i)=>visibleRow(project,beat,cue,i,'visible')).join('')||'<p>本段无正式可见文字。</p>'}<div class="actions"><button data-action="save-execution-plan">保存并核对本段计划</button>${segment.executionPlan?'<button data-action="clear-execution-plan">撤回本段执行计划</button>':''}</div></details>${renderLabelRepair(project,episode,segment)}`;
}
export function readVisibleCues(root:Element,repair=false):VisibleCue[] {
  return [...root.querySelectorAll<HTMLElement>('[data-visible-row]')].flatMap(row=>{
    const p=row.dataset.prefix!;if(repair&&!checked(row,`${p}-enabled`))return [];
    return [{kind:row.dataset.kind as VisibleCue['kind'],index:Number(row.dataset.index),subshotId:row.dataset.subshotId!,startSec:num(row,`${p}-start`),endSec:num(row,`${p}-end`),placement:value(row,`${p}-placement`) as VisibleCue['placement'],ownerId:value(row,`${p}-owner`)||undefined,x:num(row,`${p}-x`)/100,y:num(row,`${p}-y`)/100,width:num(row,`${p}-width`)/100,height:num(row,`${p}-height`)/100,layer:value(row,`${p}-layer`) as VisibleCue['layer']}];
  });
}
export function readExecutionPlan(root:Element):ExecutionPlan {
  const effects=[...root.querySelectorAll<HTMLElement>('[data-effect-cue]')].map(row=>{const p=row.dataset.prefix!;return{effectId:row.dataset.effectId!,subshotId:value(row,`${p}-shot`),startSec:num(row,`${p}-start`),endSec:num(row,`${p}-end`),trigger:value(row,`${p}-trigger`),actorId:value(row,`${p}-actor`)||undefined,targetId:value(row,`${p}-target`)||undefined,scope:value(row,`${p}-scope`),intensity:value(row,`${p}-intensity`),evidence:value(row,`${p}-evidence`),description:''};});
  const combat=[...root.querySelectorAll<HTMLElement>('[data-combat-cue]')].flatMap(row=>{const p=row.dataset.prefix!;if(!checked(row,`${p}-enabled`))return[];return[{subshotId:row.dataset.subshotId!,...Object.fromEntries(['attackKey','attackerId','defenderId','phase','outcome','origin','path','contact','direction','reaction','ending','evidence'].map(k=>[k,value(row,`${p}-${k}`)]))}];});
  return {effects,combat,visible:readVisibleCues(root),labelStyle:readLabelStyle(root)} as ExecutionPlan;
}
function renderLabelRepair(project:Project,episode:Episode,segment:Segment) {
  const beat=beatFor(episode,segment),shots=subshotsFor(beat,segment),plan=segment.executionPlan||defaultExecutionPlan(beat,segment,shots,project.labelStyle),videos=segment.artifacts.filter(a=>a.kind==='video'&&a.mediaPath&&!a.demo);
  if(!videos.length||!plan.visible.length)return '';
  const source=videos.find(a=>a.id===segment.selected.video)||videos.at(-1)!;
  return `<details class="label-repair" data-label-repair data-segment-id="${segment.id}"><summary>浮签纠字与字体修正 · 保留原声</summary><p>先在原片定位错字，勾选需修正的正式项并调整覆盖区域。深色底板会覆盖该区域原画面，请避开脸、手和动作。</p>${select('repair-video','原视频版本',Object.fromEntries(videos.map(a=>[a.id,`${a.labelRepair?'浮签修正版':'原视频'} · ${a.id.slice(0,8)}`])),source.id)}${renderLabelStyle(project.labelStyle||DEFAULT_LABEL_STYLE,undefined,'repair-font')}<div class="label-video-preview" data-label-video-preview style="aspect-ratio:${project.aspectRatio?.replace(':','/')||'16/9'}"><video data-label-video controls preload="metadata" src="/media/${esc(source.mediaPath)}"></video><div class="label-preview-overlays" data-label-overlays aria-hidden="true"></div></div>${input('repair-time','定位预览（秒）',0,'range',`min="0" max="${segment.durationSec}" step="0.1"`)}${plan.visible.map((cue,i)=>visibleRow(project,beat,cue,i,'repair-visible',true)).join('')}<label class="check"><input name="repair-confirmed" data-field="repair-confirmed" type="checkbox"/>已核对正式全文、显示时点及覆盖区域，区域不遮住人物和动作</label><button data-action="repair-labels">本地生成浮签修正版</button><button data-action="recover-label-repair" hidden>查询上次修正结果</button><p class="muted">不调用付费模型。原片、原验收保留；新版本保留原生音轨并校验摘要，完成后仍须审片。</p><ul class="playback-warnings">${finalPlaybackWarnings(beat,segment,shots,source).map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`;
}
export function updateLabelPreviews(root:Element,project?:Project,episode?:Episode) {
  for(const editor of root.querySelectorAll<HTMLElement>('[data-label-style]')) {
    const style=readLabelStyle(editor);
    for(const role of ['label','system']) {const el=editor.querySelector<HTMLElement>(`[data-font-preview="${role}"]`),a=labelAppearance(style,role==='system');if(el){el.style.fontFamily=`'${a.font}',${role==='label'?'serif':'sans-serif'}`;el.style.color=a.color;el.style.fontSize=style.size==='large'?'24px':'20px';}}
  }
  if(!project||!episode)return;
  for(const panel of root.querySelectorAll<HTMLElement>('[data-label-repair]')) {
    const segment=episode.segments.find(s=>s.id===panel.dataset.segmentId);if(!segment)continue;
    const video=panel.querySelector<HTMLVideoElement>('[data-label-video]'),artifact=segment.artifacts.find(a=>a.id===value(panel,'repair-video'));
    if(video&&artifact?.mediaPath&&video.getAttribute('src')!==`/media/${artifact.mediaPath}`)video.src=`/media/${artifact.mediaPath}`;
    const beat=beatFor(episode,segment),style=readLabelStyle(panel),time=num(panel,'repair-time'),overlays=panel.querySelector<HTMLElement>('[data-label-overlays]');
    if(overlays)overlays.innerHTML=readVisibleCues(panel,true).filter(c=>time>=c.startSec&&time<c.endSec).map(c=>{const a=labelAppearance(style,c.kind==='systemPanels');return`<span style="left:${c.x*100}%;top:${c.y*100}%;width:${c.width*100}%;height:${c.height*100}%;font-family:'${a.font}';font-size:${a.size*100}cqh;color:${a.color}">${esc(visibleText(beat,c))}</span>`;}).join('');
  }
}
export function addEffectCue(button:HTMLElement) {
  const row=button.closest<HTMLElement>('[data-effect-cue]'),root=button.closest('[data-execution-editor]');if(!row||!root)return;
  const copy=row.cloneNode(true) as HTMLElement,old=row.dataset.prefix!,next=`effect-${root.querySelectorAll('[data-effect-cue]').length}`;copy.dataset.prefix=next;
  for(const el of copy.querySelectorAll<HTMLElement>('[data-field]')) {el.dataset.field=el.dataset.field!.replace(old,next);if(el.hasAttribute('name'))el.setAttribute('name',el.getAttribute('name')!.replace(old,next));}
  row.after(copy);
}
