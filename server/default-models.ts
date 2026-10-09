import path from 'node:path';
import { knownVideoCapabilities, type ModelKind, type VideoModel } from '../shared/model.js';

// Fresh installations use these models unless the user saves another default.
export const BUILTIN_MODEL_IDS = {
  text: 'claude-opus-5-5',
  image: 'gpt-image-2.5-sunburst',
  video: '专享sd2.5(30图10音/4-30秒/720p)',
} as const;

export function builtinModels(root = process.cwd()): Record<ModelKind, VideoModel> {
  return Object.fromEntries(Object.entries(BUILTIN_MODEL_IDS).map(([kind, modelId]) => [kind, {
    name: modelId, modelId, adapterPath: path.resolve(root, 'adapters', `direct-${kind}.mjs`),
    ...(kind === 'video' ? { capabilities: knownVideoCapabilities(modelId) } : {}),
  }])) as Record<ModelKind, VideoModel>;
}
