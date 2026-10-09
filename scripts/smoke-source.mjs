import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installation = process.argv[2] ? fs.realpathSync(process.argv[2]) : root;
const release = JSON.parse(fs.readFileSync(path.join(installation, 'release.json'), 'utf8'));
fs.mkdirSync(path.join(root, '.test-temp'), {recursive: true});
const temp = fs.mkdtempSync(path.join(root, '.test-temp/source-smoke-'));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const env = {...process.env};
for (const key of Object.keys(env)) if (key.startsWith('MANJU_') || key.startsWith('MUMU_') || key === 'NODE_OPTIONS') delete env[key];
Object.assign(env, {MANJU_PORT: String(port), MANJU_DATA_DIR: path.join(temp, 'data'),
  MANJU_BACKUP_DIR: path.join(temp, 'backups'), MANJU_JIANYING_DRAFTS_DIR: path.join(temp, 'drafts'),
  MANJU_TRIAL_SAMPLE: path.join(installation, 'examples/promo-demo'), MANJU_DIRECT_API_BASE_URL: 'http://127.0.0.1:1',
  MANJU_MUMU_BASE_URL: 'http://127.0.0.1:1',
  NODE_OPTIONS: '--import=' + new URL('../tests/network-guard.mjs', import.meta.url).href});
const child = spawn(process.execPath, ['dist-server/server/index.js'], {cwd: installation, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
child.stdout.resume();
const base = `http://127.0.0.1:${port}`;
const get = async route => {
  const response = await fetch(base + route, {signal: AbortSignal.timeout(5000)});
  assert.equal(response.ok, true, route);
  return response.json();
};
try {
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated server stopped: ' + stderr);
    try { health = await get('/api/health'); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(health, 'Isolated server startup: ' + stderr);
  assert.equal(health.version, release.version);
  assert.equal(path.resolve(health.installationRoot), installation);
  assert.equal(path.resolve(health.dataDirectory), path.join(temp, 'data'));
  const provider = await get('/api/direct-provider');
  assert.equal(provider.hasKey, false);
  const projects = await get('/api/projects');
  assert.equal(projects.length, 1);
  const demo = await get('/api/projects/' + projects[0].id);
  assert.equal((await get(`/api/projects/${demo.id}/jobs`)).length, 0);
  assert.equal((await get(`/api/projects/${demo.id}/workflows`)).length, 0);
  const media = [...new Set([demo.demo.previewMediaPath,
    ...demo.assets.flatMap(asset => asset.images.map(image => image.mediaPath)),
    ...demo.episodes.flatMap(episode => episode.segments.flatMap(segment => segment.artifacts.map(artifact => artifact.mediaPath)))].filter(Boolean))];
  assert.ok(media.length >= 4);
  for (const file of media) {
    const response = await fetch(base + '/media/' + file, {headers: {Range: 'bytes=0-100'}, signal: AbortSignal.timeout(5000)});
    assert.ok([200, 206].includes(response.status), file);
    await response.body?.cancel();
  }
  const response = await fetch(base + '/');
  const html = await response.text();
  assert.equal(response.ok, true);
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script);
  assert.equal((await fetch(base + script)).status, 200);
  const db = new DatabaseSync(path.join(temp, 'data/studio.db'), {readOnly: true});
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0); } finally { db.close(); }
  const result = {passed: true, version: release.version, isolatedData: true, noProviderKey: true,
    publicDemoIncluded: true, mediaChecked: media.length, frontendAvailable: true,
    generationJobs: 0, paidCalls: 0, externalModelNetworkBlocked: true};
  fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({...result, evidence: path.join(temp, 'result.json')}));
} finally {
  if (child.exitCode === null) await new Promise(resolve => {child.once('exit', resolve); child.kill();});
}
