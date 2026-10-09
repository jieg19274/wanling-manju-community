import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { download, health, input, output, poll, request,providerUrl } from './direct-common.mjs';
import { mediaDataUri } from './media-data-uri.mjs';
import {publicReference}from'./public-reference.mjs';
import {videoPromptWithAcceptedFallbacks}from'./video-reference-fallback.mjs';
let remoteId, remoteModel, submitting = false;
async function recordState(status) {
  await writeFile(`${process.argv[3]}.remote.json`, JSON.stringify({ id: remoteId, model: remoteModel, status, updatedAt: new Date().toISOString() }, null, 2));
}
async function terminalState(state) {
  if (['failed', 'cancelled', 'canceled'].includes(state)) await recordState(state === 'failed' ? 'failed' : 'cancelled');
}

try {
  const task = input();
  const model = task.task === 'health' ? task.model : task.model?.id;
  remoteModel = model;
  if (task.task === 'health') output(await health(model));
  else if (task.task === 'recover') {
    const id = String(task.remoteTaskId || '').trim();
    if (!id || id.length > 200) throw new Error('远端视频任务 ID 无效');
    remoteId = id;
    const data = await poll('/videos', id, 5 * 60 * 1000, terminalState);
    const url = data.video_url || data.url || data.data?.video_url || data.data?.url ||
      data.output?.video_url || data.output?.url;
    const source = url || providerUrl(`/v1/videos/${encodeURIComponent(id)}/content`);
    await writeFile(process.argv[3], await download(source, 2_000_000_000));
    await writeFile(`${process.argv[3]}.remote.json`, JSON.stringify({
      id, model, status: 'downloaded', completedAt: new Date().toISOString(),
    }, null, 2));
  }
  else {
    const prompt = videoPromptWithAcceptedFallbacks(task);
    if (!prompt.trim()) throw new Error('正式视频提示词为空');
    if (task.durationSec !== 30) throw new Error('每个生成片段必须固定30秒');
    if (/全能sd2\.5/u.test(model) && task.durationSec !== 30)
      throw new Error('全能 SD2.5 只接受固定 30 秒片段；请改选支持当前时长的模型');
    if (task.model?.capabilities?.maxDurationSec &&
      task.durationSec > task.model.capabilities.maxDurationSec)
      throw new Error('片段时长超过当前视频模型能力上限');
    const limit = task.model?.capabilities?.maxPromptChars;
    if (limit && [...prompt].length > limit)
      throw new Error(`完整提示词 ${[...prompt].length} 字超过模型 ${limit} 字上限；请拆分片段，不得删减正式剧情`);
    const images = [];
    // Both routes accept complete reference images by signed studio asset URL.
    const usePublicReferences = model === '专享sd2.5(30图10音/4-30秒/720p)' ||
      model === '007系列/sd2.5(30-10-10/4-30秒720P)';
    for (const ref of task.references || []) {
      const bytes = await sharp(await readFile(ref.filePath)).png().toBuffer();
      images.push(usePublicReferences ? await publicReference(bytes,request) : mediaDataUri(bytes, 'image/png'));
    }
    const is720p = /720p/iu.test(model);
    const size = task.model?.capabilities?.outputResolution || (task.aspectRatio === '9:16' ? (is720p ? '720x1280' : '1080x1920') :
      task.aspectRatio === '16:9' || !task.aspectRatio ?
        (is720p ? '1280x720' : '1920x1080') : null);
    if (!size) throw new Error(`视频模型尚不支持 ${task.aspectRatio} 画幅`);
    if (!/^(?:720x1280|1080x1920|1280x720|1920x1080)$/u.test(size)) throw new Error('所选输出分辨率尚不支持此直连适配器');
    const body = { model, prompt, duration: task.durationSec, seconds: String(task.durationSec), size, generate_audio: true,
      ...(images.length ? { images } : {}) };
    let data;
    await recordState('submitting'); submitting = true;
    try { data = await request('/videos', { method: 'POST', body, timeoutMs: 180000 }); }
    catch (error) {
      // HTTP errors do not prove that a proxy did not enqueue a paid task.
      await recordState('remote_unknown');
      throw new Error(`${error.message}；提交状态可能不明，请先检查供应商后台，勿直接重试`);
    }
    const id = data.task_id || data.id || data.data?.task_id || data.data?.id;
    remoteId = id;
    if (!id && !data.video_url) throw new Error('视频服务未返回任务 ID；请先核对供应商后台，勿直接重试');
    if (id) await writeFile(`${process.argv[3]}.remote.json`, JSON.stringify({
      id, model, status: 'submitted', submittedAt: new Date().toISOString(),
    }, null, 2));
    if (id) data = await poll('/videos', id, 35 * 60 * 1000, terminalState);
    const url = data.video_url || data.url || data.data?.video_url || data.data?.url ||
      data.output?.video_url || data.output?.url;
    if (!url && !id) throw new Error('视频任务完成但没有可下载的视频地址或任务 ID');
    const source = url || providerUrl(`/v1/videos/${encodeURIComponent(id)}/content`);
    await writeFile(process.argv[3], await download(source, 2_000_000_000));
    if (id) await writeFile(`${process.argv[3]}.remote.json`, JSON.stringify({
      id, model, status: 'downloaded', completedAt: new Date().toISOString(),
    }, null, 2));
  }
} catch (error) {
  if (!submitting && !remoteId) await recordState('not_submitted');
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
