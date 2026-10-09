const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeQueries = 0;
const waitingQueries = [];
async function query(request, route) {
  if (activeQueries >= 8) await new Promise(resolve => waitingQueries.push(resolve));
  else activeQueries++;
  try { return await request(route); }
  finally {
    const next = waitingQueries.shift();
    if (next) next(); else activeQueries--;
  }
}

// Only result queries are retried. A generation POST must never enter this loop.
export async function pollRemoteTask({route, id, maxMs, request, onState = async () => {},
  intervalMs = 3000, sleep = wait, now = Date.now}) {
  const started = now();
  let failures = 0;
  while (now() - started < maxMs) {
    let data;
    try { data = await query(request, `${route}/${encodeURIComponent(id)}`); failures = 0; }
    catch (error) {
      if (!/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|timeout|timed out|aborted|HTTP (?:429|5\d\d)\b/iu.test(String(error.message))) throw error;
      failures++;
      await sleep(Math.max(0, Math.min(maxMs - (now() - started), Math.min(60000, intervalMs * 2 ** Math.min(failures, 4)))));
      continue;
    }
    const state = String(data.status || data.data?.status || '').toLowerCase();
    await onState(state, data);
    if (['completed', 'succeeded', 'success'].includes(state)) return data;
    if (['failed', 'cancelled', 'canceled'].includes(state))
      throw new Error(`模型任务 ${id} 失败：${String(data.error?.message || data.message || state).slice(0, 300)}`);
    await sleep(Math.max(0, Math.min(intervalMs, maxMs - (now() - started))));
  }
  throw new Error(`远端任务 ${id} 尚未确认完成；保留原任务号，勿重复付费提交`);
}
