import path from 'node:path';
import { db, updateProject } from './store.js';
import type { ModelKind, VideoModel } from '../shared/model.js';

type Capability = { duration?: { max_seconds?: number }; prompt?: { max_unicode_code_points?: number };
  references?: { max_image_urls?: number }; aspect_ratio?: { allowed?: string[] } };
export type MumuModelGroup = { kind: ModelKind; name: string; provider: string; models: string[];
  defaultModel: string; ready: boolean; capabilities?: Record<string, Capability | null> };

function mumuUrl(route: string): URL {
  const base = new URL(process.env.MANJU_MUMU_BASE_URL || 'http://127.0.0.1:5699');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/') throw new Error('木木工坊 API 仅允许本机 HTTP 地址');
  return new URL(route, base);
}

export async function mumuModels(): Promise<MumuModelGroup[]> {
  const token = process.env.MANJU_MUMU_SESSION_TOKEN || '';
  if (token.length < 32) throw new Error('木木工坊联动尚未启动；请使用联动启动脚本');
  const res = await fetch(mumuUrl('/api/v1/integrations/manju-studio/models'), {
    signal: AbortSignal.timeout(5000), redirect: 'error',
    headers: { 'x-manjuflow-session': token,
      cookie: `manjuflow_local_session=${encodeURIComponent(token)}` },
  });
  const json = await res.json() as { success?: boolean; data?: MumuModelGroup[]; error?: { message?: string } };
  if (!res.ok || !json.success || !Array.isArray(json.data))
    throw new Error(`木木工坊模型接口不可用：${json.error?.message || `HTTP ${res.status}`}`);
  return json.data;
}

export async function mumuStatus() {
  let running = false;
  try { running = (await fetch(mumuUrl('/health'), { signal: AbortSignal.timeout(1500) })).ok; }
  catch { /* service is offline */ }
  try { return { running, connected: true, models: await mumuModels() }; }
  catch (error) { return { running, connected: false, models: [] as MumuModelGroup[],
    detail: error instanceof Error ? error.message : String(error) }; }
}

function adapter(kind: ModelKind): string {
  return path.resolve(process.cwd(), 'adapters', `mumu-${kind}.mjs`);
}

export async function connectMumu(projectId: string) {
  const pending = db.prepare("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running','paused') LIMIT 1")
    .get(projectId);
  if (pending) throw new Error('项目还有待执行任务，请先等任务完成再切换模型');
  const groups = await mumuModels();
  const selected = (['text', 'image', 'video'] as ModelKind[]).map(kind => {
    const group = groups.find(item => item.kind === kind && item.ready && item.models.length);
    if (!group) throw new Error(`木木工坊未配置可用的${kind}模型`);
    return { kind, group, model: group.defaultModel || group.models[0] };
  });
  return updateProject(projectId, project => {
    for (const { kind, group, model } of selected) {
      const raw = kind === 'video' ? group.capabilities?.[model] : null;
      const capability = raw ? {
        ...(raw.duration?.max_seconds ? { maxDurationSec: raw.duration.max_seconds } : {}),
        ...(raw.references?.max_image_urls ? { maxReferences: raw.references.max_image_urls } : {}),
        ...(raw.prompt?.max_unicode_code_points ? { maxPromptChars: raw.prompt.max_unicode_code_points } : {}),
        ...(raw.aspect_ratio?.allowed?.length ? { aspectRatios: raw.aspect_ratio.allowed.filter(
          value => ['16:9', '9:16', '1:1'].includes(value)) as ('16:9' | '9:16' | '1:1')[] } : {}),
      } : undefined;
      project[`${kind}Model`] = { name: group.name, modelId: model, adapterPath: adapter(kind),
        ...(capability ? { capabilities: capability } : {}) } as VideoModel;
      if (project.modelChecks) delete project.modelChecks[kind];
    }
  });
}
