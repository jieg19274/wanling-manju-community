import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const folder = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：node scripts/relocate-draft.mjs 新草稿目录');
const manifest = JSON.parse(readFileSync(path.join(folder, 'manju_manifest.json'), 'utf8'));
if (!manifest.portable) throw new Error('草稿没有可迁移素材清单');
const replacements = manifest.clips.map(clip => {
  const file = path.resolve(folder, clip.relativePath);
  if (!file.startsWith(folder + path.sep) || !existsSync(file)) throw new Error('素材路径不安全或文件缺失');
  return [clip.source.replaceAll('\\','/'), file.replaceAll('\\','/')];
});
for (const name of ['draft_content.json', 'draft_content.json.bak', 'draft_meta_info.json']) {
  const target = path.join(folder, name), value = JSON.parse(readFileSync(target, 'utf8'));
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key,value]) => [key,
      ['draft_fold_path','draft_root_path'].includes(key) ? folder.replaceAll('\\','/') : visit(value)]));
    return typeof item === 'string' ? replacements.find(([source]) => source === item)?.[1] || item : item;
  }
  writeFileSync(target, JSON.stringify(visit(value)));
}
manifest.clips.forEach((clip,index) => { clip.source = replacements[index][1]; });
writeFileSync(path.join(folder,'manju_manifest.json'), JSON.stringify(manifest,null,2));
console.log('素材路径已重新定位');
