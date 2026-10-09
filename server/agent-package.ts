import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function bundledAgentDirectory(root=process.cwd()){
  return path.join(root,'dist-server','bundled','wanling-manju');
}
export function bundledVersion(root=process.cwd()):string{
  return JSON.parse(readFileSync(path.join(root,'dist-server','bundled','version.json'),'utf8')).version;
}
export function bundledTutorial(root=process.cwd()){
  return readFileSync(path.join(root,'dist-server','bundled','tutorials','getting-started.md'));
}

// Small ZIP store writer: packages a few text files without shell commands or
// dependencies. UTF-8 filenames and CRC32 are part of the ZIP contract.
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function agentSkillZip(client: string, root = process.cwd()) {
  if (!['codex', 'workbuddy', 'trae'].includes(client)) throw Error('客户端无效');
  const files: { name: string; data: Buffer }[] = [];
  const folder = bundledAgentDirectory(root);
  function visit(directory: string, prefix: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('技能包禁止符号链接');
      const file = path.join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) visit(file, name + '/');
      else if (entry.name !== 'installation.json') files.push({ name, data: readFileSync(file) });
    }
  }
  visit(folder, 'wanling-manju/');
  files.push({ name: 'wanling-manju/installation.json', data: Buffer.from(JSON.stringify({ root, client, version:bundledVersion(root) }, null, 2)) });
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), crc = crc32(file.data), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.data.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, file.data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(file.data.length, 20); directory.writeUInt32LE(file.data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); centralSize += directory.length + name.length; offset += header.length + name.length + file.data.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
