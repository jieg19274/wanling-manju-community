import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as model from '../dist-server/shared/model.js';
import {pathToFileURL} from 'node:url';

test('schema3 migration preserves source, archived history, selected references and artifacts with a pre-migration snapshot',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'manju-schema3-')),backups=path.join(root,'backups'),source=path.join(root,'data');mkdirSync(source);
  const project=model.makeProject('旧库迁移','standard'),episode=model.makeEpisode(1,'原集'),beat={...model.makeBeat(),event:'原事件',reaction:'原反应'};
  const segment=model.makeSegment(beat,1);segment.durationSec=30;
  const artifact={id:model.id(),kind:'video',createdAt:model.now(),sourceHash:'historical-hash',mediaPath:'kept-original.mp4',generationHash:'generation-hash',review:{status:'approved',notes:'历史审片证据',reviewedAt:model.now()}};
  segment.artifacts=[artifact];segment.selected.video=artifact.id;segment.assetBindings=[{assetId:'character',imageId:'main',portraitImageId:'portrait'}];episode.segments=[segment];episode.scriptBeats=[beat];
  episode.scriptHistory=[{version:1,archivedAt:model.now(),scriptBeats:[beat],segments:[structuredClone(segment)]}];project.sourceCorpus='必须保留的完整原文'.repeat(100);project.episodes=[episode];project.archivedEpisodes=[{...structuredClone(episode),id:model.id(),number:2}];
  const {episodes,sourceCorpus,...metadata}=project,db=new DatabaseSync(path.join(source,'studio.db'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,updated_at TEXT,payload TEXT);CREATE TABLE project_episodes(project_id TEXT,id TEXT,position INTEGER,payload TEXT,PRIMARY KEY(project_id,id));CREATE TABLE project_sources(project_id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE schema_versions(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO schema_versions VALUES(1,'old'),(2,'old'),(3,'old');CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,episode_id TEXT,segment_id TEXT,kind TEXT,status TEXT,error TEXT,created_at TEXT,updated_at TEXT,snapshot TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(project.id,project.name,project.updatedAt,JSON.stringify(metadata));db.prepare('INSERT INTO project_episodes VALUES(?,?,?,?)').run(project.id,episode.id,0,JSON.stringify(episode));db.prepare('INSERT INTO project_sources VALUES(?,?)').run(project.id,JSON.stringify({sourceCorpus}));db.close();
  const module=pathToFileURL(path.resolve('dist-server/server/store.js')).href;
  const script=`const s=await import(${JSON.stringify(module)}); const p=s.getProject(${JSON.stringify(project.id)}); process.stdout.write(JSON.stringify({project:p,version:s.db.prepare('SELECT MAX(version) AS version FROM schema_versions').get().version,artifact:s.db.prepare('SELECT payload FROM artifacts WHERE id=?').get(${JSON.stringify(artifact.id)}),stored:JSON.parse(s.db.prepare('SELECT payload FROM project_episodes WHERE id=?').get(${JSON.stringify(episode.id)}).payload)})); s.db.close();`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MANJU_DATA_DIR:source,MANJU_BACKUP_DIR:backups},windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);assert.equal(output.version,6);assert.equal(output.project.sourceCorpus,sourceCorpus);
  assert.deepEqual(output.project.episodes[0].segments[0].artifacts,[artifact]);assert.deepEqual(output.project.episodes[0].segments[0].assetBindings,segment.assetBindings);
  assert.deepEqual(output.project.archivedEpisodes,project.archivedEpisodes);assert.deepEqual(output.project.episodes[0].scriptHistory,episode.scriptHistory);
  assert.equal(output.stored.segments[0].artifacts.length,0);assert.deepEqual(output.stored.segments[0].artifactIds,[artifact.id]);assert.ok(output.artifact);
  const files=readdirSync(backups);assert.equal(files.length,1);const before=new DatabaseSync(path.join(backups,files[0]),{readOnly:true});assert.equal(before.prepare('SELECT MAX(version) AS version FROM schema_versions').get().version,3);before.close();
  const second=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MANJU_DATA_DIR:source,MANJU_BACKUP_DIR:backups},windowsHide:true,encoding:'utf8'});assert.equal(second.status,0,second.stderr);assert.equal(readdirSync(backups).length,1);
});

test('backup captures committed WAL data and restore refuses to overwrite existing data',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'manju-backup-'));
  const source=path.join(root,'source'), backup=path.join(root,'backup'), restored=path.join(root,'restored');
  mkdirSync(source);
  const db=new DatabaseSync(path.join(source,'studio.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('完整原文'); CREATE TABLE worker_lease(pid INTEGER); INSERT INTO worker_lease VALUES(12345);");
  let result=spawnSync(process.execPath,['scripts/storage-maintenance.mjs','backup',source,backup],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  result=spawnSync(process.execPath,['scripts/storage-maintenance.mjs','restore',backup,restored],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const reader=new DatabaseSync(path.join(restored,'studio.db'));
  assert.equal(reader.prepare('SELECT value FROM evidence').get().value,'完整原文');
  assert.equal(reader.prepare('SELECT count(*) AS n FROM worker_lease').get().n,0);
  assert.equal(db.prepare('SELECT pid FROM worker_lease').get().pid,12345);
  reader.close();db.close();
  result=spawnSync(process.execPath,['scripts/storage-maintenance.mjs','restore',backup,restored],{encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);
});

test('MCP negotiates without exposing credentials or budget approval; an offline app cannot execute tools',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'manju-mcp-'));
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize'}, {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'}, {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_projects',arguments:{}}}];
  const result=spawnSync(process.execPath,['dist-server/server/mcp.js'],{env:{...process.env,MANJU_DATA_DIR:root,MANJU_PORT:'1'},input:messages.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const replies=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length,3);
  assert.equal(replies[0].result.serverInfo.name,'wanling-manju');
  assert.deepEqual(replies[1].result.tools.map(tool=>tool.name),['agent_connect','agent_context','agent_readiness','agent_dashboard','agent_create_project','agent_task','agent_command','list_projects','get_project','audit_episode','list_tasks','get_provider_billing','list_workflows','start_workflow','control_workflow','save_source_draft','save_visual_plan']);
  assert.ok(!replies[1].result.tools.some(tool=>/authoriz|approv|lock/.test(tool.name)));
  assert.ok(replies[2].error);
});

test('portable draft relocation rebinds copied media and is repeatable',()=>{
  const folder=mkdtempSync(path.join(os.tmpdir(),'manju-relocate-'));
  mkdirSync(path.join(folder,'media'));writeFileSync(path.join(folder,'media','clip.mp4'),'local fixture');
  const source='X:/old/draft/media/clip.mp4';
  writeFileSync(path.join(folder,'manju_manifest.json'),JSON.stringify({portable:true,clips:[{source,relativePath:'media/clip.mp4'}]}));
  for(const name of ['draft_content.json','draft_content.json.bak','draft_meta_info.json']) writeFileSync(path.join(folder,name),JSON.stringify({materials:[{path:source}],draft_fold_path:'X:/old/draft'}));
  for(let i=0;i<2;i++) {
    const result=spawnSync(process.execPath,['scripts/relocate-draft.mjs',folder],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
  }
  const content=JSON.parse(readFileSync(path.join(folder,'draft_content.json'),'utf8'));
  assert.equal(content.materials[0].path,path.join(folder,'media','clip.mp4').replaceAll('\\','/'));
});

test('schema5 to schema6 snapshots before candidate migration and preserves existing history',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'manju-schema5-')),source=path.join(root,'data'),backups=path.join(root,'backups');mkdirSync(source);
  const uri=pathToFileURL(path.resolve('dist-server/server/store.js')).href;
  const setup=`const store=await import(${JSON.stringify(uri)});const model=await import(${JSON.stringify(pathToFileURL(path.resolve('dist-server/shared/model.js')).href)});const p=model.makeProject('旧库留存','standard');p.sourceCorpus='完整原文';store.insertProject(p);store.db.exec('DROP TABLE candidate_batches; DELETE FROM schema_versions WHERE version=6');store.db.close();`;
  const env={...process.env,MANJU_DATA_DIR:source,MANJU_BACKUP_DIR:backups};let result=spawnSync(process.execPath,['--input-type=module','-e',setup],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  const migrate=`const store=await import(${JSON.stringify(uri)});console.log(JSON.stringify({version:store.db.prepare('SELECT MAX(version) AS v FROM schema_versions').get().v,count:store.db.prepare('SELECT count(*) AS n FROM candidate_batches').get().n,project:store.getProject(store.listProjects()[0].id)}));store.db.close();`;
  result=spawnSync(process.execPath,['--input-type=module','-e',migrate],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert.equal(output.version,6);assert.equal(output.count,0);assert.equal(output.project.sourceCorpus,'完整原文');
  const files=readdirSync(backups);assert.equal(files.length,1);const snapshot=new DatabaseSync(path.join(backups,files[0]),{readOnly:true});assert.equal(snapshot.prepare('SELECT MAX(version) AS v FROM schema_versions').get().v,5);snapshot.close();
});
