import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openBudget } from '../adapters/batch-budget.mjs';
import { approvedUnknownRetry, approvedAudioTrial } from '../dist-server/server/unknown-retry.js';

test('release rejects private budget profiles before reading files or inheriting paid grants', () => {
  assert.equal(openBudget({projectId: 'mock'}, undefined), undefined);
  assert.throws(() => openBudget({projectId: 'mock'}, 'nonexistent-producer-profile.json'), /does not accept/);
  const before = process.env.MANJU_BATCH_BUDGET_PROFILE;
  process.env.MANJU_BATCH_BUDGET_PROFILE = 'nonexistent-producer-profile.json';
  try { assert.throws(() => openBudget({projectId: 'mock'}), /does not accept/); }
  finally { if (before === undefined) delete process.env.MANJU_BATCH_BUDGET_PROFILE; else process.env.MANJU_BATCH_BUDGET_PROFILE = before; }
  assert.equal(fs.existsSync('nonexistent-producer-profile.json'), false);
});

test('another installation cannot inherit exceptional retry and audio trial grants', () => {
  assert.equal(approvedUnknownRetry('project', 'asset', 'batch', 'grant', ['remote-unknown']), false);
  assert.equal(approvedUnknownRetry('project', 'asset', 'batch', undefined, []), false);
  assert.equal(approvedAudioTrial('project', 'segment', 'model', 'batch'), false);
  assert.equal(approvedAudioTrial('project', 'segment', 'model'), false);
  for (const file of ['adapters/remaining-budget.mjs', 'adapters/tutorial-budget.mjs', 'scripts/deploy-update-relay.remote.py']) {
    assert.equal(fs.existsSync(path.resolve(file)), false, file);
  }
});
