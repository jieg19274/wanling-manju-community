import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import { api, downloadLocalMedia, input, modelCatalog, output, stageReference, waitFor } from './mumu-common.mjs';
import {assetImagePrompt} from './asset-image-prompt.mjs';

try {
  const request = input();
  await modelCatalog('image', request.model);
  if (request.task === 'health') output({ ok: true, detail: '木木工坊图片模型配置与本机会话正常' });
  else if (request.task === 'asset-image') {
    const asset = request.asset || {};
    const prompt=assetImagePrompt(request,Boolean(request.references?.length)),references=[];
    if(request.references?.length>10)throw Error('最多10张图片参考');
    for(const ref of request.references||[]){
      const bytes=await readFile(ref.path);
      if(ref.fileHash&&createHash('sha256').update(bytes).digest('hex')!==ref.fileHash)throw Error('参考图文件已变化，未提交生成');
      references.push(await stageReference(ref.path,await sharp(bytes).png().toBuffer()));
    }
    const created = await api('/images', { method: 'POST', body: {
      prompt, model: request.model, frame_type: 'asset', aspect_ratio: asset.referenceRole==='turnaround'?'3:2':request.aspectRatio || '16:9',...(references.length?{reference_images:references}:{}),
    } });
    const item = await waitFor('images', created.id, 15 * 60 * 1000);
    const bytes = await downloadLocalMedia(item.local_path, 30 * 1024 * 1024);
    await writeFile(process.argv[3], await sharp(bytes).png().toBuffer());
  } else throw new Error('未知图片任务');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
