import { readFileSync, writeFileSync } from 'node:fs';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (request.task === 'health') { writeFileSync(process.argv[3], JSON.stringify({ ok: true })); process.exit(0); }
if (request.task !== 'asset-image') throw new Error('unknown task');
writeFileSync(process.argv[3], Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6e8AAAAASUVORK5CYII=', 'base64'));
