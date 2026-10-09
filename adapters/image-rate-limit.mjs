import fs from 'node:fs';
import path from 'node:path';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Adapter processes share reservations. Stay below 20 image submissions/minute.
// Result queries do not reserve a submission slot.
export async function imageSubmissionPermit(dataDirectory = process.env.MANJU_DATA_DIR || path.join(process.cwd(), 'data')) {
  const folder = path.resolve(dataDirectory, 'image-submission-rate');
  const lock = path.join(folder, 'reservation.lock'), state = path.join(folder, 'next.json');
  fs.mkdirSync(folder, {recursive:true});
  for (;;) {
    try { fs.mkdirSync(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) throw new Error('图片提交限流锁未释放；未提交生成，请检查本地任务'); }
      catch (check) { if (check.code !== 'ENOENT') throw check; }
      await sleep(50);
      continue;
    }
    let delay;
    try {
      const next = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')).nextAt : 0;
      if (!Number.isFinite(next)) throw new Error('图片提交节奏记录损坏；未提交生成');
      delay = Math.max(0, next - Date.now());
      if (!delay) fs.writeFileSync(state, JSON.stringify({nextAt:Date.now() + 3300}));
    } finally { fs.rmdirSync(lock); }
    if (!delay) return;
    await sleep(delay);
  }
}
