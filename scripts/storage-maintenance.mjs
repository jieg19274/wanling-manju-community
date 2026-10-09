import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [operation, sourceArg, targetArg, mediaFlag] = process.argv.slice(2);
if (!['backup','restore'].includes(operation) || !sourceArg || !targetArg) throw new Error('用法：node scripts/storage-maintenance.mjs backup|restore 源目录 新目标目录 [--with-media]');
const source = path.resolve(sourceArg), target = path.resolve(targetArg);
if (source === target || target.startsWith(source+path.sep) || source.startsWith(target+path.sep)) throw new Error('源与目标不能相互包含');
if (existsSync(target) && readdirSync(target).length) throw new Error('目标须为新的空目录，绝不覆盖已有数据');
const database = path.join(source,'studio.db');
if (!existsSync(database)) throw new Error('源数据库不存在');
const reader = new DatabaseSync(database,{readOnly:true});
const integrity = reader.prepare('PRAGMA integrity_check').get();
if (integrity.integrity_check !== 'ok') throw new Error('源数据库完整性检查失败');
mkdirSync(target,{recursive:true});
if (operation === 'backup') {
  // SQLite creates a consistent snapshot including committed WAL transactions.
  reader.exec(`VACUUM INTO '${path.join(target,'studio.db').replaceAll("'","''")}'`);
  const withMedia = mediaFlag === '--with-media';
  if (existsSync(path.join(source,'upscale-settings.json'))) copyFileSync(path.join(source,'upscale-settings.json'),path.join(target,'upscale-settings.json'));
  if (withMedia && existsSync(path.join(source,'media'))) cpSync(path.join(source,'media'),path.join(target,'media'),{recursive:true,errorOnExist:true,force:false});
  writeFileSync(path.join(target,'backup_manifest.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),source,mediaIncluded:withMedia},null,2));
} else {
  const manifest = JSON.parse(readFileSync(path.join(source,'backup_manifest.json'),'utf8'));
  copyFileSync(database,path.join(target,'studio.db'));
  if (existsSync(path.join(source,'upscale-settings.json'))) copyFileSync(path.join(source,'upscale-settings.json'),path.join(target,'upscale-settings.json'));
  // A copied lease belongs to the source process, never to the restored instance.
  const restored = new DatabaseSync(path.join(target,'studio.db'));
  if (restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_lease'").get()) restored.exec('DELETE FROM worker_lease');
  restored.close();
  if (manifest.mediaIncluded && existsSync(path.join(source,'media'))) cpSync(path.join(source,'media'),path.join(target,'media'),{recursive:true,errorOnExist:true,force:false});
  console.log(manifest.mediaIncluded ? '恢复到新目录，包含素材；凭据需单独配置' : '仅恢复数据库；请保留原素材并配置素材来源，不能据此删除原数据');
}
reader.close();
console.log(operation==='backup'?'快照完成，原目录未改动':'恢复完成，原目录未改动');
