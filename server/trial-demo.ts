import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, db, insertProject } from './store.js';
import { builtinModels } from './default-models.js';
import { mediaPath } from './media.js';
import { referenceHashes } from './reference-provenance.js';
import { generationSignature } from '../shared/generation.js';
import { contentHash, digest, type Project } from '../shared/model.js';
import {isCharacterSheet,requiresPortraitReference} from '../shared/asset-references.js';

// Trial launch opts in to a public fixture. No jobs, workflows, sessions or grants
// are imported. A marker prevents a deleted sample from reappearing on restart.
export function initializeTrialDemo(): boolean {
  const folder = process.env.MANJU_TRIAL_SAMPLE;
  if (!folder) return false;
  const marker = path.join(dataDir, 'trial-sample-imported.json');
  if (existsSync(marker) || Number(db.prepare('SELECT COUNT(*) AS n FROM projects').get()?.n)) return false;
  const project = JSON.parse(readFileSync(path.join(folder, 'project.json'), 'utf8')) as Project;
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8')) as {
    version: number; files: { file: string; sha256: string }[];
  };
  if (manifest.version !== 1 || project.demo?.version !== 1 || project.episodes.length !== 1)
    throw new Error('演示项目格式无效');
  const sources = path.resolve(folder, 'media');
  const validated = new Map<string, string>();
  for (const item of manifest.files) {
    if (path.isAbsolute(item.file) || item.file.includes('\\') || item.file.split('/').some(p => !p || p === '..' || p === '.'))
      throw new Error('演示素材路径无效');
    const source = path.resolve(sources, item.file);
    if (!source.startsWith(sources + path.sep) || createHash('sha256').update(readFileSync(source)).digest('hex') !== item.sha256)
      throw new Error('演示素材校验失败');
    validated.set(item.file, source);
  }
  const paths = [project.demo.previewMediaPath,
    ...(project.assets || []).flatMap(a => a.images.map(i => i.mediaPath)),
    ...project.episodes.flatMap(e => e.segments.flatMap(s => s.artifacts.flatMap(a => a.mediaPath ? [a.mediaPath] : [])))];
  if (paths.some(file => !validated.has(file))) throw new Error('演示项目缺少素材');
  for (const [relative, source] of validated) {
    const target = mediaPath(`samples/promo-v1/${relative}`);
    if (existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') !==
        createHash('sha256').update(readFileSync(source)).digest('hex')) throw new Error('演示素材与已有文件冲突');
    mkdirSync(path.dirname(target), { recursive: true });
    if (!existsSync(target)) copyFileSync(source, target);
  }
  const local = (relative: string) => `samples/promo-v1/${relative}`;
  const models = builtinModels();
  project.textModel = models.text; project.imageModel = models.image; project.videoModel = models.video;
  project.demo.previewMediaPath = local(project.demo.previewMediaPath);
  for (const asset of project.assets || []) for (const image of asset.images) image.mediaPath = local(image.mediaPath);
  const specs: { id: string; payload: object }[] = [];
  for (const episode of project.episodes) for (const segment of episode.segments) for (const artifact of segment.artifacts) {
    if (artifact.mediaPath) artifact.mediaPath = local(artifact.mediaPath);
    if (artifact.kind !== 'video') continue;
    artifact.sourceHash = contentHash(episode, segment);
    const legacyReferences = segment.assetBindings?.some(binding => {
      const asset=project.assets?.find(a=>a.id===binding.assetId);
      return asset && requiresPortraitReference(asset) && !isCharacterSheet(asset.images.find(i=>i.id===binding.imageId));
    });
    if (legacyReferences) {
      episode.auditApprovedHash=undefined;
      episode.sampleApprovedHash=undefined;
      // The old sample remains viewable history, not a newly approved production
      // input. Its files were checked above; do not invent a complete sheet or
      // waive the new reference contract to import an existing preview.
      artifact.referenceHashes = (segment.assetBindings || []).flatMap(binding =>
        [binding.imageId,binding.portraitImageId].filter(Boolean).map(imageId => {
          const image=project.assets?.find(a=>a.id===binding.assetId)?.images.find(i=>i.id===imageId);
          if(!image)throw new Error('演示历史参考图缺失');
          return {imageId:image.id,hash:createHash('sha256').update(readFileSync(mediaPath(image.mediaPath))).digest('hex')};
        }));
      artifact.generationHash=digest({origin:'historical-demo',source:artifact.sourceHash,references:artifact.referenceHashes});
    } else {
      artifact.generationHash = generationSignature(project, episode, segment);
      artifact.referenceHashes = referenceHashes(project, episode, segment);
    }
    artifact.specId = `sample-import-${artifact.id}`;
    // Keep authentic technical findings; bind them to the hash-verified local copy.
    if (artifact.technical && artifact.mediaPath) {
      const stat = statSync(mediaPath(artifact.mediaPath));
      artifact.technical.size = stat.size; artifact.technical.modifiedAt = stat.mtimeMs;
    }
    specs.push({ id: artifact.specId, payload: { version: 1, origin: 'import', sample: true, legacyReferences:Boolean(legacyReferences),
      hash: artifact.generationHash, references: artifact.referenceHashes,
      project: { ...structuredClone(project), sourceCorpus: undefined, episodes: [structuredClone(episode)] } } });
  }
  insertProject(project, specs);
  writeFileSync(marker, JSON.stringify({ version: 1, projectId: project.id }));
  return true;
}
