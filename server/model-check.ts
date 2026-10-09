import { now, type ModelKind } from '../shared/model.js';
import { runJsonAdapter } from './adapter-runner.js';
import { getProject, updateProject } from './store.js';

export async function testModelConnection(projectId: string, kind: ModelKind) {
  if (!['text', 'image', 'video'].includes(kind)) throw new Error('未知模型类型');
  const project = getProject(projectId), model = project[`${kind}Model`];
  if (!model?.adapterPath) throw new Error('请先配置本机适配器');
  const result = await runJsonAdapter<{ ok?: unknown; detail?: unknown }>(model.adapterPath, {
    task: 'health', kind, model: model.modelId,
    instruction: '只检查适配器与服务连接，不发起付费内容生成。',
  });
  if (result.ok !== true) throw new Error(`模型连接测试失败：${String(result.detail || '适配器未返回 ok=true')}`);
  const checkedAt = now();
  updateProject(projectId, current => {
    const selected = current[`${kind}Model`];
    if (selected?.adapterPath !== model.adapterPath || selected.modelId !== model.modelId)
      throw new Error('测试期间模型配置发生变化');
    current.modelChecks ??= {};
    current.modelChecks[kind] = { checkedAt, modelId: model.modelId, adapterPath: model.adapterPath };
  });
  return { ok: true, checkedAt, detail: String(result.detail || '适配器连接正常') };
}
