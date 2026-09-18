import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/approval-first-import.js';

test('offline demo only simulates a save once and never prints synthetic credentials', async () => {
  const output = []; await run(['demo'], value => output.push(value));
  assert.equal(output[0].phase, 'discovery'); assert.equal(output[1].willWrite, false);
  assert.equal(output[2].value, 'in-memory-only'); assert.equal(output[2].savedCount, 1);
  assert.equal(output[3].duplicateConfirmation, 'consumed'); assert.equal(output[3].savedCount, 1);
  assert.equal(JSON.stringify(output).includes('synthetic-not-a-real-token'), false);
});

test('CLI reads local Skill and MCP fixtures into previews only', async () => {
  for (const name of ['skill', 'mcp-high-risk']) {
    const output = [];
    await run(['preview', fileURLToPath(new URL(`../examples/${name}.json`, import.meta.url))], value => output.push(value));
    assert.equal(output.length, 1); assert.equal(output[0].requiresConfirmation, true); assert.equal(output[0].willExecute, false);
    assert.equal(output[0].willWrite, false);
    assert.equal(JSON.stringify(output).includes('synthetic-secret-only'), false);
  }
});

test('CLI rejects implicit install/save commands', async () => {
  await assert.rejects(run(['install', 'some-package']), error => error.code === 'usage');
  await assert.rejects(run(['confirm']), error => error.code === 'usage');
});
