import sharp from 'sharp';
import assert from 'node:assert/strict';

assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Node.js 24 is required');
const output = await sharp({create: {width: 2, height: 2, channels: 3, background: '#ffffff'}}).png().toBuffer();
assert.ok(output.length > 0);
assert.equal(sharp.versions.sharp, '0.35.5', 'Locked sharp version is required');
console.log('图片运行环境已就绪。');
