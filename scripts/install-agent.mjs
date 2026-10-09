import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { agentSkillZip,bundledAgentDirectory,bundledVersion } from '../dist-server/server/agent-package.js';
export function installAgent(client, root, skillsDirectory) {
  if (!['codex', 'workbuddy', 'trae'].includes(client)) throw Error('客户端须为codex/workbuddy/trae');
  root = fs.realpathSync(root);
  const home = os.homedir();
  const defaults = { codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    trae: path.join(home, '.trae-cn', 'skills') };
  // WorkBuddy publishes a local ZIP import flow; do not guess its private config.
  const destination = path.resolve(skillsDirectory || defaults[client] || path.join(root, 'agent-exports', 'workbuddy'));
  const target = path.join(destination, 'wanling-manju');
  if (fs.existsSync(target)) {
    const stamp = path.join(target, 'installation.json');
    if (!fs.existsSync(stamp) || JSON.parse(fs.readFileSync(stamp, 'utf8')).root !== root)
      throw Error('目标已有同名技能，请先核对来源；没有覆盖另一份技能');
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(bundledAgentDirectory(root), target, { recursive: true });
  fs.writeFileSync(path.join(target, 'installation.json'), JSON.stringify({ root, client, version:bundledVersion(root), installedAt: new Date().toISOString() }, null, 2));
  const bundled = path.join(root, 'tools', 'node', 'node.exe');
  const config = { mcpServers: { 'wanling-manju': { command: fs.existsSync(bundled) ? bundled : process.execPath,
    args: [path.join(root, 'scripts', 'agent-mcp.mjs')] } } };
  fs.writeFileSync(path.join(destination, 'wanling-manju-mcp.json'), JSON.stringify(config, null, 2));
  const zip = path.join(destination, `wanling-manju-${client}-skill.zip`);
  fs.writeFileSync(zip, agentSkillZip(client, root));
  return { client, skillDirectory: target, mcpConfig: path.join(destination, 'wanling-manju-mcp.json'),
    zip, next: client === 'workbuddy' ? '将生成的ZIP导入WorkBuddy；CLI入口可自动启动软件。' : '重新打开客户端后使用万灵漫剧技能；也可通过设置导入生成的ZIP或添加MCP配置。' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(installAgent(process.argv[2], path.resolve(import.meta.dirname, '..'), process.argv[3]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
