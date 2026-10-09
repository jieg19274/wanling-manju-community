import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function auditSource(files) {
  const issues = [];
  let bytes = 0;
  for (const relative of files) {
    const name = relative.replaceAll('\\', '/');
    if (/^(?:node_modules|dist|dist-server|data|runtime|backups|deliverables|portable-tools|\.test-temp|\.release-keys)\//.test(name) ||
        /(?:^|\/)(?:\.env(?:\.[^/]+)?|direct-provider\.json|provider-account\.json|[^/]*budget-profile[^/]*|[^/]*\.db(?:-wal|-shm)?|[^/]*\.sqlite(?:-wal|-shm)?|[^/]*\.(?:pem|key|pfx|p12|log|exe|dll|node))$/i.test(name)) {
      issues.push({path: name, reason: 'private state, credentials or distributable binary'});
      continue;
    }
    if (/^(?:design-system\/|docs\/(?:MVP|V0\.4\.|木木画布升级记录))/.test(name)) issues.push({path: name, reason: 'historical development document excluded from publication'});
    const file = path.join(root, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const size = fs.statSync(file).size;
    bytes += size;
    if (size > 25 * 1024 * 1024) issues.push({path: name, reason: 'source file exceeds 25 MiB'});
    if (!/\.(?:mjs|cjs|js|ts|tsx|json|md|txt|ps1|cmd|yml|yaml)$/i.test(name)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/Sentinel_[a-f0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,})\b/g)) {
      // Exactly one synthetic fixture tests package redaction; no broad test bypass.
      if (name === 'tests/software-update.test.mjs' && match[0] === 'Sentinel_' + '1234567890abcdef12345678') continue;
      issues.push({path: name, line: content.slice(0, match.index).split('\n').length, reason: 'private grant or credential pattern'});
    }
    if (new RegExp(['private', 'ssh', 'relay'].join('-')).test(content)) {
      issues.push({path: name, reason: 'producer-only deployment or project identifier'});
    }
  }
  return {passed: issues.length === 0, files: files.length, bytes, MiB: Math.round(bytes / 1024 / 1024 * 100) / 100, issues};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: root, encoding: 'utf8'})
    .split('\0').filter(Boolean);
  const result = auditSource([...new Set(files)]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
