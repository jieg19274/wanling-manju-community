import {appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const kind = request.task === 'asset-image' ? 'image' : request.prompt && request.durationSec && !request.task ? 'video' : 'text';
const key = request.key || request.asset?.name || request.beats?.[0]?.id || request.projectId;
const event = value => appendFileSync(process.env.MANJU_TEST_CONCURRENCY_EVENTS,
  JSON.stringify({event: value, kind, key, time: Date.now()}) + '\n');
const gate = path.join(process.env.MANJU_TEST_CONCURRENCY_RELEASE_DIR, `${kind}.${encodeURIComponent(key)}`);

event('start');
try {
  const deadline = Date.now() + 45000;
  while (!existsSync(gate)) {
    if (Date.now() > deadline) throw new Error(`Fixture release timed out: ${kind}/${key}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (kind === 'image') {
    await sharp({create: {width: 128, height: 64, channels: 3, background: '#304050'}}).png().toFile(process.argv[3]);
  } else if (kind === 'video') {
    copyFileSync(process.env.MANJU_TEST_CONCURRENCY_CLIP, process.argv[3]);
  } else {
    if (key === 'text-fail') throw new Error('Intentional text fixture failure');
    const result = request.task === 'semantic-review' ? {
      entries: request.beats.map(beat => ({beatId: beat.id, sourceStart: 0, sourceEnd: request.sourceText.length,
        notes: 'mock完整原文依据须由人工逐项确认', highlightIds: request.highlights.map(highlight => highlight.id)})), warnings: [],
    } : {key};
    writeFileSync(process.argv[3], JSON.stringify(result));
  }
} finally { event('end'); }
