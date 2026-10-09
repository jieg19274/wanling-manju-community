import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openBudget } from './batch-budget.mjs';
import { longJsonRequest, isDirectRelay } from './long-http.mjs';
import { parseChatStream } from './chat-stream.mjs';
import { pollRemoteTask } from './remote-poll.mjs';

const configFile = path.resolve(process.env.MANJU_DATA_DIR || path.join(process.cwd(), 'data'), 'direct-provider.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const script = "Add-Type -AssemblyName System.Security; $raw = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $clear = [Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear))";
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { input: config.protectedKey, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 100000 });
if (result.status !== 0 || !result.stdout) throw new Error('新软件 API Key 解密失败');
const key = result.stdout;
const base = new URL(process.env.MANJU_DIRECT_API_BASE_URL || 'https://api.mumugofe.com/v1');
const prefix = base.pathname.replace(/\/+$/, '').endsWith('/v1') ?
  base.pathname.replace(/\/+$/, '') : `${base.pathname.replace(/\/+$/, '')}/v1`;

export function input() {
  if (!process.argv[2] || !process.argv[3]) throw new Error('用法：适配器 <request.json> <output-file>');
  return JSON.parse(readFileSync(process.argv[2], 'utf8'));
}
export function output(value) { writeFileSync(process.argv[3], JSON.stringify(value)); }
export function providerUrl(route){
 const scope=process.env.MANJU_BATCH_BUDGET_PROFILE&&process.argv[2]&&process.argv[3]?openBudget(input()):null;
 const target=scope&&process.env.MANJU_APPROVED_BATCH_API_BASE_URL?new URL(process.env.MANJU_APPROVED_BATCH_API_BASE_URL):base;scope?.close();
 return new URL(route,target.origin).href;
}

export async function request(route, { method = 'GET', body, timeoutMs = 60000, streamFile } = {}) {
  const budget = process.env.MANJU_BATCH_BUDGET_PROFILE && process.argv[2] && process.argv[3] ? openBudget(input()) : null;
  let ticket;
  try {
  if (budget && method === 'POST') { ticket = budget.prepare(route, body); body = ticket.body; }
  if (budget && route === '/images/generations' && method === 'POST') timeoutMs = Math.max(timeoutMs, 330000);
  const approvedBase = budget && process.env.MANJU_APPROVED_BATCH_API_BASE_URL
    ? new URL(process.env.MANJU_APPROVED_BATCH_API_BASE_URL) : null;
  if (approvedBase && (approvedBase.origin !== 'https://api.mumugofe.com' || approvedBase.pathname !== '/v1'))
    throw new Error('批准批次目的地不匹配');
  const url = approvedBase ? new URL(`/v1${route}`, approvedBase.origin) : new URL(`${prefix}${route}`, base.origin);
  const headers = { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': Buffer.isBuffer(body)?'image/png':'application/json' }) };
  const payload=body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body);
  let res,raw;
  if(route==='/chat/completions'||isDirectRelay(url)){
    if(body?.stream===true&&streamFile)writeFileSync(streamFile,'');
    res=await longJsonRequest(url,{method,headers,body:payload,timeoutMs,
      ...(body?.stream===true&&streamFile?{onChunk:chunk=>appendFileSync(streamFile,chunk)}:{})});raw=res.raw;
  }else{
    res=await fetch(url,{method,redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers,
      ...(payload===undefined?{}:{body:payload})});raw=await res.text();
  }
  // Keep a minimal provider receipt for fee/status reconciliation. Never save
  // request headers, key material, image data URLs or provider artifact URLs.
  if(process.argv[3])writeFileSync(`${process.argv[3]}.provider-http-receipt.json`,JSON.stringify({
    receivedAt:new Date().toISOString(),route,method,status:res.status,
    model:body?.model||null,requestId:res.requestId||res.headers?.get?.('x-request-id')||res.headers?.get?.('x-oneapi-request-id')||''
  }));
  let data;
  const modelContext=typeof body?.model==='string'?`（实际模型：${body.model.slice(0,160)}）`:'';
  if(res.ok&&body?.stream===true&&/^data:|\ndata:/u.test(raw))data=parseChatStream(raw);
  else try { data = JSON.parse(raw); } catch { throw new Error(`模型接口返回非 JSON（HTTP ${res.status}）${modelContext}`); }
  if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}：${String(data.error?.message || data.message || '请求失败').slice(0, 250)}${modelContext}`);
  if (budget && ticket) budget.finish(ticket, data);
  return data;
  } catch (error) {
    if (budget && ticket) budget.unknown(ticket);
    throw error;
  } finally { budget?.close(); }
}

// Private account-scoped transport cache; keep signed URLs out of all logs.
request.referenceCacheScope=createHash('sha256').update(base.href+'\n'+config.protectedKey).digest('hex');
request.referenceCacheDirectory=path.join(path.dirname(configFile),'provider-reference-cache',request.referenceCacheScope);

export async function health(model) {
  if (!model) throw new Error('模型 ID 为空');
  const data = await request('/models', { timeoutMs: 15000 });
  const models = Array.isArray(data.data) ? data.data : [];
  if (models.length && !models.some(item => item.id === model))
    throw new Error(`模型 ${model} 不在该接口的模型目录中`);
  return { ok: true, detail: `新软件直连 API 正常；模型 ${model} 已配置，未提交付费任务` };
}

export async function download(urlText, maxBytes) {
  const scope = process.env.MANJU_BATCH_BUDGET_PROFILE && process.argv[2] && process.argv[3] ? openBudget(input()) : null;
  const downloadBase = scope && process.env.MANJU_APPROVED_BATCH_API_BASE_URL ? new URL(process.env.MANJU_APPROVED_BATCH_API_BASE_URL) : base;
  scope?.close();
  let url = new URL(urlText);
  let res;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      throw new Error('模型返回的素材地址不安全');
    const headers = url.origin === downloadBase.origin ? { Authorization: `Bearer ${key}` } : {};
    res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers.get('location');
    if (!location || redirects === 3) throw new Error('模型素材下载重定向无效或过多');
    url = new URL(location, url);
  }
  if (!res.ok) throw new Error(`下载模型素材失败：HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  if (length > maxBytes) throw new Error('模型素材超过大小上限');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw new Error('模型素材为空或超过大小上限');
  return bytes;
}

export async function poll(route, id, maxMs, onState = async () => {}) {
  return pollRemoteTask({route,id,maxMs,request,onState,
    intervalMs: route === '/images/generations/tasks' ? 15000 : 3000});
}

export function textTaskPrompt(request) {
  if(request.task==='segment-plan')return `正式剧情单元：${JSON.stringify(request.units)}。${request.instruction}只返回JSON：{"groups":[["连续单元ID"]],"budgets":[{"spokenSec":秒数,"actionSec":秒数,"reactionSec":秒数,"notes":"依据原剧情的具体表演与声音预算说明"}]}。每个单元恰好一次、完整覆盖、严格原顺序，每段总预算不超过30秒；中文声音不快于每秒3.5字，保留反应时间。`;
  if(request.task==='semantic-review') return `完整原文：${request.sourceText}\n正式剧本：${JSON.stringify(request.beats)}\n高光条目：${JSON.stringify(request.highlights)}\n${request.instruction}只返回JSON：{"entries":[{"beatId":"正式ID","sourceStart":0,"sourceEnd":整数,"notes":"具体原文依据及核对结果，至少8字","highlightIds":["实际覆盖ID"]}],"warnings":["缺失或无法确认内容"]}。跨度按JavaScript字符索引；候选不能自行放行。`;
  if(request.task==='episode-plan-summary') return `按范围汇总以下完整事件摘要：${JSON.stringify(request.summaries)}。${request.instruction || ''}只返回JSON：{"summary":"保留所有关键事件与因果、人物状态、跨范围悬念的摘要，最多2000字符"}。不截取原文开头替代分析，不编造。`;
  const source = String(request.sourceText || '');
  if (request.task === 'script-beats' && request.sourceScope?.chunked === 'fast-adaptation-v1') return `这是正式剧本层的快节奏改编修订，不是锁稿后的分镜删改。完整原文：\n${source}\n\n已核对的原文高光剧情报告：\n${request.highlightReport}\n\n必须逐字保留的金句：${JSON.stringify(request.requiredGoldenLines)}\n必须完整保留且按真实触发先后出现的系统信息：${JSON.stringify(request.requiredSystemPanels)}\n${request.instruction}\n只返回严格有效JSON：{"beats":[{"sourceQuote":"原文中连续的6–80字逐字依据","event":"连续主事件的起因、动作、因果结果，含完整必要转场","reaction":"实际人物反应与决定","dialogue":["角色：人物对白"],"os":["角色：真实内心"],"floatLabels":["完整浮签文字"],"systemPanels":["完整系统信息"],"speechOrder":[{"kind":"dialogue或os","index":0}]}]}。每个beat代表可在30秒内连贯演出的连续主事件，并在该30秒内安排多轮正常交流和动作、反应。原文对白/OS可以在正式剧本创作层凝练表达，但不能改变意思、人物动机、态度、信息与因果，不能添加原文没有的行动、结果或人物发声。关键金句和系统信息禁止缩写。只写人物实际可说出的自然对白；纯作者身体动作只能event/reaction，不造朗读OS。用正常语速，每段可听文字通常40–80字，有合理动作密度的段落可较少；绝不单句短话空拖30秒、复读、纯空镜撑时、重复解释已清楚的信息。sourceQuote必须逐字连续包含在完整原文中；不得拼句、伪造或用章节标题充当场景。人物/场景/时间浮签实际时点准确；系统面板出现必须依原文在角色反应或决定之前/之后的真实位置，需要时拆分节点，不能把后出现的面板提前。speechOrder完整覆盖所有dialogue/os索引并按当前新版剧本真实交流顺序。每个beat声音总量按2.5–3.5字/秒可说完，留下有效动作和反应，不靠快念。`;
  if (request.task === 'episode-plan-global') return `全局摘要（含原文范围）：${JSON.stringify(request.summaries)}。候选边界：${JSON.stringify(request.chapterBoundaries)}。${request.instruction || ''}只返回JSON：{"boundaries":[0,整数,...,${request.sourceLength}]}。严格递增且全覆盖，允许跨分析批次合并，不编造剧情。`;
  if (request.task === 'episode-plan') return `本批原文（JavaScript 字符长度 ${source.length}，章节：${JSON.stringify(request.chapterTitles || [])}）：\n${source}\n\n${request.instruction || ''}\n只返回 JSON：{"boundaries":[0,整数,...,${source.length}],"summary":"逐章节/范围的关键事件、因果结果、人物状态及跨批悬念摘要，最多2000字符，保留所有关键转折","events":[{"sourceStart":0,"sourceEnd":整数,"sourceQuote":"跨度内原文逐字依据，最多300字","summary":"事件因果、状态与跨批悬念，8–300字","characters":["本批原文出现的人物名称"]}]}。按本批剧情转折建议分集；边界只能从 ${JSON.stringify(request.chapterBoundaries || [0, source.length])} 中选，严格递增、从 0 到本批末尾，覆盖每个字符。依据指定章节数和剧情收尾要求决定合并连续章节，不得改写或遗漏原文。`;
  if (request.task === 'highlight-report') return `完整原文：\n${source}\n\n只返回 JSON：{"highlightReport":"..."}。报告逐项写章节范围、完整事件因果和全部人物反应、必须保留的原文金句、专名及既有别称映射、所有系统原句/数值、物理资产结构和跨章状态。用户选用完整章节，不能把已发生的生活动作、人物反应、对白或OS归为未采用；未采用只列本章尚未实施的未来素材。严格返回一个highlightReport字符串，禁止返回金句数组。只依据原文，不编造。`;
  if (request.task === 'script-beats') return `完整原文：\n${source}\n\n已核对高光报告：\n${request.highlightReport || ''}\n\n目标每片段约${request.targetDurationSec || 30}秒；${request.fixedDurationSec ? `当前视频模型只能生成固定${request.fixedDurationSec}秒片段。` : ''}每个剧本节点须有因果推进、动作结果与人物反应；原文过载时按连续顺序拆节点，不能删除对白或以空景填时长。首集开头直接呈现正式剧情主体。${String(request.instruction || '').replace('默认按15秒的剧情密度组织；声音较多时按台词容量延长。','按30秒声音容量规划；过载时拆分相邻节点。')}\n只返回严格合法 JSON：{"beats":[{"sourceQuote":"逐字复制原文中的一个连续原句，6至80字","event":"...","reaction":"...","dialogue":["角色：内容"],"os":["角色：内容"],"floatLabels":[],"systemPanels":[],"speechOrder":[]}]}。sourceQuote 只能选一个连续原句，保留原字与标点；禁止拼接多个段落、删掉引号后冒充连续原文。不足6字的对白或拟声不能单独充当sourceQuote，请选同段连续叙述句。dialogue只能放角色实际说出的原文；明确想法入os，作者过渡叙述不变成新对白。每个转场有场景/时间浮签，首次出现人物有有依据的姓名身份浮签。speechOrder按原文对白与OS真实交错顺序输出为[{"kind":"dialogue或os","index":0}]，不把内心声音自动放在对白后。字符串内英文双引号必须转义。逐段覆盖完整原文的事件顺序、因果动作、人物反应、对白、内心 OS、浮签和系统信息。对白和系统信息逐字保留完整标点、数值与称呼；人物声音顺序遵从原文。没有原文依据不编造。`;
  if (request.task === 'asset-extract') return `本集已锁定的正式剧本（唯一剧情依据）：${JSON.stringify(request.beats)}\n项目已有资产：${JSON.stringify(request.existingAssets || [])}\n只提取在正式剧本中明确出现且需要参考图的人物、实际物理场景、关键道具。每项 evidence 必须逐字复制正式剧本连续片段，并包含资产名称；同名资产只建议补状态，不重建。人物服饰、形态、伤势随剧情变化时给 state，trigger 必须是对应 event 或 reaction 的逐字片段，startSegment 是输入beats列表中触发该变化的剧本节点序号，从1开始；后端会换算实际生成片段号。state必须是单个对象，不能是数组；同一人物多次形态/服饰变化，输出多条同名资产条目，每条仅有一个state。人物同名/别称复用已有资产，不将胖头陀与矮胖驿卒之类同一人拆开。骑马、站立、情绪和气场只属动作，不是新形态资产。不要从同一人物推测整集只有一套服装。道具没有则返回空。只输出 JSON：{"assets":[{"kind":"character|scene|prop","name":"正式名称","identity":"固定视觉身份，不加剧情","voice":"人物声线，未知可空","evidence":"正式剧本原句","state":{"label":"状态名","appearance":"该状态外观","trigger":"正式事件或反应原句","startSegment":1}}]}。无状态变化省略 state；不得编造人物、道具、服饰或伤势。`;
  if (request.task === 'storyboard-shots') return `锁定正式剧本节点：${JSON.stringify(request.beat)}\n视觉与机位计划：${request.visualPlan}\n上一片段末帧：${request.previousEndFrame || '无'}\n下一片段正式剧情：${JSON.stringify(request.nextBeat || null)}\n已绑定资产（只可选这些 ID）：${JSON.stringify(request.availableAssets || [])}\n片段号：${request.segmentNumber}；总时长：${request.durationSec}秒。\n只返回 JSON：{"shots":[{"startSec":0,"endSec":5,"framing":"具体景别与机位","location":"唯一物理场景","priorState":"入镜前状态","action":"可见动作及反应","result":"本镜可见结果","endFrame":"停止边界与交给下一镜的末帧","evidence":"逐字复制正式事件或人物反应中的依据","assetIds":["本镜实际资产ID"],"lineRefs":{"dialogue":[],"os":[],"floatLabels":[],"systemPanels":[]}}]}。无资产可用时 assetIds 为空数组。序号从0起，每条声音及可见信息恰好分配一次，声音从该镜开始可跨镜连续。${request.durationSec >= 10 ? '每镜不超过6秒。' : ''}${request.durationSec === 30 ? '30秒须5–8镜。' : ''}${request.segmentNumber === 1 ? '首镜在3秒内呈现正式事件主体。' : ''}所有子镜时间连续覆盖总时长，不造新事件，不以纯空镜或重复反应填时长。每镜 evidence 必须是正式 event 或 reaction 中连续的原文片段。${request.instruction || ''}`;
  if (request.task === 'effect-match') return `可选特效目录：${JSON.stringify(request.catalog)}\n正式片段：${JSON.stringify(request.segments)}\n只返回 JSON：{"matches":[{"segmentId":"...","effectId":"...","evidence":"事件或反应中的逐字原句"}]}。只能从目录挑选，证据只能来自 event 或 reaction，不能新增动作。无合适项返回空数组。`;
  throw new Error('未知文本任务');
}
