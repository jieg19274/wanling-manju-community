import {declaredCapabilities} from '../shared/provider-capabilities.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { builtinModels } from './default-models.js';
import { dataDir, db, updateProject } from './store.js';
import { knownVideoCapabilities, type ModelKind, type Project, type VideoModel } from '../shared/model.js';

export const configPath = path.join(dataDir, 'direct-provider.json');

type Config = { protectedKey: string; models?: Partial<Record<ModelKind, VideoModel>> };

export const DIRECT_API_URL = process.env.MANJU_DIRECT_API_BASE_URL || 'https://api.mumugofe.com/v1';
export const CATALOG_API_URL = process.env.MANJU_CATALOG_API_BASE_URL || DIRECT_API_URL;

function powerShell(script: string, input: string): string {
  if (process.platform !== 'win32') throw new Error('当前密钥保护功能需要 Windows');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 100000 });
  if (result.status !== 0) throw new Error('Windows 用户密钥保护失败');
  return result.stdout.trim();
}

const protectScript = "Add-Type -AssemblyName System.Security; $raw = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $protected = [Security.Cryptography.ProtectedData]::Protect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))";
const unprotectScript = "Add-Type -AssemblyName System.Security; $raw = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $clear = [Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear))";

export const protectLocalSecret=(value:string)=>powerShell(protectScript,value);
export const unprotectLocalSecret=(value:string)=>powerShell(unprotectScript,value);

export function readConfig(): Config | null {
  if (!existsSync(configPath)) return null;
  const value = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  return value.protectedKey ? value : null;
}

export function directStatus() {
  const config = readConfig();
  const hostname = new URL(CATALOG_API_URL).hostname;
  return { configured: Boolean(config), hasKey: Boolean(config?.protectedKey),
    catalogMode: ['127.0.0.1','localhost','[::1]'].includes(hostname) ? 'local' : 'remote' };
}

export function saveDirectConfig(input: Record<string, unknown>) {
  const prior = readConfig();
  const key = String(input.apiKey || '').trim();
  if (key && (key.length < 8 || key.length > 4096 || /[\s\u0000-\u001f]/u.test(key)))
    throw new Error('API Key 格式无效');
  const protectedKey = key ? powerShell(protectScript, key) : prior?.protectedKey;
  if (!protectedKey) throw new Error('请填写新软件自己的 API Key');
  writeFileSync(configPath, JSON.stringify({ protectedKey, ...(prior?.models ? { models: prior.models } : {}) }), { mode: 0o600 });
  return directStatus();
}

export function globalModels() {
  return { ...builtinModels(), ...readConfig()?.models };
}

export function applyGlobalModels(project: Project): Project {
  const models = globalModels();
  for (const kind of ['text', 'image', 'video'] as ModelKind[]) {
    if (models[kind] && !project[`${kind}Model`]?.modelId) project[`${kind}Model`] = structuredClone(models[kind]);
  }
  return project;
}

export function saveGlobalModel(input: Record<string, unknown>) {
  const config = readConfig();
  if (!config) throw new Error('请先在软件设置中填写 API Key');
  const kind = String(input.kind || '') as ModelKind;
  const modelId = String(input.modelId || '').trim();
  if (!['text', 'image', 'video'].includes(kind)) throw new Error('未知模型类型');
  if (!modelId || modelId.length > 160 || /[\u0000-\u001f\u007f]/u.test(modelId)) throw new Error('模型 ID 无效');
  if (db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running','paused') LIMIT 1").get())
    throw new Error('还有待执行或正在生成的任务，请结束后再修改全局模型');
  const previous = config.models?.[kind];
  const known = kind === 'video' ? knownVideoCapabilities(modelId) : undefined;
  const model: VideoModel = { name: modelId, modelId,
    adapterPath: path.resolve(process.cwd(), 'adapters', `direct-${kind}.mjs`),
    ...(kind === 'video' && (previous?.modelId === modelId && previous.capabilities || known) ?
      { capabilities: { ...(previous?.modelId === modelId ? previous.capabilities : {}), ...known } } : {}) };
  const models = { ...config.models, [kind]: model };
  writeFileSync(configPath, JSON.stringify({ ...config, models }), { mode: 0o600 });
  return globalModels();
}

export type CatalogModel = { id: string; kind: ModelKind | 'other'; source: 'declared' | 'name'; declaredCapabilities?: VideoModel['capabilities'] };

function classify(value: Record<string, unknown>): CatalogModel {
  const id = String(value.id || '').trim();
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error('模型目录包含无效 ID');
  const fields = [value.type, value.service_type, value.model_type,
    ...(Array.isArray(value.output_modalities) ? value.output_modalities : []),
    ...(Array.isArray(value.supported_endpoint_types) ? value.supported_endpoint_types : [])]
    .filter(item => typeof item === 'string').join(' ').toLowerCase();
  const declaredVideo = value.is_video === true || /(?:video|text2video|image2video|openai-video)/u.test(fields);
  const declaredImage = value.is_image === true || value.is_storyboard_image === true ||
    /(?:image|text2image|image2image|images\/generations)/u.test(fields);
  const declaredText = value.is_text === true || /(?:chat|completion|text|reasoning)/u.test(fields);
  const namedVideo = /^(?:seedance|seeddance|sora|kling|hailuo|vidu|runway|wan\d|sd2|veo)/iu.test(id) || /(?:全能|专享|高速|极速).*sd2/iu.test(id);
  const namedImage = /^(?:gpt[-_]image|nano[-_ ]?banana|seedream|flux|dall[-_ ]?e|qwen[-_]image|doubao[-_]seedream|stable[-_ ]?diffusion)/iu.test(id)
    || /(?:image|img2img|storyboard|illustration)/iu.test(id);
  const namedText = /^(?:gpt|claude|deepseek|qwen|glm|gemini|kimi|moonshot|mistral|llama|o[134]|text)/iu.test(id);
  let kind: CatalogModel['kind'] = 'other', source: CatalogModel['source'] = 'name';
  if (declaredVideo || declaredImage || declaredText) {
    kind = declaredVideo ? 'video' : declaredImage ? 'image' : 'text'; source = 'declared';
  } else if (namedVideo) kind = 'video';
  else if (namedImage) kind = 'image';
  else if (namedText) kind = 'text';
  const capabilities=kind==='video' ? declaredCapabilities(value) : undefined;
  return { id, kind, source, ...(capabilities?{declaredCapabilities:capabilities}:{}) };
}

export async function fetchDirectModels() {
  const key = directKey(), base = new URL(CATALOG_API_URL);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) || base.username || base.password)
    throw new Error('内置模型地址配置无效');
  const models = new Map<string, CatalogModel>();
  let after = '';
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${base.href.replace(/\/+$/, '')}/models`);
    if (after) url.searchParams.set('after', after);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`读取模型目录失败：HTTP ${res.status}`);
    const raw = await res.text();
    if (raw.length > 8 * 1024 * 1024) throw new Error('模型目录响应过大');
    let data: { data?: unknown[]; has_more?: boolean; last_id?: string };
    try { data = JSON.parse(raw); } catch { throw new Error('模型目录返回非 JSON'); }
    if (!Array.isArray(data.data)) throw new Error('模型目录格式无效');
    for (const entry of data.data) {
      if (!entry || (typeof entry !== 'object' && typeof entry !== 'string'))
        throw new Error('模型目录包含无效条目');
      const item = classify(typeof entry === 'string' ? { id: entry } : entry as Record<string, unknown>);
      if (item.id.includes(key)) throw new Error('模型目录包含不安全字段');
      models.set(item.id, item);
      if (models.size > 20000) throw new Error('模型目录数量超限');
    }
    if (!data.has_more) return { fetchedAt: new Date().toISOString(), models: [...models.values()]
      .sort((a, b) => a.id.localeCompare(b.id)) };
    const last = data.data.at(-1);
    after = String(data.last_id || (typeof last === 'string' ? last : (last as { id?: string })?.id) || '');
    if (!after || seen.has(after)) throw new Error('模型目录分页异常');
    seen.add(after);
  }
  throw new Error('模型目录分页超过上限');
}

export function directKey(): string {
  const config = readConfig();
  if (!config) throw new Error('请先配置新软件自己的模型 API');
  return powerShell(unprotectScript, config.protectedKey);
}

export function connectDirect(projectId: string) {
  if (!readConfig()) throw new Error('请先配置新软件自己的模型 API');
  const pending = db.prepare("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running','paused') LIMIT 1")
    .get(projectId);
  if (pending) throw new Error('项目还有待执行任务，请先等任务结束再切换模型');
  return updateProject(projectId, project => {
    for (const kind of ['text', 'image', 'video'] as ModelKind[]) {
      const previous = project[`${kind}Model`];
      if (!previous?.modelId) throw new Error(`请先填写${kind}模型 ID`);
      project[`${kind}Model`] = { ...previous,
        adapterPath: path.resolve(process.cwd(), 'adapters', `direct-${kind}.mjs`) } as VideoModel;
      if (project.modelChecks) delete project.modelChecks[kind];
    }
  });
}
