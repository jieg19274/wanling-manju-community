import { writeFile } from 'node:fs/promises';
import { api, downloadLocalMedia, input, modelCatalog, output, stageReference, waitFor } from './mumu-common.mjs';

try {
  const request = input();
  const model = request.task === 'health' ? request.model : request.model?.id;
  const config = await modelCatalog('video', model);
  if (request.task === 'health') output({ ok: true, detail: '木木工坊视频模型配置与本机会话正常；未提交付费任务' });
  else {
    const prompt = String(request.prompt || '');
    if (!prompt.trim()) throw new Error('正式视频提示词为空');
    const capability = config.capabilities?.[model] || {};
    const limit = capability.prompt?.max_unicode_code_points;
    if (Number.isInteger(limit) && [...prompt].length > limit)
      throw new Error(`完整提示词 ${[...prompt].length} 字超过 ${model} 的 ${limit} 字上限；请拆分片段，不得自动压缩剧情`);
    const references = [];
    for (const item of request.references || []) references.push(await stageReference(item.filePath));
    const body = { model, prompt, duration: request.durationSec,
      aspect_ratio: request.aspectRatio || '16:9', reference_image_urls: references };
    const plan = await api('/videos/reference-upload-plan', { method: 'POST', body, control: true, timeoutMs: 60000 });
    if (plan.required) {
      if (plan.destination !== 'https://imageproxy.zhongzhuan.chat')
        throw new Error('木木工坊参考图上传目的地与界面声明不一致，已停止');
      await api('/videos/reference-upload', { method: 'POST', control: true,
        body: { token: plan.token, confirmed: true, destination: plan.destination }, timeoutMs: 10 * 60 * 1000 });
    }
    const created = await api('/videos', { method: 'POST', body, timeoutMs: 60000 });
    if (!created.id) throw new Error('木木工坊未返回视频任务 ID；请先核对远端任务，勿重试');
    const item = await waitFor('videos', created.id, 35 * 60 * 1000);
    if (item.prompt && item.prompt !== prompt)
      throw new Error(`木木工坊视频任务 ${created.id} 的提交提示词与正式稿不一致，结果未采用`);
    await writeFile(process.argv[3], await downloadLocalMedia(item.local_path));
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
