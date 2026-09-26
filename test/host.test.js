import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileConfigStore } from '../examples/host-store.js';
import { ImportHost } from '../examples/host-adapter.js';

const input = () => ({ kind: 'skill', name: 'Example', source: { url: 'https://example.org/s', revision: 'v1' },
  destination: 'skills/example', env: { EXAMPLE_TOKEN: 'synthetic-private-token' }, files: [{ path: 'SKILL.md', content: 'Example instructions' }] });
const consent = view => ({ previewId: view.previewId, fingerprint: view.fingerprint, confirmed: true });
const code = expected => error => error.code === expected;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, gateOptions) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.host-test-', import.meta.url)));
  const store = await FileConfigStore.open(directory);
  const alice = {}, bob = {}, otherWorkspace = {};
  const sessions = new WeakMap([[alice, { userId: 'alice', workspaceId: 'office' }], [bob, { userId: 'bob', workspaceId: 'office' }],
    [otherWorkspace, { userId: 'alice', workspaceId: 'other' }]]);
  const authenticate = context => sessions.get(context), host = new ImportHost({ store, authenticate, gateOptions });
  t.after(async () => { host.close(); await unlink(join(directory, 'state.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }); await rmdir(directory); });
  return { directory, store, host, authenticate, alice, bob, otherWorkspace };
}

test('host authentication defaults to deny; caller identity fields are not credentials', async t => {
  const { store, host } = await fixture(t), closed = new ImportHost({ store });
  await assert.rejects(closed.prepare({}, input()), code('unauthorized'));
  await assert.rejects(host.prepare({ userId: 'alice', workspaceId: 'office', confirmed: true }, input()), code('unauthorized'));
});

test('raw drafts remain in the host, and different users/workspaces cannot approve or read receipts', async t => {
  const { host, alice, bob, otherWorkspace } = await fixture(t);
  const candidate = input(), { preview } = await host.prepare(alice, candidate);
  assert.equal(JSON.stringify(preview).includes(candidate.env.EXAMPLE_TOKEN), false);
  assert.equal(preview.willWrite, false); assert.equal(preview.willExecute, false);
  for (const session of [bob, otherWorkspace]) {
    await assert.rejects(host.confirm(session, consent(preview)), code('not_found'));
    assert.equal(await host.receipt(session, preview.previewId), null);
  }
  await assert.rejects(host.confirm(alice, { ...consent(preview), candidate: preview.candidate }), code('invalid_input'));
  candidate.env.EXAMPLE_TOKEN = 'mutated-outside-host';
  const saved = await host.confirm(alice, consent(preview)); assert.equal(saved.value.version, 1);
  assert.equal(await host.receipt(bob, preview.previewId), null);
});

test('duplicate confirmations return the saved receipt without another write or audit', async t => {
  const { host, store, alice, directory } = await fixture(t);
  const { preview } = await host.prepare(alice, input());
  const first = await host.confirm(alice, consent(preview));
  assert.deepEqual(await host.confirm(alice, consent(preview)), first);
  assert.equal(store.version('office', input().destination), 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).decisions.length, 1);
  await assert.rejects(host.confirm(alice, { ...consent(preview), fingerprint: '0'.repeat(64) }), code('content_changed'));
});

test('response loss can be recovered from an atomic receipt after a store restart', async t => {
  const { host, alice, directory, authenticate } = await fixture(t);
  const { preview } = await host.prepare(alice, input());
  await host.confirm(alice, consent(preview)); // Discard the simulated HTTP response.
  host.close();
  const restarted = new ImportHost({ store: await FileConfigStore.open(directory), authenticate });
  const receipt = await restarted.receipt(alice, preview.previewId);
  assert.equal(receipt.status, 'saved'); assert.equal(receipt.value.version, 1);
  assert.deepEqual(await restarted.confirm(alice, consent(preview)), receipt);
  restarted.close();
});

test('competing previews use an atomic target-version check; fresh approval is required after conflict', async t => {
  const { host, store, alice, bob } = await fixture(t);
  const first = await host.prepare(alice, input()), second = await host.prepare(bob, input());
  assert.equal(first.targetVersion, 0); assert.equal(second.targetVersion, 0);
  const results = await Promise.allSettled([host.confirm(alice, consent(first.preview)), host.confirm(bob, consent(second.preview))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'version_conflict');
  assert.equal(store.version('office', input().destination), 1);
  const fresh = await host.prepare(alice, input()); assert.equal(fresh.targetVersion, 1);
  await assert.rejects(host.confirm(alice, { ...consent(fresh.preview), confirmed: false }), code('confirmation_required'));
  assert.equal((await host.confirm(alice, consent(fresh.preview))).value.version, 2);
});

test('an unknown save response is recovered by receipt query, not callback replay', { timeout: 5000 }, async t => {
  const { host, store, alice } = await fixture(t, { saveTimeoutMs: 100 });
  const committed = deferred(), response = deferred(), original = store.save.bind(store); let writes = 0;
  store.save = async (...args) => {
    writes++; const value = await original(...args); committed.resolve(); await response.promise; return value;
  };
  const { preview } = await host.prepare(alice, input());
  const pending = assert.rejects(host.confirm(alice, consent(preview)), code('save_unknown'));
  await committed.promise; await pending;
  const receipt = await host.receipt(alice, preview.previewId); assert.equal(receipt.value.version, 1);
  assert.deepEqual(await host.confirm(alice, consent(preview)), receipt); assert.equal(writes, 1);
  response.resolve();
});

test('host audit failures deny writes, and high-risk imports still need independent acknowledgement', async t => {
  const { host, store, alice } = await fixture(t);
  const candidate = input(); candidate.commands = [{ executable: 'bash', args: ['-c', 'echo test'] }];
  const { preview } = await host.prepare(alice, candidate);
  await assert.rejects(host.confirm(alice, consent(preview)), code('risk_acknowledgement_required'));
  store.audit = () => { throw new Error('synthetic private audit failure'); };
  await assert.rejects(host.confirm(alice, { ...consent(preview), acknowledgeHighRisk: true }), code('record_failed'));
  assert.equal(store.version('office', candidate.destination), 0);
});
