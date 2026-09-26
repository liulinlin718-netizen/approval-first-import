import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ImportApprovalGate } from 'approval-first-import';

const scope = 'timeouts';
const input = () => ({ kind: 'skill', name: 'Sample', source: { url: 'https://example.org/s' }, destination: 'skills/sample' });
const request = (view, candidate) => ({ previewId: view.previewId, fingerprint: view.fingerprint, scope, confirmed: true, candidate });
const code = expected => error => error.code === expected;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a hung audit times out, signals cancellation, frees capacity and cannot save later', { timeout: 2000 }, async () => {
  const lock = deferred(); let saves = 0, auditSignal;
  const gate = new ImportApprovalGate({ ttlMs: 1000, maxEntries: 1, recordTimeoutMs: 20,
    recordDecision: (_decision, context) => { auditSignal = context.signal; return lock.promise; } });
  const candidate = input(), view = gate.preview(candidate, { scope });
  await assert.rejects(gate.confirmAndSave(request(view, candidate), () => saves++), code('record_timeout'));
  assert.equal(auditSignal.aborted, true); assert.equal(gate.status(view.previewId, { scope }), 'failed');
  assert.doesNotThrow(() => gate.preview(input(), { scope }));
  lock.resolve(); await tick(); assert.equal(saves, 0);
});

test('TTL bounds a hung audit even without polling or a moving injected clock', { timeout: 2000 }, async () => {
  let saves = 0;
  const gate = new ImportApprovalGate({ now: () => 1000, ttlMs: 30, recordTimeoutMs: 1000,
    recordDecision: () => new Promise(() => {}) });
  const candidate = input(), view = gate.preview(candidate, { scope });
  await assert.rejects(gate.confirmAndSave(request(view, candidate), () => saves++), code('expired'));
  assert.equal(gate.status(view.previewId, { scope }), 'expired'); assert.equal(saves, 0);
});

test('logical expiry while confirming also cancels the wait and releases capacity', async () => {
  let now = 1000, saves = 0;
  const gate = new ImportApprovalGate({ now: () => now, ttlMs: 1000, maxEntries: 1,
    recordDecision: () => new Promise(() => {}) });
  const candidate = input(), view = gate.preview(candidate, { scope });
  const pending = assert.rejects(gate.confirmAndSave(request(view, candidate), () => saves++), code('expired'));
  now = 2000; gate.preview(input(), { scope }); await pending; assert.equal(saves, 0);
});

test('caller abort and revoke settle hung audits without allowing a late save', async t => {
  for (const action of ['abort', 'revoke']) await t.test(action, async () => {
    const lock = deferred(), controller = new AbortController(); let saves = 0;
    const gate = new ImportApprovalGate({ recordDecision: () => lock.promise });
    const candidate = input(), view = gate.preview(candidate, { scope });
    const pending = assert.rejects(gate.confirmAndSave(request(view, candidate), () => saves++, { signal: controller.signal }),
      code(action === 'abort' ? 'cancelled' : 'revoked'));
    if (action === 'abort') controller.abort('private reason'); else gate.revoke(view.previewId, { scope });
    await pending; lock.reject(new Error('late private audit failure')); await tick();
    assert.equal(saves, 0); assert.equal(gate.status(view.previewId, { scope }), 'revoked');
  });
});

test('save timeout or abort is an unknown write outcome, not a fresh approval', { timeout: 2000 }, async t => {
  for (const action of ['timeout', 'abort']) await t.test(action, async () => {
    const lock = deferred(), controller = new AbortController(); let saves = 0, saveSignal;
    const gate = new ImportApprovalGate({ saveTimeoutMs: 20, maxEntries: 1 });
    const candidate = input(), view = gate.preview(candidate, { scope });
    const pending = assert.rejects(gate.confirmAndSave(request(view, candidate), (_data, _decision, context) => {
      saves++; saveSignal = context.signal; return lock.promise;
    }, { signal: controller.signal }), code('save_unknown'));
    if (action === 'abort') controller.abort();
    await pending; assert.equal(saveSignal.aborted, true);
    assert.equal(gate.status(view.previewId, { scope }), 'save_unknown');
    await assert.rejects(gate.confirmAndSave(request(view, candidate), () => saves++), code('consumed'));
    lock.resolve('late receipt'); await tick();
    assert.equal(gate.status(view.previewId, { scope }), 'save_unknown'); assert.equal(saves, 1);
    assert.doesNotThrow(() => gate.preview(input(), { scope }));
  });
});

test('already cancelled requests never call either hook', async () => {
  const controller = new AbortController(); controller.abort();
  const gate = new ImportApprovalGate({ recordDecision: () => assert.fail('audit must not start') });
  const candidate = input(), view = gate.preview(candidate, { scope });
  await assert.rejects(gate.confirmAndSave(request(view, candidate), () => assert.fail('save must not start'),
    { signal: controller.signal }), code('cancelled'));
});

test('completed callbacks remove abort listeners; later abort does not change saved status', async () => {
  const controller = new AbortController(), gate = new ImportApprovalGate({ recordDecision: () => {} });
  const candidate = input(), view = gate.preview(candidate, { scope }); let callbackSignal;
  await gate.confirmAndSave(request(view, candidate), (_data, _decision, context) => { callbackSignal = context.signal; }, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(); await tick();
  assert.equal(callbackSignal.aborted, false); assert.equal(gate.status(view.previewId, { scope }), 'saved');
});

test('timeout options reject invalid values', () => {
  for (const name of ['recordTimeoutMs', 'saveTimeoutMs']) for (const value of [0, -1, 1.5, Infinity, 3600001])
    assert.throws(() => new ImportApprovalGate({ [name]: value }), code('invalid_options'));
});
