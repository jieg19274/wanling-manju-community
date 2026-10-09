import { execFileSync } from 'node:child_process';
import path from 'node:path';

function value(env, name) {
  const key = Object.keys(env).find(key => key.toUpperCase() === name);
  return key ? env[key] : undefined;
}
function proxyUrl(input) {
  try {
    const text = String(input || '').trim();
    if (!text || /\s/.test(text)) return undefined;
    const url = new URL(text.includes('://') ? text : 'http://' + text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function windowsProxySettings(server = '') {
  const parts = String(server).split(';').map(s => s.trim()).filter(Boolean);
  if (parts.length === 1 && !parts[0].includes('=')) {
    const proxy = proxyUrl(parts[0]); return { http: proxy, https: proxy };
  }
  const result = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    const kind = part.slice(0, separator).toLowerCase();
    if (separator > 0 && ['http', 'https'].includes(kind)) result[kind] = proxyUrl(part.slice(separator + 1));
  }
  return result;
}
function readWindowsProxy(env) {
  const executable = path.join(env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "$v=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop;[pscustomobject]@{enabled=($v.ProxyEnable -eq 1);server=[string]$v.ProxyServer;bypass=[string]$v.ProxyOverride}|ConvertTo-Json -Compress";
  try { return JSON.parse(execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/^\uFEFF/, '').trim()); }
  catch { return undefined; }
}
export function configureRuntimeNetwork(env, options = {}) {
  if ((options.platform || process.platform) === 'win32' && value(env, 'NODE_USE_SYSTEM_CA') === undefined)
    env.NODE_USE_SYSTEM_CA = '1';
  const windows = options.windowsProxy ?? ((options.platform || process.platform) === 'win32' ? readWindowsProxy(env) : undefined);
  if (windows?.enabled === true) {
    const proxies = windowsProxySettings(windows.server);
    if (!value(env, 'HTTP_PROXY') && proxies.http) env.HTTP_PROXY = proxies.http;
    if (!value(env, 'HTTPS_PROXY') && proxies.https) env.HTTPS_PROXY = proxies.https;
  }
  if (value(env, 'HTTP_PROXY') || value(env, 'HTTPS_PROXY')) {
    if (value(env, 'NODE_USE_ENV_PROXY') === undefined) env.NODE_USE_ENV_PROXY = '1';
    const bypass = String(value(env, 'NO_PROXY') || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const item of String(windows?.enabled ? windows.bypass || '' : '').split(';')) {
      const name = item.trim();
      if (name && /^[A-Za-z0-9*_.:\[\]-]+$/.test(name) && !bypass.includes(name)) bypass.push(name);
    }
    for (const local of ['localhost', '127.0.0.1', '::1']) if (!bypass.includes(local)) bypass.push(local);
    const key = Object.keys(env).find(key => key.toUpperCase() === 'NO_PROXY') || 'NO_PROXY';
    env[key] = bypass.join(',');
  }
  return env;
}
