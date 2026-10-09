import { health, input, output, request, textTaskPrompt } from './direct-common.mjs';
import { parseTextResult } from './text-result.mjs';
import { writeFileSync } from 'node:fs';

try {
  const task = input();
  if (task.task === 'health') output(await health(task.model));
  else {
    const boundedAssetTask = ['asset-extract', 'storyboard-shots'].includes(task.task);
    const boundedScript = ['chapter-paragraphs-v1', 'fast-adaptation-v1'].includes(task.sourceScope?.chunked);
    const maximumTokens = boundedScript ? Number(task.maxOutputTokens) : boundedAssetTask ? 8192 : 32768;
    if(!Number.isInteger(maximumTokens)||maximumTokens<1024||maximumTokens>32768)throw new Error('分片输出上限无效');
    const streaming=task.streamResponse===true||boundedAssetTask;
    const data = await request('/chat/completions', { method: 'POST', timeoutMs: 570000,
      ...(streaming?{streamFile:process.argv[3]+'.stream.sse'}:{}),
      body: { model: task.model, stream: streaming, ...(streaming?{stream_options:{include_usage:true}}:{}),
        ...(task.sourceScope?.chunked==='chapter-paragraphs-v1'&&task.disableThinking===true?{thinking:{type:'disabled'}}:{}),
        max_tokens: maximumTokens, messages: [
        { role: 'system', content: '你是漫剧制作的原文核对助手。完整读取输入，只输出有效 JSON；无法完整处理时明确报错，不得截断原文。所有字符串内的ASCII双引号必须使用JSON反斜杠转义；字符串内换行使用JSON转义。保留原文中文引号和文字，不拼接或修改逐字引文。不要输出Markdown围栏。' },
        { role: 'user', content: textTaskPrompt(task) },
      ] } });
    const choice = data.choices?.[0];
    writeFileSync(process.argv[3] + '.response.json', JSON.stringify({
      id: data.id, model: data.model, usage: data.usage,
      finishReason: choice?.finish_reason, message: choice?.message, maximumTokens,...(streaming?{streamComplete:data.streamComplete===true}:{}),
      ...(task.sourceScope?{sourceScope:task.sourceScope}:{}),
    }, null, 2));
    if (choice?.finish_reason === 'length')
      throw new Error(`文本模型输出达到${maximumTokens} token上限；原始响应已保存，请拆小分析范围，不能采用截断剧情`);
    if(choice?.finish_reason!=='stop')throw new Error('文本模型未确认完整停止；原始响应已保存，不能采用不完整剧情');
    let content = String(choice?.message?.content || '').trim();
    if (!content) throw new Error('文本模型未返回正文；原始响应已保存，未采用空结果');
    if (content.startsWith('```')) content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    output(parseTextResult(content,task.task));
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
