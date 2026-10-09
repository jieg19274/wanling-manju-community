const details: Record<string, string> = {
  ENOTFOUND: '无法解析木木平台域名，请检查网络或DNS',
  EAI_AGAIN: '木木平台域名解析暂时失败，请稍后重试或检查DNS',
  ECONNREFUSED: '连接被拒绝，请检查已配置的代理是否运行及网络连接',
  ECONNRESET: '连接被中断，请检查网络和已配置的代理',
  UND_ERR_CONNECT_TIMEOUT: '连接木木平台超时，请检查网络和已配置的代理',
  ETIMEDOUT: '连接木木平台超时，请检查网络和已配置的代理',
  TIMEOUT: '木木平台请求超时，请检查网络后重试',
  CERT_HAS_EXPIRED: '平台证书已过期或电脑时间不正确，请核对系统时间',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证平台证书链，请检查Windows受信任证书与网络代理',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '缺少受信任的证书颁发机构，请检查Windows证书与网络代理',
  DEPTH_ZERO_SELF_SIGNED_CERT: '收到未受信任的自签名证书，请检查网络代理与证书配置',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链包含未受信任的证书，请检查Windows证书与网络代理',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名与木木平台不一致，请检查网络代理或域名解析'
};
export function accountNetworkError(error: unknown, stage = '木木账户连接'): Error {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  function inspect(item: unknown, depth: number): void {
    if (!item || typeof item !== 'object' || depth > 5 || seen.has(item)) return;
    seen.add(item);
    const current = item as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof current.code === 'string' && details[current.code]) codes.push(current.code);
    if (current.name === 'TimeoutError' || current.name === 'AbortError') codes.push('TIMEOUT');
    inspect(current.cause, depth + 1);
    if (Array.isArray(current.errors)) for (const child of current.errors) inspect(child, depth + 1);
  }
  inspect(error, 0);
  const code = codes.find(item => /CERT|SIGNATURE|ISSUER/.test(item)) || codes[0] || 'NETWORK_ERROR';
  const detail = details[code] || '无法连接木木平台，请检查网络、系统时间和已配置的代理';
  return new Error(`${stage}失败：${detail}（${code}）。`);
}
export async function accountFetch(url: URL, options: RequestInit, stage: string): Promise<Response> {
  try { return await fetch(url, options); }
  catch (error) { throw accountNetworkError(error, stage); }
}
