import fs from 'node:fs';
import { ensureAgentService } from './agent-service.mjs';
const [operation = 'connect', file] = process.argv.slice(2);
const input = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const operations = {
  connect: () => ['/api/agent'],
  readiness: () => ['/api/agent/readiness' + (input.projectId ? '?projectId=' + encodeURIComponent(input.projectId) : '')],
  dashboard: () => [`/api/projects/${encodeURIComponent(input.projectId)}/agent/dashboard`],
  projects: () => ['/api/projects'],
  create: () => ['/api/agent/projects', input],
  context: () => [`/api/projects/${encodeURIComponent(input.projectId)}/agent${input.episodeId ? '?episodeId=' + encodeURIComponent(input.episodeId) : ''}`],
  task: () => [`/api/projects/${encodeURIComponent(input.projectId)}/agent/task`, input],
  command: () => [`/api/projects/${encodeURIComponent(input.projectId)}/agent/command`, input],
  defaults: () => ['/api/production-defaults', file ? input : undefined],
};
try {
  if (!operations[operation]) throw Error('命令须为connect/readiness/projects/create/context/dashboard/task/command/defaults');
  const connection = await ensureAgentService();
  const [route, body] = operations[operation]();
  const response = await fetch(connection.base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(180_000), headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '软件接口失败');
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
