import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { accountNetworkError } from '../dist-server/server/account-network.js';
import { configureRuntimeNetwork, windowsProxySettings } from '../scripts/network-env.mjs';

test('账户网络失败保留DNS、证书和超时原因，不泄漏底层请求秘密', () => {
  const error = new TypeError('fetch failed; Authorization: secret', { cause: { code: 'ENOTFOUND' } });
  assert.match(accountNetworkError(error, '木木登录配置检查').message, /登录配置检查失败.*DNS.*ENOTFOUND/);
  assert.doesNotMatch(accountNetworkError(error).message, /Authorization|secret/);
  assert.match(accountNetworkError({ cause: new AggregateError([{ code: 'ECONNRESET' }, { code: 'SELF_SIGNED_CERT_IN_CHAIN' }]) }).message, /证书.*SELF_SIGNED_CERT_IN_CHAIN/);
  assert.match(accountNetworkError(new DOMException('aborted', 'TimeoutError')).message, /超时.*TIMEOUT/);
});
test('Windows现有手动代理按目标协议读取，拒绝不支持或含凭据的注册表地址', () => {
  assert.deepEqual(windowsProxySettings('proxy.example:8080'), { http: 'http://proxy.example:8080/', https: 'http://proxy.example:8080/' });
  assert.deepEqual(windowsProxySettings('http=127.0.0.1:7890;https=proxy.example:8080;socks=127.0.0.1:1080'), { http: 'http://127.0.0.1:7890/', https: 'http://proxy.example:8080/' });
  assert.deepEqual(windowsProxySettings('socks5://127.0.0.1:1080'), { http: undefined, https: undefined });
  assert.deepEqual(windowsProxySettings('user:password@proxy.example:8080'), { http: undefined, https: undefined });
});
test('仅为当前进程配置系统证书与已有代理，保持显式配置并绕过本机服务', () => {
  const env = { https_proxy: 'http://existing.example:8888', no_proxy: 'example.local', NODE_USE_SYSTEM_CA: '0' };
  configureRuntimeNetwork(env, { platform: 'win32', windowsProxy: { enabled: true, server: '127.0.0.1:7890', bypass: '*.corp;<local>' } });
  assert.equal(env.https_proxy, 'http://existing.example:8888');
  assert.equal(env.NODE_USE_SYSTEM_CA, '0');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.no_proxy, 'example.local,*.corp,localhost,127.0.0.1,::1');
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  const direct = configureRuntimeNetwork({}, { platform: 'win32', windowsProxy: { enabled: false, server: '127.0.0.1:7890' } });
  assert.equal(direct.NODE_USE_SYSTEM_CA, '1'); assert.equal(direct.HTTPS_PROXY, undefined); assert.equal(direct.NODE_USE_ENV_PROXY, undefined);
});
test('内置Node实际采用现有代理访问外部目标，本机接口保持直连', async () => {
  let proxyHits = 0, directHits = 0;
  const proxy = http.createServer((req, res) => { proxyHits++; assert.equal(req.url, 'http://unreachable.invalid/config'); res.end('{"proxied":true}'); });
  const tunnels = new Set();
  proxy.on('connect', (req, socket) => {
    proxyHits++; assert.equal(req.url, 'unreachable.invalid:80'); tunnels.add(socket);
    socket.on('error', () => {}); socket.on('close', () => tunnels.delete(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.includes('\r\n\r\n')) {
        const body = '{"proxied":true}';
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
      }
    });
  });
  const direct = http.createServer((req, res) => { directHits++; res.end('{"local":true}'); });
  await Promise.all([new Promise(r => proxy.listen(0, '127.0.0.1', r)), new Promise(r => direct.listen(0, '127.0.0.1', r))]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:https?_proxy|no_proxy|node_use_env_proxy|node_use_system_ca|node_options|node_tls_reject_unauthorized)$/i.test(key)) delete env[key];
  configureRuntimeNetwork(env, { platform: 'win32', windowsProxy: { enabled: true, server: '127.0.0.1:' + proxy.address().port } });
  try {
    const script = `const external=await fetch('http://unreachable.invalid/config',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());const local=await fetch('http://127.0.0.1:${direct.address().port}/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());if(!external.proxied||!local.local)process.exit(1);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, windowsHide: true, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0); assert.equal(proxyHits, 1); assert.equal(directHits, 1);
  } finally { for (const socket of tunnels) socket.destroy(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => direct.close(r))]); }
});
