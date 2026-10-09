import { digest, type ModelKind } from '../shared/model.js';
import { applyAction } from './actions.js';
import { directStatus, globalModels } from './direct-provider.js';
import { db, getProject, updateProject } from './store.js';

export function assertProjectModelIdle(projectId: string) {
  const job = db.prepare("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running','paused') LIMIT 1").get(projectId);
  const adapter = db.prepare("SELECT id FROM adapter_tasks WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(projectId);
  if (job || adapter) throw Error('项目还有待执行或正在生成的任务，请先等任务结束再更改模型');
}

export function useProjectDefaultModel(projectId: string, kind: string, input: Record<string, unknown>) {
  if (!['text', 'image', 'video'].includes(kind)) throw Error('未知模型类型');
  const role = kind as ModelKind, project = getProject(projectId), model = globalModels()[role];
  if (project.archivedAt) throw Error('项目已移入回收区，请先恢复');
  if (!directStatus().hasKey) throw Error('请先在软件设置中填写模型密钥');
  if (input.expectedDefaultModelHash !== digest(model)) throw Error('默认模型已变化，请刷新后核对要使用的模型');
  assertProjectModelIdle(projectId);
  return updateProject(projectId, current => {
    if (input.expectedModelHash !== digest(current[`${role}Model`] ?? null))
      throw Error('本项目模型已变化，请刷新后再切换');
    applyAction(current, { type: 'project.model', kind: role, name: model.name, modelId: model.modelId, adapterPath: model.adapterPath });
    // Copy the saved capability evidence without inventing a new confirmation.
    current[`${role}Model`] = structuredClone(model);
  });
}
