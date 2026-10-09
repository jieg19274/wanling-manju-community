const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('node:fs');
const file = process.argv[2];
if (!existsSync(file)) { process.stdout.write('0'); process.exit(0); }
const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
try {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const checks = [
    ['jobs', "status IN ('queued','running','paused')"],
    ['adapter_tasks', "status='running'"],
    ['studio_runs', "json_extract(payload,'$.status') IN ('starting','running')"],
    ['agent_workflows', "json_extract(payload,'$.status')='running'"],
  ];
  let count = 0;
  for (const [table, condition] of checks) {
    if (tables.has(table)) count += Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${condition}`).get().n);
  }
  process.stdout.write(String(count));
} finally { db.close(); }
