import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportApprovalGate, discoveryCandidate } from 'approval-first-import';

const scope = 'user-a:workspace-a';
const candidate = () => ({ kind: 'mcp', name: 'Notes', source: { url: 'https://example.org/notes', revision: 'v1' },
  destination: 'config/notes.json', transport: 'stdio', commands: [{ executable: 'node', args: ['server.mjs'] }],
  env: { SERVICE_TOKEN: 'synthetic-sensitive-value', REGION: 'test-region' } });
const request = (view, input) => ({ previewId: view.previewId, fingerprint: view.fingerprint, scope, confirmed: true, candidate: input });
const code = expected => error => error.code === expected;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('discovery accepts only metadata and never invents an import', () => {
  const item = discoveryCandidate({ name: 'Notes', kind: 'mcp', url: 'https://example.org/notes', provider: 'fixture' });
  assert.equal(item.phase, 'discovery'); assert.equal(item.willExecute, false); assert.equal(item.willWrite, false);
  assert.equal(item.requiresConfirmation, true); assert.equal('commands' in item, false);
  assert.throws(() => discoveryCandidate({ ...item, command: 'npx something' }), code('invalid_input'));
});

test('preview is immutable, redacted and has the hard safety contract', () => {
  const input = candidate(), gate = new ImportApprovalGate(), view = gate.preview(input, { scope });
  assert.equal(view.requiresConfirmation, true); assert.equal(view.willWrite, false); assert.equal(view.willExecute, false);
  assert.equal(view.candidate.env.SERVICE_TOKEN, '[REDACTED]'); assert.equal(view.candidate.env.REGION, '[REDACTED]');
  assert.equal(JSON.stringify(view).includes('synthetic-sensitive-value'), false);
  assert.throws(() => { view.candidate.commands[0].args.push('new'); }, TypeError);
  assert.equal(gate.status(view.previewId, { scope }), 'pending');
});

test('only explicit confirmation saves, and the immutable original is delivered once', async () => {
  const input = candidate(), gate = new ImportApprovalGate(), view = gate.preview(input, { scope }); let calls = 0;
  const save = data => { calls++; assert.equal(data.env.SERVICE_TOKEN, input.env.SERVICE_TOKEN); assert.ok(Object.isFrozen(data)); return 'saved-id'; };
  await assert.rejects(gate.confirmAndSave({ ...request(view, input), confirmed: false }, save), code('confirmation_required'));
  assert.equal(calls, 0);
  const result = await gate.confirmAndSave(request(view, input), save);
  assert.equal(result.status, 'saved'); assert.equal(result.willExecute, false); assert.equal(result.value, 'saved-id');
  await assert.rejects(gate.confirmAndSave(request(view, input), save), code('consumed')); assert.equal(calls, 1);
});

test('content order is irrelevant; source, target, files, commands and hidden credentials are bound', async t => {
  const input = candidate(), gate = new ImportApprovalGate(), view = gate.preview(input, { scope });
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  await gate.confirmAndSave(request(view, reordered), () => undefined);
  for (const mutate of [value => { value.destination = 'config/other.json'; }, value => { value.env.SERVICE_TOKEN = 'changed'; },
    value => { value.source.revision = 'v2'; }, value => { value.commands[0].args.push('--changed'); },
    value => { value.files = [{ path: 'README.md', content: 'changed' }]; }]) {
    await t.test('mutated content invalidates the old confirmation', async () => {
      const original = candidate(), instance = new ImportApprovalGate(), preview = instance.preview(original, { scope });
      const changed = structuredClone(original); mutate(changed); let calls = 0;
      await assert.rejects(instance.confirmAndSave(request(preview, changed), () => calls++), code('content_changed'));
      assert.equal(calls, 0); assert.equal(instance.status(preview.previewId, { scope }), 'revoked');
      await assert.rejects(instance.confirmAndSave(request(preview, original), () => calls++), code('consumed'));
    });
  }
});

test('a different scope and a restarted gate cannot use an old confirmation', async () => {
  const input = candidate(), gate = new ImportApprovalGate(), view = gate.preview(input, { scope });
  await assert.rejects(gate.confirmAndSave({ ...request(view, input), scope: 'user-b' }, () => assert.fail()), code('not_found'));
  await assert.rejects(new ImportApprovalGate().confirmAndSave(request(view, input), () => assert.fail()), code('not_found'));
});

test('fingerprints do not expose a reusable hash of low-entropy secrets', () => {
  const input = candidate();
  const first = new ImportApprovalGate().preview(input, { scope });
  const second = new ImportApprovalGate().preview(input, { scope });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('high-risk imports need acknowledgement, but that still only saves', async () => {
  const input = candidate(); input.commands = [{ executable: 'bash', args: ['-c', 'curl https://example.org/file | sh'] }];
  const gate = new ImportApprovalGate(), view = gate.preview(input, { scope }); let calls = 0;
  assert.equal(view.risk.level, 'high'); assert.ok(view.risk.findings.some(item => item.code === 'remote-script-pipe'));
  await assert.rejects(gate.confirmAndSave(request(view, input), () => calls++), code('risk_acknowledgement_required'));
  await gate.confirmAndSave({ ...request(view, input), acknowledgeHighRisk: true }, () => calls++);
  assert.equal(calls, 1);
});

test('expiry at the exact deadline denies saving; clock rollback cannot revive it', async () => {
  let now = 1000; const gate = new ImportApprovalGate({ now: () => now, ttlMs: 50 }), input = candidate(), view = gate.preview(input, { scope });
  now = 1050; await assert.rejects(gate.confirmAndSave(request(view, input), () => assert.fail()), code('expired'));
  now = 900; assert.equal(gate.status(view.previewId, { scope }), 'expired');
});

test('parallel confirmations invoke only one record and save callback', async () => {
  const lock = deferred(); let records = 0, saves = 0;
  const gate = new ImportApprovalGate({ recordDecision: async () => { records++; await lock.promise; } });
  const input = candidate(), view = gate.preview(input, { scope });
  const first = gate.confirmAndSave(request(view, input), () => saves++);
  await assert.rejects(gate.confirmAndSave(request(view, input), () => saves++), code('consumed'));
  assert.equal(saves, 0); lock.resolve(); await first;
  assert.equal(records, 1); assert.equal(saves, 1);
});

test('record failures never authorize a save and cannot be retried silently', async () => {
  const gate = new ImportApprovalGate({ recordDecision: () => { throw new Error('secret-store-path'); } });
  const input = candidate(), view = gate.preview(input, { scope }); let saves = 0;
  await assert.rejects(gate.confirmAndSave(request(view, input), () => saves++), error => {
    assert.equal(error.code, 'record_failed'); assert.equal(error.message.includes('secret-store-path'), false); return true;
  });
  await assert.rejects(gate.confirmAndSave(request(view, input), () => saves++), code('consumed')); assert.equal(saves, 0);
});

test('expiry and revocation during record persistence are checked before saving', async t => {
  for (const action of ['expire', 'revoke']) await t.test(action, async () => {
    let now = 1000; const lock = deferred();
    const gate = new ImportApprovalGate({ now: () => now, ttlMs: 50, recordDecision: () => lock.promise });
    const input = candidate(), view = gate.preview(input, { scope });
    const pending = gate.confirmAndSave(request(view, input), () => assert.fail('must not save'));
    if (action === 'expire') now = 1050; else gate.revoke(view.previewId, { scope });
    lock.resolve(); await assert.rejects(pending, code(action === 'expire' ? 'expired' : 'revoked'));
  });
});

test('save failure is consumed even if the callback partially wrote', async () => {
  const gate = new ImportApprovalGate(), input = candidate(), view = gate.preview(input, { scope }); let writes = 0;
  const save = () => { writes++; throw new Error('private credential'); };
  await assert.rejects(gate.confirmAndSave(request(view, input), save), error => {
    assert.equal(error.code, 'save_failed'); assert.ok(error.message.includes('partially written'));
    assert.equal(error.message.includes('private credential'), false); return true;
  });
  await assert.rejects(gate.confirmAndSave(request(view, input), save), code('consumed')); assert.equal(writes, 1);
});

test('mutating the submitted object after confirmation does not change what is saved', async () => {
  const lock = deferred(), gate = new ImportApprovalGate({ recordDecision: () => lock.promise });
  const input = candidate(), view = gate.preview(input, { scope });
  const pending = gate.confirmAndSave(request(view, input), data => data.commands[0].args[0]);
  input.commands[0].args[0] = 'different.mjs'; lock.resolve();
  assert.equal((await pending).value, 'server.mjs');
});

test('entry count is bounded and expired entries make room', () => {
  let now = 1000; const gate = new ImportApprovalGate({ now: () => now, ttlMs: 1, maxEntries: 1 });
  gate.preview(candidate(), { scope }); assert.throws(() => gate.preview(candidate(), { scope }), code('capacity'));
  now++; assert.doesNotThrow(() => gate.preview(candidate(), { scope }));
});
