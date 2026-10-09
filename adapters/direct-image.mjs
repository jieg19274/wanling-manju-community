import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import { download, health, input, output, poll, request } from './direct-common.mjs';
import { assetImagePrompt } from './asset-image-prompt.mjs';
import { imageSubmissionPermit } from './image-rate-limit.mjs';

try {
  const task = input();
  if (task.task === 'health') output(await health(task.model));
  else if (task.task === 'asset-image' || task.task === 'action-anchor' || task.task === 'recover-image') {
    const asset = task.asset || {};
    const prompt = task.task === 'recover-image' ? '' : task.task === 'action-anchor' ? task.prompt : assetImagePrompt(task, Boolean(task.references?.length));
    const size = task.task === 'action-anchor' ? '1792x1024' : asset.referenceRole === 'turnaround' ? '1536x1024' : asset.kind === 'character' ? '1024x1536' : asset.kind === 'scene' ? '1536x1024' : '1024x1024';
    const images = [];
    if (task.task !== 'recover-image' && (task.task === 'action-anchor' || task.references?.length)) {
      if (!Array.isArray(task.references) || task.references.length < 1 || task.references.length > 10) throw new Error('须显式传入1–10张已审参考图');
      for (const ref of task.references) {
        const bytes=await readFile(ref.path);
        if(ref.fileHash&&createHash('sha256').update(bytes).digest('hex')!==ref.fileHash)throw Error('参考图文件已变化，未提交生成');
        images.push('data:image/jpeg;base64,' + (await sharp(bytes).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()).toString('base64'));
      }
    }
    let data;
    if (task.task === 'recover-image') {
      if (typeof task.remoteTaskId !== 'string' || !task.remoteTaskId.trim()) throw new Error('找回图片须提供原任务号，未提交新生成');
      data = {task_id:task.remoteTaskId};
    } else {
      await imageSubmissionPermit();
      data = await request('/images/generations', { method: 'POST', timeoutMs: 600000,
        body: { model: task.model, prompt, n: 1, size, async: true, response_format: 'url', ...(images.length ? { images } : {}) } });
    }
    await writeFile(`${process.argv[3]}.provider-response.json`, JSON.stringify(data));
    let item = data.data?.[0], deferred = false;
    if (!item && (data.task_id || data.id)) {
      const taskId = data.task_id || data.id;
      await writeFile(`${process.argv[3]}.provider-task.json`, JSON.stringify({ taskId, model: task.model, submittedAt: new Date().toISOString(), protocol: 'image_json_v1' }));
      if (task.deferPolling === true && task.task !== 'recover-image') { output({deferredTaskId:taskId}); deferred = true; }
      else {
        data = await poll('/images/generations/tasks', taskId, 60 * 60 * 1000,
          async (_state, latest) => writeFile(`${process.argv[3]}.provider-response.json`, JSON.stringify(latest)));
        item = data.data?.[0] || data;
      }
    }
    if (!deferred) {
    await writeFile(`${process.argv[3]}.provider-response.json`, JSON.stringify(data));
    const bytes = item?.b64_json ? Buffer.from(item.b64_json, 'base64') :
      item?.url || item?.image_url || item?.public_url ? await download(item.url || item.image_url || item.public_url, 30 * 1024 * 1024) : null;
    if (!bytes) throw new Error('图片服务未返回可用图片');
    await writeFile(`${process.argv[3]}.provider-image`, bytes);
    await writeFile(process.argv[3], await sharp(bytes).png().toBuffer());
    }
  } else throw new Error('未知图片任务');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
