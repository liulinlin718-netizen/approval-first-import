import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportApprovalGate, discoveryCandidate } from '../src/index.js';

const scope = 'validation';
const candidate = () => ({ kind: 'skill', name: 'Handoff', source: { url: 'https://example.org/skill', revision: 'v1' },
  destination: 'skills/handoff', files: [{ path: 'SKILL.md', content: 'Produce a handoff.' }] });
const preview = value => new ImportApprovalGate().preview(value, { scope });
const invalid = error => error.code === 'invalid_input';

test('common multi-file skills have complete, untruncated text previews', () => {
  const input = candidate(); input.files.push({ path: 'templates/report.md', content: '## Summary\n## Sources' });
  const view = preview(input);
  assert.equal(view.candidate.files.length, 2); assert.equal(view.candidate.files[1].content, input.files[1].content);
  assert.equal(view.risk.findings.some(item => item.code === 'command-declared'), false);
});

test('path traversal, Windows devices, absolutes and case collisions are rejected', () => {
  for (const path of ['../escape', 'a/../b', '/absolute', 'C:/private', 'a\\b', 'a//b', 'a/./b', 'a.', 'CON', 'x/aux.txt']) {
    const input = candidate(); input.files[0].path = path; assert.throws(() => preview(input), invalid, path);
    input.files[0].path = 'SKILL.md'; input.destination = path; assert.throws(() => preview(input), invalid, path);
  }
  const input = candidate(); input.files.push({ path: 'skill.md', content: 'duplicate' });
  assert.throws(() => preview(input), invalid);
});

test('non-JSON data, accessors, cycles, prototype keys and sparse arrays fail without invoking getters', () => {
  const getter = candidate(); let calls = 0;
  Object.defineProperty(getter, 'hidden', { get() { calls++; return 'secret'; }, enumerable: true });
  assert.throws(() => preview(getter), invalid); assert.equal(calls, 0);
  const cyclic = candidate(); cyclic.self = cyclic; assert.throws(() => preview(cyclic), invalid);
  assert.throws(() => preview({ ...candidate(), extra: new Date() }), invalid);
  assert.throws(() => preview({ ...candidate(), extra: NaN }), invalid);
  assert.throws(() => preview({ ...candidate(), extra: undefined }), invalid);
  assert.throws(() => preview(JSON.parse('{"__proto__":{"polluted":true}}')), invalid);
  const sparse = candidate(); sparse.files = Array(2); sparse.files[1] = { path: 'a', content: '' };
  assert.throws(() => preview(sparse), invalid); assert.equal({}.polluted, undefined);
});

test('size, file count and nesting limits fail before approval', () => {
  const input = candidate(); input.files[0].content = 'x'.repeat(131073); assert.throws(() => preview(input), invalid);
  input.files = Array.from({ length: 65 }, (_, index) => ({ path: `${index}.md`, content: '' })); assert.throws(() => preview(input), invalid);
  input.files = Array.from({ length: 5 }, (_, index) => ({ path: `${index}.md`, content: 'x'.repeat(131072) })); assert.throws(() => preview(input), invalid);
  let deep = {}; for (let index = 0; index < 20; index++) deep = { nested: deep };
  assert.throws(() => preview({ ...candidate(), extra: deep }), invalid);
});

test('source schemes and embedded URL credentials are rejected without fetching anything', () => {
  for (const url of ['javascript:alert(1)', 'file:///private', 'https://user:pass@example.org/file', 'not-a-url']) {
    const input = candidate(); input.source.url = url; assert.throws(() => preview(input), invalid);
  }
  // This is not a network client or SSRF guard; local URLs may still be reviewed offline.
  const input = candidate(); input.source.url = 'http://127.0.0.1/notes';
  assert.ok(preview(input).risk.findings.some(item => item.code === 'plaintext-http'));
});

test('MCP HTTP endpoint, headers and query values are redacted without constructing a command', () => {
  const input = { kind: 'mcp', name: 'HTTP fixture', source: { url: 'https://example.org/registry?access=source-secret' },
    destination: 'config/http.json', transport: 'http', endpoint: 'https://example.org/mcp?key=url-secret', headers: { Authorization: 'Bearer header-secret' } };
  const view = preview(input), output = JSON.stringify(view);
  for (const secret of ['source-secret', 'url-secret', 'header-secret']) assert.equal(output.includes(secret), false);
  assert.deepEqual(view.candidate.commands, []); assert.equal(view.candidate.headers.Authorization, '[REDACTED]');
  assert.throws(() => preview({ ...input, commands: [{ executable: 'node', args: ['app.js'] }] }), invalid);
  assert.throws(() => preview({ ...input, transport: 'stdio' }), invalid);
});

test('known secrets, secret flags, inline assignments, bearer values and credential files stay out of preview', () => {
  const input = candidate();
  input.env = { SERVICE_TOKEN: 'env-secret-value', EMPTY: '', MISSING: null };
  input.commands = [{ executable: 'node', args: ['script.js', '--token', 'flag-secret-value', '--password=flag-password-value', 'https://example.org/?q=query-secret'] }];
  input.files = [
    { path: 'SKILL.md', content: 'env-secret-value\npassword: inline-secret\nAuthorization: Bearer bearer-secret\nflag-secret-value' },
    { path: '.env.local', content: 'UNKNOWN_NAME=env-file-secret' },
    { path: 'key.pem', content: '-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----' },
  ];
  const view = preview(input), output = JSON.stringify(view);
  for (const secret of ['env-secret-value', 'flag-secret-value', 'flag-password-value', 'query-secret', 'inline-secret', 'bearer-secret', 'env-file-secret', 'private-key-secret'])
    assert.equal(output.includes(secret), false, secret);
  assert.equal(view.candidate.env.EMPTY, '[REQUIRED]'); assert.equal(view.candidate.env.MISSING, '[REQUIRED]');
  assert.equal(view.risk.level, 'high');
});

test('lifecycle and destructive command warnings are visible, without any executable actions', () => {
  const input = candidate(); input.files.push({ path: 'package.json', content: '{"scripts":{"postinstall":"rm -rf ./cache"}}' });
  const view = preview(input);
  for (const code of ['lifecycle-script', 'destructive-command']) assert.ok(view.risk.findings.some(item => item.code === code));
  assert.equal(view.willExecute, false); assert.equal(view.risk.level, 'high');
});

test('metadata URLs hide query values and terminal escape sequences', () => {
  const value = discoveryCandidate({ name: 'Notes\u202e', kind: 'skill', provider: 'fixture', url: 'https://example.org/?key=secret-example' });
  assert.equal(JSON.stringify(value).includes('secret-example'), false); assert.equal(value.name.includes('\u202e'), false);
});

test('approval request accessors cannot synthesize confirmation', async () => {
  const gate = new ImportApprovalGate(), input = candidate(), view = gate.preview(input, { scope }); let gets = 0;
  const request = { previewId: view.previewId, fingerprint: view.fingerprint, scope, candidate: input };
  Object.defineProperty(request, 'confirmed', { enumerable: true, get() { gets++; return true; } });
  await assert.rejects(gate.confirmAndSave(request, () => assert.fail()), invalid); assert.equal(gets, 0);
});
