import { api, input, modelCatalog, output } from './mumu-common.mjs';

function taskPrompt(request) {
  const source = String(request.sourceText || '');
  if (request.task === 'episode-plan') return `本批原文（JavaScript 字符长度 ${source.length}，章节：${JSON.stringify(request.chapterTitles || [])}）：\n${source}\n\n只返回 JSON：{"boundaries":[0,整数,...,${source.length}]}。按本批剧情转折建议分集；边界只能从 ${JSON.stringify(request.chapterBoundaries || [0, source.length])} 中选，严格递增、从 0 到本批末尾，覆盖每个字符。可合并连续章节，不得改写或遗漏原文。`;
  if (request.task === 'highlight-report') return `完整原文：\n${source}\n\n只返回 JSON：{"highlightReport":"..."}。报告逐项写章节范围、事件起因与结果、人物目的与反应、名场面与原文金句、专名映射、未采用素材。只依据原文，不编造。`;
  if (request.task === 'script-beats') return `完整原文：\n${source}\n\n已核对高光报告：\n${request.highlightReport || ''}\n\n目标每片段约${request.targetDurationSec || 15}秒。每个剧本节点对应一个视频片段，须有足够的因果推进、动作结果与人物反应；薄事件与相邻事件按原文顺序合并，不以空景、等待或重复反应填时长。首集开头直接呈现正式剧情主体。\n只返回 JSON：{"beats":[{"sourceQuote":"从原文逐字复制至少6字的剧情依据","event":"...","reaction":"...","dialogue":["角色：内容"],"os":["角色：内容"],"floatLabels":[],"systemPanels":[]}]}。sourceQuote 必须是本集原文中的连续原句，不得改写。保持事件顺序、因果动作、人物反应、对白、内心 OS、浮签、系统信息；没有原文依据不编造。`;
  if (request.task === 'storyboard-shots') return `锁定正式剧本节点：${JSON.stringify(request.beat)}\n视觉与机位计划：${request.visualPlan}\n已绑定资产（只可选这些 ID）：${JSON.stringify(request.availableAssets || [])}\n片段号：${request.segmentNumber}；总时长：${request.durationSec}秒。\n只返回 JSON：{"shots":[{"startSec":0,"endSec":5,"framing":"具体景别与机位","location":"唯一物理场景","priorState":"入镜前状态","action":"可见动作及反应","result":"本镜可见结果","endFrame":"停止边界与交给下一镜的末帧","evidence":"逐字复制正式事件或人物反应中的依据","assetIds":["本镜实际资产ID"],"lineRefs":{"dialogue":[],"os":[],"floatLabels":[],"systemPanels":[]}}]}。无资产可用时 assetIds 为空数组。序号从0起，每条声音及可见信息恰好分配一次，声音从该镜开始可跨镜连续。${request.durationSec >= 10 ? '每镜不超过6秒。' : ''}${request.durationSec === 30 ? '30秒须5–8镜。' : ''}${request.segmentNumber === 1 ? '首镜在3秒内呈现正式事件主体。' : ''}所有子镜时间连续覆盖总时长，不造新事件，不以纯空镜或重复反应填时长。每镜 evidence 必须是正式 event 或 reaction 中连续的原文片段。`;
  if (request.task === 'effect-match') return `可选特效目录：${JSON.stringify(request.catalog)}\n正式片段：${JSON.stringify(request.segments)}\n只返回 JSON：{"matches":[{"segmentId":"...","effectId":"...","evidence":"事件或反应中的逐字原句"}]}。只能从目录挑选，证据只能来自 event 或 reaction，不能新增动作。无合适项返回空数组。`;
  throw new Error('未知文本任务');
}

try {
  const request = input();
  await modelCatalog('text', request.model);
  if (request.task === 'health') output({ ok: true, detail: '木木工坊文本模型配置与本机会话正常' });
  else {
    const user_prompt = taskPrompt(request);
    const system_prompt = '你是漫剧制作的原文核对助手。必须完整读取输入，保持剧情依据，只输出符合指定字段的有效 JSON。内容过长无法完整处理时明确报错，不得截断原文后假装完成。';
    const result = await api('/integrations/manju-studio/text', {
      method: 'POST', body: { task: request.task, model: request.model, user_prompt, system_prompt },
      timeoutMs: 330000,
    });
    let content = String(result.content || '').trim();
    if (content.startsWith('```')) content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    output(JSON.parse(content));
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
