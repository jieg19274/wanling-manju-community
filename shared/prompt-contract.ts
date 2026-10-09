import type { ScriptBeat, Segment, Subshot } from './model.js';

export const PROMPT_TEMPLATE_VERSION = '2026-10-08';

const compact = (text: string) => text.replace(/\s/gu, '');
const listTokens = (text: string) => text.split(/[、，,；;｜|]/u).map(compact).sort();
const sameList = (text: string, values: string[]) => JSON.stringify(listTokens(text)) === JSON.stringify(listTokens(values.join('、')));
function speechRows(text: string, kind: 'dialogue' | 'os', index: number) {
  const label = kind === 'dialogue' ? '对白' : '内心OS', token = kind === 'dialogue' ? 'D' : 'O';
  return [...text.matchAll(new RegExp(`^(?:【${label}】)?(?:${label}\\s*${index + 1}|${token}${index + 1})\\s*[｜|]\\s*(\\d+(?:\\.\\d+)?)\\s*[-–—~～至]\\s*(\\d+(?:\\.\\d+)?)秒\\s*[｜|]([^\\n]+)$`, 'gmu'))];
}
export function promptPolicyIssues(text: string) {
  const section = (heading: string) => compact(new RegExp(`【${heading}】([^]*?)(?=\\n【|$)`, 'u').exec(text)?.[1] || '');
  const paragraphs = text.split('\n').map(compact);
  const denied = (value:string, term:string) => new RegExp(`(?:禁止|不得|不能|严禁|不(?:自动)?(?:生成|添加|显示))[^。；]*${term}|${term}[^。；]*(?:不得|不能|严禁|不(?:自动)?(?:生成|添加|显示))`, 'u').test(value);
  const screenValid = (value:string) => value.includes('浮签') && value.includes('系统') &&
    denied(value, '(?:对白字幕|台词字幕)') && denied(value, '(?:OS字幕|内心[^。；]*字幕)');
  const speechValid = (value:string) => /对白|台词/u.test(value) && /OS|内心/u.test(value) &&
    denied(value, '(?:解说|旁白)') && (/(?:动作)[^。；]*(?:不得|禁止|不能|严禁)[^。；]*(?:朗读|读出|说出来)/u.test(value) ||
      /(?:不得|禁止|不能|严禁)[^。；]*(?:朗读|读出)[^。；]*(?:动作)/u.test(value));
  const referenceValid = (value:string) => /完整四视图/u.test(value) && /整张|完整参考/u.test(value) && /同一(?:人物|角色)|同一个角色/u.test(value);
  const scopeValid = (value:string) => /每镜|本镜|逐镜/u.test(value) && /只使用|仅使用|仅参考|限定/u.test(value) &&
    /参考|资产/u.test(value) && /未列|未使用/u.test(value) && /不得|禁止|不能/u.test(value) && /出场|入场|出画/u.test(value);
  const issues: string[] = [];
  // Check required concepts, not an exact copy of the latest template paragraph.
  // Equivalent policy headings are also compatible with existing projects.
  if (!screenValid(section('屏幕文字边界')) && !paragraphs.some(screenValid))
    issues.push('选用提示词缺少屏幕文字边界，请补齐正式文字范围及禁止自动台词字幕规则');
  if (!speechValid(section('可发声文本边界')) && !paragraphs.some(speechValid))
    issues.push('选用提示词缺少可发声文本边界；仅正式对白/OS可以发声，动作及说明不得朗读');
  if (!referenceValid(section('参考图使用')) && !paragraphs.some(referenceValid) ||
    /【附件图\d+】[^\n]*头部身份参考/u.test(text))
    issues.push('选用提示词缺少完整四视图参考合同或引用独立头图；请核对实际参考用途');
  if (!scopeValid(section('逐镜参考范围')) && !paragraphs.some(scopeValid)) issues.push('选用提示词缺少逐镜参考范围；附件不能诱导未列人物或道具提前入场');
  return issues;
}

export function promptStructureIssues(beat: ScriptBeat, segment: Segment, shots: Subshot[], text: string,
  names?: Record<string, string>) {
  const headers = [...text.matchAll(/^(?:#{1,6}\s*)?【?(?:子镜|镜头)\s*(\d+)\s*[｜|：:（(\s]+\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/gmiu)];
  if (headers.length !== shots.length) return ['提示词正文子镜数量或时间码不可核对；请保留逐镜编号与起止时间，无需更换模板措辞'];
  const issues: string[] = [];
  const before = text.slice(0, headers[0]?.index || 0);
  for (const [index, shot] of shots.entries()) {
    const header = headers[index];
    if (Number(header[1]) !== index + 1) issues.push(`提示词正文子镜${index + 1}顺序与正式分镜不一致`);
    if (Math.abs(Number(header[2]) - shot.startSec) > .001 || Math.abs(Number(header[3]) - shot.endSec) > .001)
      issues.push(`提示词正文子镜${index + 1}时间码与正式分镜不一致`);
    const block = text.slice(header.index! + header[0].length, headers[index + 1]?.index ?? text.length)
      .split(/\n【(?:角色锚点|场景锚点|道具锚点|可见信息层|事件执行边界|禁止)】/u)[0];
    for (const value of [shot.framing, shot.action, shot.location, shot.priorState, shot.result, shot.endFrame])
      if (value && !compact(block).includes(compact(value))) issues.push(`提示词正文子镜${index + 1}遗漏本镜动作、场景、结果或末帧：${value}`);
    for (const kind of ['dialogue', 'os'] as const) {
      const label = kind === 'dialogue' ? '对白' : '内心OS', token = kind === 'dialogue' ? 'D' : 'O';
      const field = new RegExp(`(?:【${label}】|(?:^|\\n)${kind === 'dialogue' ? '对白' : '(?:内心OS|OS)'}[：:])([^]*?)(?=\\n(?:【|[^\\n：:]{1,12}[：:])|$)`, 'u').exec(block)?.[1] || '';
      const starts = new RegExp(`(?:^|\\n)${kind === 'dialogue' ? '对白' : '(?:内心OS|OS)'}起句[：:]([^\\n]+)`, 'u').exec(block)?.[1] || '';
      for (const lineIndex of shot.lineRefs[kind]) {
        const line = beat[kind][lineIndex];
        const tableLine = speechRows(before, kind, lineIndex).find(row => compact(row[3]) === compact(line));
        if (!compact(field).includes(compact(line)) && !(new RegExp(`(?:^|[^A-Z0-9])${token}${lineIndex + 1}(?!\\d)`, 'u').test(starts) && tableLine))
          issues.push(`提示词正文子镜${index + 1}的${label}角色或原句归属不一致`);
      }
      if (shot.lineRefs[kind].length) {
        const direct = compact(shot.lineRefs[kind].map(n => beat[kind][n]).join('；'));
        const ids = [...starts.matchAll(new RegExp(`${token}(\\d+)`, 'gu'))].map(match => Number(match[1]) - 1);
        if (compact(field) !== direct && (field.trim() || JSON.stringify(ids) !== JSON.stringify(shot.lineRefs[kind])))
          issues.push(`提示词正文子镜${index + 1}的${label}含额外台词或改变起句引用`);
      } else {
        const expected = shotSpeech(beat, shots, index, kind, segment);
        if (starts || expected.startsWith('无新台词') && compact(field) !== compact(expected) ||
          !expected.startsWith('无新台词') && field.trim() && !/^无(?:[（(][^]*[）)])?$/u.test(field.trim()))
          issues.push(`提示词正文子镜${index + 1}的${label}新增发声或遗漏跨镜续说`);
      }
      // A line present globally or in another shot cannot satisfy this shot.
      for (const [lineIndex, line] of beat[kind].entries()) if (!shot.lineRefs[kind].includes(lineIndex) &&
        (compact(field).includes(compact(line)) || new RegExp(`(?:^|[^A-Z0-9])${token}${lineIndex + 1}(?!\\d)`, 'u').test(starts)))
        issues.push(`提示词正文子镜${index + 1}新增或重复分配正式${label}`);
    }
    for (const [kind, label, token] of [['floatLabels', '浮签', 'F'], ['systemPanels', '系统信息', 'S']] as const) {
      const field = new RegExp(`(?:【${label}】|(?:^|\\n)${label}[：:])([^]*?)(?=\\n(?:【|[^\\n：:]{1,12}[：:])|$)`, 'u').exec(block)?.[1] || '';
      const starts = [...block.matchAll(/(?:^|\n)可见信息起点[：:]([^\n]+)/gu)].map(match => match[1]).join('、');
      const visible = text.slice(text.indexOf('【可见信息层】'));
      for (const lineIndex of shot.lineRefs[kind]) if (!compact(field).includes(compact(beat[kind][lineIndex])) &&
        !(new RegExp(`(?:^|[^A-Z0-9])${token}${lineIndex + 1}(?!\\d)`, 'u').test(starts) && visible.split('\n').some(row =>
          new RegExp(`^${token}${lineIndex + 1}[｜|]`, 'u').test(row) && row.includes(`目标全文「${beat[kind][lineIndex]}」`))))
        issues.push(`提示词正文子镜${index + 1}遗漏对应${label}`);
      for (const [lineIndex, line] of beat[kind].entries()) if (!shot.lineRefs[kind].includes(lineIndex) &&
        (compact(field).includes(compact(line)) || new RegExp(`(?:^|[^A-Z0-9])${token}${lineIndex + 1}(?!\\d)`, 'u').test(starts)))
        issues.push(`提示词正文子镜${index + 1}改变${label}出现顺序`);
      const ids = [...starts.matchAll(new RegExp(`${token}(\\d+)`, 'gu'))].map(match => Number(match[1]) - 1);
      if (shot.lineRefs[kind].length ?
        field.trim() ? !sameList(field, shot.lineRefs[kind].map(n => beat[kind][n])) : JSON.stringify(ids) !== JSON.stringify(shot.lineRefs[kind]) :
        ids.length || field.trim() && !/^无(?:[（(][^]*[）)])?$/u.test(field.trim()))
        issues.push(`提示词正文子镜${index + 1}的${label}含额外内容或改变引用`);
    }
    if (names) {
      const field = /(?:【参考资产】|(?:^|\n)参考[：:])([^\n]+)/u.exec(block)?.[1]?.trim() || '';
      const expected = (shot.assetIds || []).map(assetId => names[assetId] || assetId);
      if (!sameList(field, expected.length ? expected : ['无'])) issues.push(`提示词正文子镜${index + 1}参考资产范围与正式分镜不一致`);
    }
  }
  if (segment.speechPlan) for (const item of segment.speechPlan) {
    const line = beat[item.kind][item.index];
    const rows = speechRows(before, item.kind, item.index);
    if (rows.length !== 1 || compact(rows[0][3]) !== compact(line) || Math.abs(Number(rows[0][1]) - item.startSec) > .001 ||
      Math.abs(Number(rows[0][2]) - item.endSec) > .001)
      issues.push('提示词正文逐句声音时序与正式声音计划不一致');
  }
  return issues;
}

export function speechTextBoundary(beat:ScriptBeat):string {
  return `【可发声文本边界】本段仅有${beat.dialogue.length}句正式人物对白、${beat.os.length}句正式内心OS。只按逐镜声源和时序说出【对白】与【内心OS】引用的原句，各句只说一次；禁止自动新增解说、旁白、补词或复述。事件、人物反应、动作描述、故事梗概、参考图说明、身份浮签、系统文字和声源指令均不是待朗读台词，不得说出来。${beat.os.length?'原文已有OS保留对应角色自己的内心声，不能改成独立解说员。':'本段无OS，禁止新增内心独白。'}人物对白必须清晰有声，不得以静音或字幕替代。`;
}

// Historical action fragments belong to the formal beat, never the reusable identity anchor.
export function staticCharacterAnchor(identity: string): string {
  return identity.split(/[，。；;\n]/u).filter(part =>
    !/(?:攥住|抓住|抓腕|跪下|跪地|抢走|砸摊|翻倒|递帖|递上|拖走|被拖|摔倒|扶起)/u.test(part)).join('，');
}

export function spokenWindows(beat: ScriptBeat, shots: Subshot[], durationSec: number, plan?: Segment['speechPlan']) {
  if (plan) return plan.map(item=>({kind:item.kind,index:item.index,start:item.startSec,end:item.endSec,line:beat[item.kind][item.index]||''}));
  const starts = shots.flatMap(shot => (['dialogue','os'] as const).flatMap(kind =>
    shot.lineRefs[kind].map(index => ({kind,index,start:shot.startSec,line:beat[kind][index]}))))
    .sort((a,b)=>a.start-b.start);
  return starts.map((line,index)=>({...line,end:starts.slice(index+1).find(next=>next.start>line.start)?.start??durationSec}));
}

export function shotSpeech(beat: ScriptBeat, shots: Subshot[], index: number, kind: 'dialogue'|'os', segment: Segment): string {
  const shot=shots[index];
  const starts=shot.lineRefs[kind].map(n=>beat[kind][n]);
  if(starts.length)return starts.join('；');
  const carry=spokenWindows(beat,shots,segment.durationSec,segment.speechPlan).filter(w=>w.kind===kind&&w.start<shot.startSec&&w.end>shot.startSec&&
    w.line.replace(/^[^：:]+[：:]/u,'').replace(/[，。！？、；：“”\s]/gu,'').length/3.5+1>shot.startSec-w.start);
  return carry.length?`无新台词；承接前镜已开始的${kind==='os'?'OS':'对白'}，最迟${Math.max(...carry.map(w=>w.end))}秒前结束，不重说；继续声音的角色：${carry.map(w=>w.line.split(/[：:]/u)[0]).join('、')}`:'无（此窗口没有新台词或跨镜续说）';
}

export function speechWindowIssues(beat: ScriptBeat,shots: Subshot[],durationSec:number,plan?: Segment['speechPlan']):string[]{
  if (plan) {
    if(!Array.isArray(plan)) return ['逐句声音时序须为完整数组'];
    const expected=[...beat.dialogue.map((_,index)=>`dialogue:${index}`),...beat.os.map((_,index)=>`os:${index}`)], seen=new Set<string>(),issues:string[]=[];
    let previousEnd=-1;
    for(const item of plan){
      const key=`${item.kind}:${item.index}`,line=beat[item.kind]?.[item.index];
      if(!line||!expected.includes(key)||seen.has(key)){issues.push('逐句声音时序缺少原句或重复引用');continue;}
      seen.add(key);
      const owner=shots.find(shot=>shot.lineRefs[item.kind].includes(item.index));
      const required=line.replace(/^[^：:]+[：:]/u,'').replace(/[，。！？；、\s]/gu,'').length/3.5;
      if(!Number.isFinite(item.startSec)||!Number.isFinite(item.endSec)||item.startSec<0||item.endSec<=item.startSec||item.endSec>durationSec+.01||item.startSec<previousEnd-.01||item.endSec-item.startSec+.02<required||!owner||item.startSec<owner.startSec-.01||item.startSec>=owner.endSec+.01)issues.push('逐句声音时序重叠、过快、越界或不属于其子镜');
      previousEnd=item.endSec;
    }
    if(seen.size!==expected.length)issues.push('逐句声音时序未完整覆盖全部对白和OS');
    const order=beat.speechOrder?.length ? beat.speechOrder : [...beat.dialogue.map((_,index)=>({kind:'dialogue',index})),...beat.os.map((_,index)=>({kind:'os',index}))];
    if(order&&order.some((ref,index)=>ref.kind!==plan[index]?.kind||ref.index!==plan[index]?.index))issues.push('逐句声音时序改变正式对白与OS顺序');
    return issues;
  }
  return spokenWindows(beat,shots,durationSec).filter(w=>
    w.line.replace(/^[^：:]+[：:]/u,'').replace(/[，。！？、；：“”\s]/gu,'').length/3.5+0.25>w.end-w.start)
    .map(w=>`${w.kind}第${w.index+1}句的${w.start}–${w.end}秒声音窗口不足；调整起句时序，不能删台词`);
}
export function screenTextBoundary(): string {
  return '【屏幕文字边界】叠加文字仅允许本段锁定剧本列出的全部人物浮签、场景浮签、时间浮签、设定/系统浮签与系统面板；目标全文、执行方式、位置及可读时窗依【可见信息层】。原文没有的系统提示不得新增。禁止自动添加对白字幕、OS字幕、解说字幕、说明文字、镜头编号或渲染提示词。身份浮签默认绑定对应可见角色；原文指定仅被提及的身份只作为提及HUD，不引入人物实体，不贴在其他人物脸上。主观镜头的身份浮签只作为HUD。账页、请帖等物理道具的原剧情字样按原剧情保留；参考图自带的其他文字不得变成剧情事实。';
}

export function characterReferenceBoundary(): string {
  return '【参考图使用】人物使用完整四视图＋大头照，整张共同锁定同一人物的五官、眼神、发型、体态、衣饰与材质；各视角属于同一角色。场景图锁定空间。参考图中的拼图格线、棚拍背景和并列多视角不得出现在连续成片画面中。';
}

export function visibleInformationBlock(beat: ScriptBeat): string {
  const labels = (prefix: string) => beat.floatLabels.filter(line => line.startsWith(prefix + '：'));
  const settings = beat.floatLabels.filter(line => !['人物：', '场景：', '时间：'].some(prefix => line.startsWith(prefix)));
  return [
    '【可见信息层】只显示下列正式内容；对白和内心OS不生成画面字幕、台词转写或OS字卡。',
    `人物浮签（模型直出）：${labels('人物').join('；') || '无（本段无正式人物浮签）'}`,
    `场景浮签（模型直出）：${labels('场景').join('；') || '无（本段无正式场景浮签）'}`,
    `时间浮签（模型直出）：${labels('时间').join('；') || '无（本段无正式时间浮签）'}`,
    `设定/系统浮签：${settings.length || beat.systemPanels.length ? '' : '无'}`,
    ...settings.map(line => `设定浮签（模型直出）：${line}`),
    ...beat.systemPanels.map(line => `系统面板（模型直出或空面板后期精确覆盖）：${line}`),
  ].join('\n');
}

export function visibleInformationIssues(beat: ScriptBeat, text: string): string[] {
  const block = /(?:^|\n)【可见信息层】([\s\S]*?)(?:\n【禁止】|$)/u.exec(text)?.[1] || '';
  const issues: string[] = [];
  for (const label of ['人物浮签', '场景浮签', '时间浮签', '设定/系统浮签']) {
    if (!new RegExp(`^${label}(?:（[^）]*）)?：`, 'mu').test(block))
      issues.push(`选用提示词可见信息层缺少“${label}”明示项；无内容也须明确写无，请重新编译核对`);
  }
  for (const line of [...beat.floatLabels, ...beat.systemPanels]) {
    if (!block.includes(line)) issues.push('选用提示词可见信息层遗漏正式浮签或系统信息：' + line);
  }
  return issues;
}
