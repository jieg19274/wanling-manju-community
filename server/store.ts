import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,existsSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/model.js';

export const dataDir = path.resolve(process.env.MANJU_DATA_DIR || path.join(process.cwd(), 'data'));
mkdirSync(dataDir, { recursive: true });
const priorDatabase=existsSync(path.join(dataDir,'studio.db'));
export const db = new DatabaseSync(path.join(dataDir, 'studio.db'), { timeout: 5000 });
if(priorDatabase) {
  const versionTable=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'").get();
  const version=versionTable ? db.prepare('SELECT MAX(version) AS version FROM schema_versions').get()?.version : 0;
  if(Number(version || 0)<6) {
    const folder=path.resolve(process.env.MANJU_BACKUP_DIR || path.join(process.cwd(),'backups'));mkdirSync(folder,{recursive:true});
    db.exec(`VACUUM INTO '${path.join(folder,`pre-migration-${Date.now()}-${process.pid}.db`).replaceAll("'","''")}'`);
  }
}
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, episode_id TEXT NOT NULL,
    segment_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS candidate_batches(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
// Additive migration; legacy requests without provenance never auto-resubmit.
const columns = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
if (!columns.some(column => column.name === 'snapshot')) db.exec('ALTER TABLE jobs ADD COLUMN snapshot TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT OR IGNORE INTO schema_versions VALUES(1, datetime('now'));
  CREATE TABLE IF NOT EXISTS worker_lease(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS generation_specs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
  INSERT OR IGNORE INTO generation_specs SELECT id,project_id,snapshot,created_at FROM jobs WHERE snapshot IS NOT NULL;
  CREATE TRIGGER IF NOT EXISTS immutable_generation_specs BEFORE UPDATE ON generation_specs BEGIN SELECT RAISE(ABORT,'generation spec is immutable'); END;
  INSERT OR IGNORE INTO schema_versions VALUES(4,datetime('now'));`);
db.exec(`CREATE TABLE IF NOT EXISTS adapter_tasks(id TEXT PRIMARY KEY, project_id TEXT, task TEXT NOT NULL,
  fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL, output_path TEXT NOT NULL,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS active_adapter_tasks ON adapter_tasks(fingerprint)
    WHERE status IN ('running','remote_unknown');
  CREATE UNIQUE INDEX IF NOT EXISTS reserved_adapter_tasks ON adapter_tasks(fingerprint)
    WHERE status IN ('queued','running','remote_unknown');`);
if (!db.prepare('SELECT version FROM schema_versions WHERE version=2').get()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Preserve every historical record; only unsubmitted duplicates may be cancelled.
    db.exec(`UPDATE jobs SET status=CASE WHEN status='running' THEN 'failed' ELSE 'cancelled' END,
      error=CASE WHEN status='running' THEN '迁移发现重复运行请求：远端未知，必须对账' ELSE '迁移取消重复未提交任务' END
      WHERE id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY project_id,episode_id,segment_id,kind
        ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,created_at,rowid) AS rank
        FROM jobs WHERE status IN ('queued','running','paused')) WHERE rank>1);
      CREATE UNIQUE INDEX IF NOT EXISTS active_jobs ON jobs(project_id,episode_id,segment_id,kind)
        WHERE status IN ('queued','running','paused');
      INSERT INTO schema_versions VALUES(2,datetime('now'));`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function acquireWorker(): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare('SELECT pid FROM worker_lease WHERE id=1').get() as { pid: number } | undefined;
    if (owner && owner.pid !== process.pid) {
      let alive = false;
      try { process.kill(owner.pid, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true; }
      if (alive) throw new Error('本数据目录已有活动工作实例，拒绝恢复或抢占任务');
    }
    db.prepare('INSERT OR REPLACE INTO worker_lease VALUES(1,?)').run(process.pid);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function listProjects(): Pick<Project, 'id' | 'name' | 'mode' | 'updatedAt' | 'archivedAt'>[] {
  return db.prepare("SELECT id,name,updated_at AS updatedAt,json_extract(payload,'$.mode') AS mode,json_extract(payload,'$.archivedAt') AS archivedAt FROM projects ORDER BY updated_at DESC").all() as unknown as Pick<Project, 'id' | 'name' | 'mode' | 'updatedAt' | 'archivedAt'>[];
}

export function getProject(id: string): Project {
  const row = db.prepare('SELECT payload FROM projects WHERE id=?').get(id) as { payload: string } | undefined;
  if (!row) throw new Error('项目不存在');
  const project = JSON.parse(row.payload) as Project;
  if (!Array.isArray(project.episodes)) {
    project.episodes = db.prepare('SELECT payload FROM project_episodes WHERE project_id=? ORDER BY position').all(id)
      .map(row => JSON.parse(String(row.payload)));
    for(const episode of project.episodes)hydrateArtifacts(id,episode);
    const source = db.prepare('SELECT payload FROM project_sources WHERE project_id=?').get(id);
    if (source) Object.assign(project, JSON.parse(String(source.payload)));
  }
  return project;
}

db.exec(`CREATE TABLE IF NOT EXISTS project_episodes(project_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,id));
  CREATE TABLE IF NOT EXISTS project_sources(project_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,episode_id TEXT NOT NULL,segment_id TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS artifacts_by_segment ON artifacts(project_id,episode_id,segment_id,position);
  CREATE TABLE IF NOT EXISTS legacy_project_snapshots(project_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);

function hydrateArtifacts(projectId:string,episode:Project['episodes'][number]) {
  for(const segment of episode.segments)if(segment.artifactIds) {
    const rows=db.prepare('SELECT id,payload FROM artifacts WHERE project_id=? AND episode_id=? AND segment_id=? ORDER BY position').all(projectId,episode.id,segment.id);
    const records=new Map(rows.map(row=>[String(row.id),JSON.parse(String(row.payload))]));
    segment.artifacts=segment.artifactIds.map(id=>{const artifact=records.get(id);if(!artifact)throw new Error('版本记录缺失，拒绝静默丢失素材历史');return artifact;});
  }
  return episode;
}

function persistParts(project: Project): string {
  const {episodes, sourceCorpus, ...metadata} = project;
  const upsert = db.prepare(`INSERT INTO project_episodes VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET position=excluded.position,payload=excluded.payload WHERE position<>excluded.position OR payload<>excluded.payload`);
  const writeArtifact=db.prepare(`INSERT INTO artifacts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,payload=excluded.payload WHERE position<>excluded.position OR payload<>excluded.payload`);
  for (const [position, episode] of episodes.entries()) {
    for(const segment of episode.segments)for(const [index,artifact] of segment.artifacts.entries())writeArtifact.run(artifact.id,project.id,episode.id,segment.id,index,JSON.stringify(artifact));
    const stored={...episode,segments:episode.segments.map(segment=>({...segment,artifacts:[],artifactIds:segment.artifacts.map(artifact=>artifact.id)}))};
    upsert.run(project.id,episode.id,position,JSON.stringify(stored));
  }
  const keep = new Set(episodes.map(episode=>episode.id));
  for (const row of db.prepare('SELECT id FROM project_episodes WHERE project_id=?').all(project.id)) {
    if (!keep.has(String(row.id))) db.prepare('DELETE FROM project_episodes WHERE project_id=? AND id=?').run(project.id,String(row.id));
  }
  db.prepare(`INSERT INTO project_sources VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload`)
    .run(project.id,JSON.stringify({sourceCorpus}));
  return JSON.stringify(metadata);
}

if (!db.prepare('SELECT version FROM schema_versions WHERE version=3').get()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare('SELECT id,payload FROM projects').all()) {
      db.prepare('INSERT OR IGNORE INTO legacy_project_snapshots VALUES(?,?)').run(String(row.id),String(row.payload));
      db.prepare('UPDATE projects SET payload=? WHERE id=?').run(persistParts(JSON.parse(String(row.payload))),String(row.id));
    }
    db.exec("INSERT INTO schema_versions VALUES(3,datetime('now')); COMMIT");
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
if(!db.prepare('SELECT version FROM schema_versions WHERE version=5').get()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const row of db.prepare('SELECT id FROM projects').all()) {
      const project=getProject(String(row.id));db.prepare('UPDATE projects SET payload=? WHERE id=?').run(persistParts(project),project.id);
    }
    db.exec("INSERT INTO schema_versions VALUES(5,datetime('now')); COMMIT");
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function episodePage(projectId: string, offset = 0, limit = 20) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('无效分集分页');
  return db.prepare(`SELECT id,json_extract(payload,'$.number') AS number,json_extract(payload,'$.title') AS title FROM project_episodes WHERE project_id=? ORDER BY position LIMIT ? OFFSET ?`).all(projectId,limit,offset);
}

export function getProjectView(projectId: string, episodeId?: string, includeSource = false): Project {
  const row=db.prepare('SELECT payload FROM projects WHERE id=?').get(projectId);
  if (!row) throw new Error('项目不存在');
  const project=JSON.parse(String(row.payload)) as Project;
  const rows=db.prepare(`SELECT id,json_extract(payload,'$.number') AS number,json_extract(payload,'$.title') AS title,
    json_extract(payload,'$.segments') AS segments FROM project_episodes WHERE project_id=? ORDER BY position`).all(projectId);
  const selected=rows.some(row=>row.id===episodeId) ? episodeId : String(rows[0]?.id || '');
  const summaries=db.prepare(`SELECT episode_id,segment_id,id,json_object('id',id,'kind',json_extract(payload,'$.kind'),
    'createdAt',json_extract(payload,'$.createdAt'),'sourceHash',json_extract(payload,'$.sourceHash'),
    'promptArchive',json_extract(payload,'$.promptArchive'),
    'generationHash',json_extract(payload,'$.generationHash'),'mediaPath',json_extract(payload,'$.mediaPath'),
    'demo',json_extract(payload,'$.demo'),'review',json_extract(payload,'$.review')) AS payload FROM artifacts WHERE project_id=? ORDER BY position`).all(projectId);
  const bySegment=new Map<string,Map<string,unknown>>();
  for(const row of summaries){const key=String(row.segment_id);if(!bySegment.has(key))bySegment.set(key,new Map());bySegment.get(key)!.set(String(row.id),JSON.parse(String(row.payload)));}
  project.episodes=rows.map(row=>{
    if(row.id===selected) return hydrateArtifacts(projectId,JSON.parse(String(db.prepare('SELECT payload FROM project_episodes WHERE project_id=? AND id=?').get(projectId,String(row.id))!.payload)));
    const flags=db.prepare(`SELECT json_object('sourceReviewedHash',json_extract(payload,'$.sourceReviewedHash'),'highlightReviewedHash',json_extract(payload,'$.highlightReviewedHash'),
      'scriptLockedHash',json_extract(payload,'$.scriptLockedHash'),'auditApprovedHash',json_extract(payload,'$.auditApprovedHash'),'sampleApprovedHash',json_extract(payload,'$.sampleApprovedHash')) AS value FROM project_episodes WHERE project_id=? AND id=?`).get(projectId,String(row.id));
    return {id:String(row.id),number:Number(row.number),title:String(row.title),...JSON.parse(String(flags?.value || '{}')),sourceText:'',highlightReport:'',scriptBeats:[],
      segments:JSON.parse(String(row.segments || '[]')).map((segment: Record<string, unknown>)=>({...segment,artifacts:(segment.artifactIds as string[] || []).map(id=>bySegment.get(String(segment.id))?.get(id)).filter(Boolean),subshots:[],visualPlan:''}))};
  });
  if(includeSource) {
    const source=db.prepare('SELECT payload FROM project_sources WHERE project_id=?').get(projectId);
    if(source) Object.assign(project,JSON.parse(String(source.payload)));
  }
  return project;
}

export function insertProject(project: Project, importedSpecs: { id: string; payload: object }[] = [], onInsert?: () => void): Project {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO projects (id,name,updated_at,payload) VALUES (?,?,?,?)')
      .run(project.id, project.name, project.updatedAt, persistParts(project));
    for (const spec of importedSpecs) registerGenerationSpec(spec.id, project.id, spec.payload);
    onInsert?.();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return project;
}

export function updateProject(id: string, change: (project: Project) => void): Project {
  db.exec('BEGIN IMMEDIATE');
  try {
    const project = getProject(id);
    change(project);
    project.updatedAt = new Date().toISOString();
    db.prepare('UPDATE projects SET name=?,updated_at=?,payload=? WHERE id=?')
      .run(project.name, project.updatedAt, persistParts(project), id);
    db.exec('COMMIT');
    return project;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export interface Job {
  id: string; project_id: string; episode_id: string; segment_id: string; kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'; error: string | null;
  snapshot?: string;
  created_at: string; updated_at: string;
}

export function jobsFor(projectId: string): Job[] {
  const video = db.prepare('SELECT id,project_id,episode_id,segment_id,kind,status,error,created_at,updated_at FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 300').all(projectId) as unknown as Job[];
  const adapters = db.prepare("SELECT id,project_id,'' AS episode_id,'' AS segment_id,task AS kind,status,error,created_at,updated_at FROM adapter_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 300").all(projectId) as unknown as Job[];
  return [...video,...adapters].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,300);
}

export function insertJobs(jobs: Job[]): void {
  const stmt = db.prepare('INSERT INTO jobs (id,project_id,episode_id,segment_id,kind,status,error,created_at,updated_at,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const job of [...jobs]) {
      const existing = db.prepare("SELECT id FROM jobs WHERE project_id=? AND episode_id=? AND segment_id=? AND kind=? AND status IN ('queued','running','paused')").get(job.project_id,job.episode_id,job.segment_id,job.kind);
      if (existing) { jobs.splice(jobs.indexOf(job),1); continue; }
      stmt.run(job.id, job.project_id, job.episode_id, job.segment_id, job.kind,
        job.status, job.error, job.created_at, job.updated_at, job.snapshot || null);
      if(job.snapshot) db.prepare('INSERT INTO generation_specs VALUES(?,?,?,?)').run(job.id,job.project_id,job.snapshot,job.created_at);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function setJob(id: string, status: Job['status'], error: string | null = null): void {
  db.prepare('UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?').run(status, error, new Date().toISOString(), id);
}

export function nextJob(kinds?: Job['kind'][], excludedProjectIds: string[] = [], limit?: number): Job | undefined {
  if (kinds && !kinds.length) return undefined;
  const filters = ["status='queued'"];
  const parameters: Array<string | number> = [];
  if (kinds) { filters.push(`kind IN (${kinds.map(() => '?').join(',')})`); parameters.push(...kinds); }
  if (excludedProjectIds.length) {
    filters.push(`project_id NOT IN (${excludedProjectIds.map(() => '?').join(',')})`);
    parameters.push(...excludedProjectIds);
  }
  const capacity = limit === undefined ? '' : `AND (SELECT COUNT(*) FROM jobs WHERE status='running'
    ${kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''}) < ?`;
  if (limit !== undefined) parameters.push(...(kinds || []), limit);
  return db.prepare(`UPDATE jobs SET status='running',updated_at=? WHERE id=(SELECT id FROM jobs
    WHERE ${filters.join(' AND ')} ORDER BY created_at,rowid LIMIT 1) AND status='queued' ${capacity} RETURNING *`)
    .get(new Date().toISOString(), ...parameters) as Job | undefined;
}

export function jobById(id: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job | undefined;
}
export function generationSpec(projectId:string,specId:string) {
  const row=db.prepare('SELECT payload FROM generation_specs WHERE id=? AND project_id=?').get(specId,projectId);
  if(!row) throw new Error('生成版本不存在或没有冻结来源');
  return {id:specId,...JSON.parse(String(row.payload))};
}
export function registerGenerationSpec(id:string,projectId:string,payload:object) {
  db.prepare('INSERT INTO generation_specs VALUES(?,?,?,?)').run(id,projectId,JSON.stringify(payload),new Date().toISOString());
}

db.exec("INSERT OR IGNORE INTO schema_versions VALUES(6,datetime('now'));");
