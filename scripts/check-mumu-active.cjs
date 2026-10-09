const Database = require(process.argv[2]);
const db = new Database(process.argv[3], { readonly: true, fileMustExist: true });
let count = 0;
for (const table of ['async_tasks', 'image_generations', 'video_generations']) {
  count += db.prepare(`SELECT COUNT(*) AS n FROM ${table}
    WHERE status IN ('pending','processing','submitted','running')`).get().n;
}
process.stdout.write(String(count));
