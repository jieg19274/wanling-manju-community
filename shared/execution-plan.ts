import type { Artifact, Project, ScriptBeat, Segment, Subshot } from './model.js';

export const LABEL_PRESETS = {
  elegant: { name: '古雅清晰', labelFont: 'Noto Serif SC', systemFont: 'Noto Sans SC', color: '#F1D6A1', outline: '#211A14' },
  wuxia: { name: '武侠楷韵', labelFont: '楷体', systemFont: 'Noto Sans SC', color: '#F1D6A1', outline: '#211A14' },
  clean: { name: '简洁清晰', labelFont: 'Noto Sans SC', systemFont: 'Noto Sans SC', color: '#FFF2D6', outline: '#191C22' },
} as const;
export type LabelStyle = { preset: keyof typeof LABEL_PRESETS; size: 'normal' | 'large' };
export const DEFAULT_LABEL_STYLE: LabelStyle = { preset: 'wuxia', size: 'normal' };
export function validateLabelStyle(value: unknown): LabelStyle {
  if (!value || typeof value !== 'object') throw Error('请选择浮签字体样式');
  const style = value as LabelStyle;
  if (!Object.hasOwn(LABEL_PRESETS, style.preset) || !['normal', 'large'].includes(style.size)) throw Error('浮签字体样式无效');
  return { preset: style.preset, size: style.size };
}
export function labelAppearance(style = DEFAULT_LABEL_STYLE, system = false) {
  const preset = LABEL_PRESETS[style.preset];
  return { font: system ? preset.systemFont : preset.labelFont, color: preset.color, outline: preset.outline,
    size: (system ? .035 : .045) * (style.size === 'large' ? 1.2 : 1) };
}
export type EffectCue = { effectId: string; subshotId: string; startSec: number; endSec: number;
  trigger: 'cast' | 'movement' | 'contact' | 'result' | 'ambient'; actorId?: string; targetId?: string;
  scope: 'local' | 'scene' | 'frame'; intensity: 'low' | 'medium' | 'high'; evidence: string; description: string };
export type CombatCue = { subshotId: string; attackKey: string; attackerId: string; defenderId: string;
  phase: 'windup' | 'approach' | 'contact' | 'reaction' | 'recover'; outcome: 'none' | 'hit' | 'blocked' | 'dodged' | 'miss';
  origin: string; path: string; contact: string; direction: string; reaction: string; ending: string; evidence: string };
export type VisibleCue = { kind: 'floatLabels' | 'systemPanels'; index: number; subshotId: string;
  startSec: number; endSec: number; ownerId?: string; placement: 'hud' | 'object';
  x: number; y: number; width: number; height: number; layer: 'model' | 'overlay' };
export type ExecutionPlan = { effects: EffectCue[]; combat: CombatCue[]; visible: VisibleCue[]; labelStyle: LabelStyle; assetNames?: Record<string,string> };
export const TRIGGERS = { cast: '原定施放', movement: '原定运动', contact: '原定接触同拍', result: '原定结果', ambient: '既定环境' };
export const PHASES = { windup: '起手', approach: '出招/逼近', contact: '接触/避开', reaction: '反馈', recover: '收势' };
export const OUTCOMES = { none: '本镜未发生判定', hit: '命中', blocked: '格挡', dodged: '闪避', miss: '未命中' };
export const SCOPES = { local: '局部', scene: '既定场景', frame: '画面图形' };
export const INTENSITIES = { low: '轻', medium: '中', high: '强' };
const quoteText = (beat: ScriptBeat) => `${beat.event}\n${beat.reaction}`;
const textLength = (line: string) => [...line.replace(/\s/gu, '')].length;
export const minimumVisibleSeconds = (text: string) => Math.max(1.4, textLength(text) / 6 + .35);
export function defaultExecutionPlan(beat: ScriptBeat, segment: Segment, shots: Subshot[], style = DEFAULT_LABEL_STYLE): ExecutionPlan {
  const visible: VisibleCue[] = [];
  for (const shot of shots) {
    let row = 0;
    for (const kind of ['floatLabels', 'systemPanels'] as const) for (const index of shot.lineRefs[kind]) {
      visible.push({ kind, index, subshotId: shot.id, startSec: shot.startSec, endSec: shot.endSec, placement: 'hud',
        x: .06, y: .08 + row++ * .16, width: .55, height: .14, layer: 'model' });
    }
  }
  return { effects: [], combat: [], visible, labelStyle: { ...style } };
}
export function visibleText(beat: ScriptBeat, cue: VisibleCue) { return beat[cue.kind]?.[cue.index] || ''; }
function windowIssues(start: number, end: number, shot: Subshot | undefined, label: string) {
  return !shot || !Number.isFinite(start) || !Number.isFinite(end) || start < shot.startSec - .01 || end > shot.endSec + .01 || end <= start ? [`${label}时窗必须位于所属子镜内`] : [];
}
const overlaps = (a: VisibleCue, b: VisibleCue) => Math.max(a.startSec, b.startSec) < Math.min(a.endSec, b.endSec) &&
  Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width) && Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height);
export function executionPlanIssues(beat: ScriptBeat, segment: Segment, shots: Subshot[], project?: Project, partialVisible = false): string[] {
  const plan = segment.executionPlan;
  if (!plan) return [];
  const issues: string[] = [], source = quoteText(beat), byId = new Map(shots.map(s => [s.id, s]));
  if (!Array.isArray(plan.effects) || !Array.isArray(plan.combat) || !Array.isArray(plan.visible)) return ['执行计划必须包含特效、战斗和浮签清单'];
  if (plan.effects.length > 40 || plan.combat.length > 24 || plan.visible.length > 100) return ['执行计划条目过多，请按正式剧情拆分'];
  try { validateLabelStyle(plan.labelStyle); } catch (error) { issues.push((error as Error).message); }
  const checkAsset = (assetId: string | undefined, shot: Subshot | undefined, label: string) => {
    if (assetId && project && !project.assets?.some(a => a.id === assetId)) issues.push(`${label}资产不存在`);
    if (assetId && shot?.assetIds && !shot.assetIds.includes(assetId)) issues.push(`${label}未列入所属子镜参考资产`);
  };
  const evidenceCheck = (evidence: string, label: string) => {
    if (typeof evidence !== 'string' || evidence.trim().length < 4 || !source.includes(evidence)) issues.push(`${label}须保留正式事件/反应中的完整逐字依据`);
  };
  const contactCues: EffectCue[] = [];
  for (const cue of plan.effects) {
    const shot = byId.get(cue.subshotId), label = '特效';
    issues.push(...windowIssues(cue.startSec, cue.endSec, shot, label)); evidenceCheck(cue.evidence, label);
    if (!segment.effectIds.includes(cue.effectId)) issues.push('逐镜特效必须先绑定到当前片段');
    if (!Object.hasOwn(TRIGGERS, cue.trigger) || !Object.hasOwn(SCOPES, cue.scope) || !Object.hasOwn(INTENSITIES, cue.intensity) || !cue.description?.trim()) issues.push('特效触发、范围、强度或适配描述无效');
    checkAsset(cue.actorId, shot, '施放者'); checkAsset(cue.targetId, shot, '特效对象');
    if (cue.trigger === 'contact') {
      const combat = plan.combat.find(c => c.subshotId === cue.subshotId);
      if (combat && ['dodged', 'miss', 'none'].includes(combat.outcome)) issues.push('闪避、未命中或尚未接触的子镜不能绑定接触冲击特效');
      if (/(?:爆墨|白闪|震屏|冲击闪|接触闪)/u.test(cue.description)) {
        contactCues.push(cue);
        if(cue.endSec-cue.startSec>.35)issues.push('接触爆墨、白闪或震屏须短促一次，时窗不能超过0.35秒');
      }
    }
  }
  for (let i = 0; i < contactCues.length; i++) for (let j = i + 1; j < contactCues.length; j++) {
    const a = contactCues[i], b = contactCues[j];
    if (a.subshotId === b.subshotId && (!a.targetId || !b.targetId || a.targetId === b.targetId) && Math.max(a.startSec, b.startSec) < Math.min(a.endSec, b.endSec))
      issues.push('同一接触点的爆墨、白闪或震屏时窗重叠，请合并一次冲击');
  }
  if (new Set(plan.effects.map(c => `${c.effectId}:${c.subshotId}:${c.startSec}`)).size !== plan.effects.length) issues.push('逐镜特效存在重复触发');
  for (const effectId of segment.effectIds) if (!plan.effects.some(c => c.effectId === effectId)) issues.push('已绑定特效缺少逐镜触发计划');
  const previous = new Map<string, { index: number; cue: CombatCue }>();
  const order = Object.keys(PHASES);
  for (const cue of plan.combat) {
    const shot = byId.get(cue.subshotId), index = shots.findIndex(s => s.id === cue.subshotId);
    evidenceCheck(cue.evidence, '战斗动作');
    if (!shot || !Object.hasOwn(PHASES, cue.phase) || !Object.hasOwn(OUTCOMES, cue.outcome)) issues.push('战斗所属子镜或动作阶段无效');
    if (!cue.attackKey?.trim() || !cue.attackerId || !cue.defenderId || cue.attackerId === cue.defenderId) issues.push('请明确同一次攻击的编号及攻防双方');
    checkAsset(cue.attackerId, shot, '攻方'); checkAsset(cue.defenderId, shot, '受方');
    for (const key of ['origin', 'path', 'contact', 'direction', 'reaction', 'ending'] as const) if (!cue[key]?.trim()) issues.push(`战斗动作缺少${({origin:'起始站位/持械',path:'动作路径',contact:'接触或避开位置',direction:'受力方向',reaction:'人物反应',ending:'结果末帧'})[key]}`);
    if (cue.phase === 'contact' && cue.outcome === 'none') issues.push('接触/避开阶段须明确命中、格挡、闪避或未命中');
    if (cue.outcome === 'hit' && /(?:未命中|没有命中|没击中|并未击中|扑空|落空|闪避成功|躲过)/u.test(cue.evidence)) issues.push('正式依据是避开/未命中，不能写成命中');
    const blocked=/格挡|挡住|挡下|招架/u.test(cue.evidence),dodged=/避开|躲过|闪避|闪开/u.test(cue.evidence),hit=/击中|命中|打中|刺中|砍中/u.test(cue.evidence),miss=/未命中|没有命中|没击中|扑空|落空/u.test(cue.evidence);
    if(cue.outcome==='hit'&&blocked&&!hit || ['dodged','miss'].includes(cue.outcome)&&blocked&&!dodged&&!miss || cue.outcome==='blocked'&&dodged&&!blocked || ['dodged','miss'].includes(cue.outcome)&&hit&&!miss&&!dodged)issues.push('战斗判定与正式依据中的命中、格挡或闪避相矛盾');
    const prev = previous.get(cue.attackKey);
    if (prev) {
      if (index <= prev.index || order.indexOf(cue.phase) < order.indexOf(prev.cue.phase)) issues.push('同一次攻击的子镜/动作阶段发生倒序或重复');
      if (cue.attackerId !== prev.cue.attackerId || cue.defenderId !== prev.cue.defenderId) issues.push('同一次攻击的攻防双方发生切换');
      if (prev.cue.outcome !== 'none' && cue.outcome !== 'none' && cue.outcome !== prev.cue.outcome) issues.push('同一次攻击的命中/格挡/闪避结果互相矛盾');
    }
    previous.set(cue.attackKey, { index, cue });
  }
  if (new Set(plan.combat.map(c => c.subshotId)).size !== plan.combat.length) issues.push('同一子镜的战斗计划重复，请合并或拆镜');
  const seen = new Set<string>();
  for (const cue of plan.visible) {
    const label = '浮签/系统信息', shot = byId.get(cue.subshotId), key = `${cue.kind}:${cue.index}`;
    if (!['floatLabels', 'systemPanels'].includes(cue.kind) || !Number.isInteger(cue.index) || !visibleText(beat, cue) || seen.has(key)) issues.push('可见信息存在重复或不属于正式剧本的条目');
    seen.add(key); issues.push(...windowIssues(cue.startSec, cue.endSec, shot, label));
    if (!shot?.lineRefs[cue.kind]?.includes(cue.index)) issues.push('可见信息必须绑定正式分配的子镜');
    if (!['hud', 'object'].includes(cue.placement) || !['model', 'overlay'].includes(cue.layer)) issues.push('可见信息归属或生成层无效');
    if (cue.kind === 'floatLabels' && cue.layer !== 'model') issues.push('短浮签须保留模型原生显示；纠字入口仅修正成片文字');
    if (cue.placement === 'object' && !cue.ownerId) issues.push('人物/对象浮签须指定所属资产');
    if (cue.placement === 'hud' && cue.ownerId) issues.push('HUD信息不能贴到实体人物上');
    checkAsset(cue.ownerId, shot, '浮签所属对象');
    if (cue.ownerId && project) {
      const asset = project.assets?.find(a => a.id === cue.ownerId);
      const text = visibleText(beat, cue);
      if (text.startsWith('人物：') && asset && (asset.kind !== 'character' || !text.includes(asset.name))) issues.push('人物浮签与所绑定角色姓名不符');
      if (segment.mentionOnlyAssets?.some(a => a.assetId === cue.ownerId)) issues.push('仅被提及的人物浮签须使用HUD');
      if (asset && /(?:第一人称|主观镜头|POV)/iu.test(asset.identity)) issues.push('主观镜头人物身份浮签须使用HUD');
    }
    if (![cue.x, cue.y, cue.width, cue.height].every(Number.isFinite) || cue.x < .04 || cue.y < .04 || cue.width < .1 || cue.height < .05 || cue.x + cue.width > .96 || cue.y + cue.height > .92) issues.push('文字区域须位于安全边距内，且容得下正式全文');
    const appearance=labelAppearance(plan.labelStyle,cue.kind==='systemPanels');
    const aspect=project?.aspectRatio==='9:16'?9/16:project?.aspectRatio==='1:1'?1:16/9;
    const columns=Math.floor((cue.width*aspect-.018)/(appearance.size*1.08));
    const rows=visibleText(beat,cue).split('\n').reduce((count,line)=>count+Math.max(1,Math.ceil(textLength(line)/Math.max(1,columns))),0);
    if(columns<1 || rows*appearance.size*1.3+.018>cue.height+.001)issues.push('当前字号和文字区域容不下正式全文，请扩大区域；不能裁字或漏行');
    if (cue.endSec - cue.startSec + .02 < minimumVisibleSeconds(visibleText(beat, cue))) issues.push('正式浮签全文显示时长过短，请调整排程或正式分镜，不能缩写');
  }
  if (!partialVisible && seen.size !== beat.floatLabels.length + beat.systemPanels.length) issues.push('浮签显示计划须逐条覆盖全部正式浮签和系统信息');
  for (let i = 0; i < plan.visible.length; i++) for (let j = i + 1; j < plan.visible.length; j++) if (overlaps(plan.visible[i], plan.visible[j])) issues.push('同时显示的浮签区域相互重叠，请调整位置或错开显示时点');
  return [...new Set(issues)];
}
const assetName = (assetId: string | undefined, names: Record<string, string>) => assetId ? names[assetId] || '已绑定对象' : '以正式动作对象为准';
export function executionShotLines(beat: ScriptBeat, segment: Segment, shot: Subshot, names: Record<string,string> = {}): string[] {
  const plan = segment.executionPlan;
  if (!plan) return [];
  names = { ...plan.assetNames, ...names };
  return [
    ...plan.combat.filter(c => c.subshotId === shot.id).map(c => `【战斗执行】同一次攻击${c.attackKey}｜${PHASES[c.phase]}｜攻方${assetName(c.attackerId,names)}；受方${assetName(c.defenderId,names)}；站位/持械${c.origin}；路径${c.path}；接触/避开${c.contact}；判定${OUTCOMES[c.outcome]}；受力${c.direction}；反应${c.reaction}；结果末帧${c.ending}；正式依据“${c.evidence}”。只展开已有动作，攻击次数、持械手、伤势、左右关系和胜负不由表现模板新增。`),
    ...plan.effects.filter(c => c.subshotId === shot.id).map(c => `【逐镜特效】${c.startSec}–${c.endSec}秒｜${TRIGGERS[c.trigger]}｜施放者${assetName(c.actorId,names)}；对象${assetName(c.targetId,names)}；${SCOPES[c.scope]}范围/${INTENSITIES[c.intensity]}强度；依据“${c.evidence}”；${c.description}。仅在该时窗触发；不遮脸、接触点、人物反应或正式浮签；不重复一次命中，不新增冲击声或盖住对白/OS，结束后露出正式结果。`),
    ...plan.visible.filter(c => c.subshotId === shot.id).map(c => {
      const a = labelAppearance(plan.labelStyle, c.kind === 'systemPanels');
      return `【浮签执行】${c.startSec}–${c.endSec}秒｜正式全文“${visibleText(beat,c)}”｜${c.placement==='hud'?'画面HUD':assetName(c.ownerId,names)+'所属浮签'}｜左${Math.round(c.x*100)}%/上${Math.round(c.y*100)}%/宽${Math.round(c.width*100)}%/高${Math.round(c.height*100)}%｜${c.layer==='model'?'模型原生显示':'原生空面板＋后期精确文字覆盖'}｜字体${a.font}，字高约画幅高度${(a.size*100).toFixed(1)}%，暖色文字＋深色细描边，静置可读；完整换行、不截断，不遮脸、手、兵器或反应。字体名称指导风格；模型偏差由成片纠字入口精确修正，不能用字幕替代声音。`;
    }),
  ];
}
export function executionPromptIssues(beat: ScriptBeat, segment: Segment, shots: Subshot[], text: string, names: Record<string,string> = {}) {
  const plan=segment.executionPlan;if(!plan)return [];
  names={...plan.assetNames,...names};
  const headers=[...text.matchAll(/^(?:#{1,6}\s*)?【?(?:子镜|镜头)\s*(\d+)\s*[｜|：:（(\s]+\s*\d+(?:\.\d+)?\s*(?:秒|s)?\s*[-–—~～至]/gmu)];
  const issues:string[]=[],compact=(s:string)=>s.replace(/\s/gu,''),has=(row:string,s:string)=>compact(row).includes(compact(s));
  const windows=(row:string,start:number,end:number)=>[...row.matchAll(/(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*秒/gu)].some(m=>Math.abs(Number(m[1])-start)<.011&&Math.abs(Number(m[2])-end)<.011);
  const rows=(block:string,labels:string)=>[...block.matchAll(new RegExp(`(?:【(?:${labels})】|(?:^|\\n)(?:${labels})[：:])([^]*?)(?=\\n(?:【|[^\\n：:]{1,12}[：:])|$)`,'gmu'))].map(m=>m[1]);
  const role=(row:string,labels:string,expected:string)=>new RegExp(`(?:${labels})[：:\\s]*([^；;｜|\\n。]+)`,'u').exec(row)?.[1]?.trim()===expected;
  for(const shot of shots) {
    const index=shots.indexOf(shot),header=headers.find(h=>Number(h[1])===index+1);
    const next=header?headers[headers.indexOf(header)+1]?.index:undefined;
    const block=header?text.slice(header.index!,next??text.length).split(/\n【(?:角色锚点|场景锚点|道具锚点|可见信息层|禁止)】/u)[0]:'';
    for(const [key,labels] of [['effects','逐镜特效|特效执行'],['combat','战斗执行|战斗动作'],['visible','浮签执行|浮签排程|可见信息执行']] as const)if(rows(block,labels).length!==plan[key].filter(c=>c.subshotId===shot.id).length)issues.push('提示词逐镜执行计划存在额外、重复或遗漏条目');
    for(const cue of plan.effects.filter(c=>c.subshotId===shot.id)) {
      if(!rows(block,'逐镜特效|特效执行').some(row=>windows(row,cue.startSec,cue.endSec)&&has(row,cue.evidence)&&has(row,cue.description)&&
        (!cue.actorId||role(row,'施放者|施术者',assetName(cue.actorId,names)))&&(!cue.targetId||role(row,'对象|目标',assetName(cue.targetId,names)))&&has(row,SCOPES[cue.scope]+'范围')&&has(row,INTENSITIES[cue.intensity]+'强度')&&has(row,TRIGGERS[cue.trigger])))
        issues.push('提示词遗漏或改写逐镜特效的时窗、依据、对象、范围或适配描述');
    }
    for(const cue of plan.combat.filter(c=>c.subshotId===shot.id)) {
      if(!rows(block,'战斗执行|战斗动作').some(row=>[cue.attackKey,cue.evidence,cue.origin,cue.path,cue.contact,cue.direction,cue.reaction,cue.ending,PHASES[cue.phase]].every(s=>has(row,s))&&role(row,'攻方|攻击者',assetName(cue.attackerId,names))&&role(row,'受方|防守者',assetName(cue.defenderId,names))&&new RegExp(`(?:判定|结果|结论)[：:\\s]*${OUTCOMES[cue.outcome]}`,'u').test(row)))
        issues.push('提示词遗漏或改写战斗的攻防双方、动作、判定、反应或结果末帧');
    }
    for(const cue of plan.visible.filter(c=>c.subshotId===shot.id)) {
      if(!rows(block,'浮签执行|浮签排程|可见信息执行').some(row=>{
        const placement=cue.placement==='hud'?/HUD/u.test(row):has(row,assetName(cue.ownerId,names)+'所属浮签')||new RegExp(`(?:所属|归属)[：:\\s]*${assetName(cue.ownerId,names).replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}`,'u').test(row);
        const coordinates=[['左',cue.x],['上',cue.y],['宽',cue.width],['高',cue.height]] as const;
        return placement&&windows(row,cue.startSec,cue.endSec)&&has(row,visibleText(beat,cue))&&coordinates.every(([label,n])=>{
          const match=new RegExp(`${label}[：:\\s]*(\\d+(?:\\.\\d+)?)%`,'u').exec(row);return match&&Math.abs(Number(match[1])-n*100)<=.51;
        })&&(cue.layer==='model'?/模型原生显示|模型直出/u.test(row):/后期.*覆盖/u.test(row));
      }))issues.push('提示词遗漏或改写正式浮签全文、时窗、归属、位置或显示方式');
    }
  }
  return [...new Set(issues)];
}
export function labelStyleInstruction(style = DEFAULT_LABEL_STYLE) {
  const normal = labelAppearance(style), system = labelAppearance(style,true);
  return `【浮签字形】人物/场景/时间浮签采用${normal.font}风格，系统/数值采用${system.font}风格；暖金或米白文字配深色细描边，留足边距、静置可读，不使用大面积炫光，不改变正式全文。字体名称指导模型字形，本地纠字使用实际字体。`;
}
export function finalPlaybackChecks(beat: ScriptBeat, segment: Segment, shots: Subshot[], video?: Artifact) {
  const speed = segment.speedOverride ?? (segment.action ? 1.5 : 1.15), warnings: string[] = [],issues:string[]=[];
  if (!Number.isFinite(speed) || speed <= 0) return {warnings:['导出倍速无效'],issues:['导出倍速无效']};
  const cues = (segment.executionPlan?.visible || defaultExecutionPlan(beat,segment,shots).visible).map(cue =>
    video?.labelRepair?.cues.find(corrected=>corrected.kind===cue.kind&&corrected.index===cue.index) || cue);
  for (const cue of cues) {
    const text = visibleText(beat,cue), final = (cue.endSec-cue.startSec)/speed, required=minimumVisibleSeconds(text);
    if (final + .03 < required) {
      const message=`“${text}”按${speed}倍导出仅显示${final.toFixed(2)}秒，建议至少${required.toFixed(2)}秒；降低本段倍速或调整显示窗口`;
      warnings.push(message);
      if(segment.executionPlan || video?.labelRepair?.cues.some(c=>c.kind===cue.kind&&c.index===cue.index))issues.push(message);
    }
  }
  for (const item of video?.review?.speech || []) {
    const ref = item;
    const order = beat.speechOrder?.length ? beat.speechOrder : [...beat.dialogue.map((_,index)=>({kind:'dialogue' as const,index})), ...beat.os.map((_,index)=>({kind:'os' as const,index}))];
    const source = order.find(line => (line as {id?:string}).id === ref.id || `${beat.id}:${line.kind}:${line.index}` === ref.id);
    const line = source ? beat[source.kind][source.index] : '';
    if (line && Number.isFinite(ref.startSec) && Number.isFinite(ref.endSec)) {
      const chars = textLength(line.replace(/^[^：:]+[：:]/u,'')), final=(ref.endSec!-ref.startSec!)/speed;
      if (final + .05 < chars/3.5) {
        const message=`正式声音“${line}”按${speed}倍导出发声窗口偏短，请听最终预览并降低本段倍速；字幕不能替代声音`;
        warnings.push(message);if(segment.executionPlan||video?.labelRepair)issues.push(message);
      }
    }
  }
  return {warnings:[...new Set(warnings)],issues:[...new Set(issues)]};
}
export function finalPlaybackWarnings(beat: ScriptBeat, segment: Segment, shots: Subshot[], video?: Artifact): string[] {
  return finalPlaybackChecks(beat,segment,shots,video).warnings;
}
