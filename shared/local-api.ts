type LocalFetch = (input: string, options?: RequestInit) => Promise<Response>;

async function connectionError(request: LocalFetch, path: string): Promise<Error> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    if (path === '/api/health') throw new Error('health request failed');
    const response = await request('/api/health', { signal: controller.signal, cache: 'no-store' });
    const value = await response.json() as { ok?: boolean };
    if (!response.ok || value.ok !== true) throw new Error('service unavailable');
    return new Error('未收到本次操作的完整响应，请重新进入项目确认保存结果后再操作。');
  } catch {
    return new Error('无法连接本机服务。请通过桌面快捷方式重新启动软件，保留启动窗口，再返回页面操作。');
  } finally { clearTimeout(timeout); }
}

export async function requestJson<T>(path: string, options: RequestInit = {}, request: LocalFetch = fetch): Promise<T> {
  let response: Response;
  try { response = await request(path, options); }
  catch { throw await connectionError(request, path); }
  let value: T & { error?: string };
  try { value = await response.json(); }
  catch { throw await connectionError(request, path); }
  if (!response.ok) throw Object.assign(new Error(value?.error || `请求失败：${response.status}`),{status:response.status});
  return value;
}
