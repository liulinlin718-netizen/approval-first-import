import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ImportApprovalGate } from 'approval-first-import';

const scope = 'limits';
const skill = () => ({ kind: 'skill', name: 'Sample', source: { url: 'https://example.org/s', revision: 'v1' },
  destination: 'skills/sample', files: [{ path: 'SKILL.md', content: 'E' }] });
const confirm = (view, candidate) => ({ previewId: view.previewId, fingerprint: view.fingerprint, scope, confirmed: true, candidate });

test('redaction never scans its own placeholder again', () => {
  const candidate = skill(); candidate.env = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`VALUE_${index}`, 'E']));
  const view = new ImportApprovalGate().preview(candidate, { scope });
  assert.equal(view.candidate.files[0].content, '[REDACTED]');
  assert.ok(view.risk.findings.some(item => item.code === 'short-secret'));
});

test('overlapping original secret ranges merge without masking generated placeholders', () => {
  const candidate = skill(); candidate.env = { FIRST: 'abc', SECOND: 'cdef', THIRD: 'E' };
  candidate.files[0].content = 'abcdef E';
  const view = new ImportApprovalGate().preview(candidate, { scope });
  assert.equal(view.candidate.files[0].content, '[REDACTED] [REDACTED]');
});

test('oversized redacted fields and totals fail without consuming preview capacity', () => {
  const gate = new ImportApprovalGate({ maxEntries: 1 });
  for (const [count, repeats] of [[1, 30000], [5, 24000]]) {
    const candidate = skill(); candidate.env = { VALUE: 'E' };
    candidate.files = Array.from({ length: count }, (_, index) => ({ path: `part${index}.md`, content: 'E-'.repeat(repeats) }));
    assert.throws(() => gate.preview(candidate, { scope }), error => error.code === 'preview_too_large');
  }
  assert.doesNotThrow(() => gate.preview(skill(), { scope }));
});

test('large secret sets fail closed when their scan budget is exceeded', () => {
  const candidate = skill(); candidate.files = Array.from({ length: 3 }, (_, index) => ({ path: `part${index}.md`, content: 'x'.repeat(131072) }));
  candidate.env = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`KEY_${index}`, `synthetic-env-${index}`]));
  candidate.headers = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`KEY_${index}`, `synthetic-header-${index}`]));
  const gate = new ImportApprovalGate({ maxEntries: 1 });
  assert.throws(() => gate.preview(candidate, { scope }), error => error.code === 'preview_complexity');
  assert.doesNotThrow(() => gate.preview(skill(), { scope }));
});

test('excess overlapping matches fail closed instead of overflowing the range accumulator', () => {
  const candidate = skill(); candidate.env = { ONE: 'E', TWO: 'EE', THREE: 'EEE', FOUR: 'EEEE' };
  candidate.files = [0, 1].map(index => ({ path: `file${index}.md`, content: 'E'.repeat(131072) }));
  assert.throws(() => new ImportApprovalGate().preview(candidate, { scope }), error => error.code === 'preview_complexity');
});

test('short command-only credentials also warn when preview identity may be obscured', () => {
  const candidate = skill(); candidate.commands = [{ executable: 'node', args: ['--token', 'E'] }];
  const view = new ImportApprovalGate().preview(candidate, { scope });
  assert.equal(view.candidate.commands[0].args[1], '[REDACTED]');
  assert.ok(view.risk.findings.some(item => item.code === 'short-secret'));
});

test('capacity is checked before inspecting expensive or accessor-bearing candidate input', () => {
  const gate = new ImportApprovalGate({ maxEntries: 1 }); gate.preview(skill(), { scope });
  let touched = false; const candidate = { get name() { touched = true; return 'bad'; } };
  assert.throws(() => gate.preview(candidate, { scope }), error => error.code === 'capacity'); assert.equal(touched, false);
});

test('maximum text words, repeated command words and URL query segments finish within a subprocess resource bound', () => {
  const script = `import { ImportApprovalGate } from 'approval-first-import';
    const files = ['x'.repeat(131072), 'curl rm Remove-Item '.repeat(6000), 'https://example.org/?' + 'a&'.repeat(60000)]
      .map((content, index) => ({path: 'file' + index + '.md', content}));
    const result = new ImportApprovalGate().preview({kind:'skill', name:'Long input', source:{url:'https://example.org'}, destination:'skills/long', files}, {scope:'test'});
    if (result.candidate.files[0].content.length !== 131072) throw new Error('Truncated');`;
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 8192,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});

function large(total) {
  return { ...skill(), files: Array.from({ length: 4 }, (_, index) => ({ path: `file${index}.md`,
    content: ' '.repeat(Math.floor(total / 4) + (index < total % 4 ? 1 : 0)) })) };
}
test('the exact accepted candidate limit can be confirmed without counting the envelope twice', async () => {
  const candidate = large(524288 - Buffer.byteLength(JSON.stringify(large(0))));
  assert.equal(Buffer.byteLength(JSON.stringify(candidate)), 524288);
  const gate = new ImportApprovalGate(), view = gate.preview(candidate, { scope });
  let saves = 0; await gate.confirmAndSave(confirm(view, candidate), () => saves++);
  assert.equal(saves, 1);
});

test('encoded byte boundaries account for Unicode and JSON escaping independently of the confirmation scope', async () => {
  const wideScope = '\u754c'.repeat(160);
  for (const delta of [-1, 0, 1]) {
    const candidate = large(0);
    candidate.files[0].content = '\u4e2d\u6587\\\"\n'.repeat(3000);
    let remaining = 524288 + delta - Buffer.byteLength(JSON.stringify(candidate));
    for (let index = 0; index < 4; index++) {
      const add = Math.min(remaining, 131072 - Buffer.byteLength(candidate.files[index].content));
      candidate.files[index].content += ' '.repeat(add); remaining -= add;
    }
    assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(candidate)), 524288 + delta);
    const gate = new ImportApprovalGate();
    if (delta > 0) { assert.throws(() => gate.preview(candidate, { scope: wideScope }), error => error.code === 'invalid_input'); continue; }
    const view = gate.preview(candidate, { scope: wideScope });
    const saved = await gate.confirmAndSave({ ...confirm(view, candidate), scope: wideScope }, () => 'ok');
    assert.equal(saved.value, 'ok');
  }
});

test('confirmation metadata rejects hidden, unknown, non-JSON and accessor fields without consuming a valid preview', async () => {
  const candidate = skill(), gate = new ImportApprovalGate(), view = gate.preview(candidate, { scope }); let invoked = 0;
  for (const change of [value => { value.extra = true; }, value => { value.acknowledgeHighRisk = {}; },
    value => { Object.defineProperty(value, 'scope', { get() { invoked++; return scope; } }); },
    value => { Object.defineProperty(value, 'confirmed', { value: true, enumerable: false }); }]) {
    const body = confirm(view, candidate); change(body);
    await assert.rejects(gate.confirmAndSave(body, () => assert.fail('must not save')), error => error.code === 'invalid_input');
  }
  assert.equal(invoked, 0); assert.equal(gate.status(view.previewId, { scope }), 'pending');
});

test('file-directory prefix conflicts are rejected before an approval is created', () => {
  for (const paths of [['assets', 'assets/child.md'], ['assets/child.md', 'assets'], ['Assets', 'assets/child.md'], ['caf\u00e9', 'cafe\u0301/file.md']]) {
    const candidate = skill(); candidate.files = paths.map(path => ({ path, content: 'test' }));
    assert.throws(() => new ImportApprovalGate().preview(candidate, { scope }), error => error.code === 'path_conflict');
  }
  const candidate = skill(); candidate.files = ['a', 'ab/c.md', 'assets.md', 'assets/file.md'].map(path => ({ path, content: '' }));
  assert.doesNotThrow(() => new ImportApprovalGate().preview(candidate, { scope }));
});
