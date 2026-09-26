import { freeze, jsonCopy, sourceUrl, text, fail } from './input.js';
import { REDACTED, sensitive, createRedactor, assertPreviewSize } from './redaction.js';

/** No fetch, draft, command construction or filesystem access happens here. */
export function discoveryCandidate(input) {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['name', 'kind', 'url', 'provider'].includes(key))
    || !text(value.name, 120) || !['skill', 'mcp'].includes(value.kind) || !text(value.provider, 80))
    fail('invalid_input', 'Discovery accepts metadata only.');
  const clean = createRedactor();
  return freeze({ kind: value.kind, name: clean(value.name), provider: clean(value.provider),
    url: clean(sourceUrl(value.url)), phase: 'discovery', requiresConfirmation: true, willWrite: false, willExecute: false });
}

function credentialValues(candidate) {
  const values = [...Object.values(candidate.env), ...Object.values(candidate.headers)];
  for (const command of candidate.commands) for (let index = 0; index < command.args.length; index++) {
    const arg = command.args[index];
    if (/^--?/.test(arg) && sensitive.test(arg.split('=')[0]))
      values.push(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : command.args[index + 1]);
  }
  return [...new Set(values.filter(value => typeof value === 'string' && value))];
}

export function riskFor(candidate) {
  const findings = [];
  const add = (code, level, message) => { if (!findings.some(item => item.code === code)) findings.push({ code, level, message }); };
  add('external-content', 'medium', 'Source authenticity and package behavior have not been verified.');
  if (!candidate.source.revision) add('mutable-source', 'medium', 'No immutable version/commit was supplied; the host must pin downloaded content.');
  if (candidate.commands.length) add('command-declared', 'medium', 'Commands are descriptions only. Running them requires a separate policy and authorization.');
  if (Object.keys(candidate.env).length || Object.keys(candidate.headers).length) add('credentials', 'medium', 'Environment and header values are hidden. Review names and use your own credentials.');
  if (credentialValues(candidate).some(value => value.length < 4))
    add('short-secret', 'medium', 'Short hidden values may also obscure source, command or file text. Review the trusted draft locally; do not infer missing text.');
  const content = [...candidate.files.map(file => file.content), ...candidate.commands.map(command => [command.executable, ...command.args].join(' '))].join('\n');
  // Inspect each line once; repeated command words must not trigger quadratic suffix scans.
  for (const line of content.split(/[\r\n]/)) {
    const download = line.search(/\b(?:curl|wget)\b/i), remove = line.search(/\brm\s/i), powershell = line.search(/Remove-Item/i);
    if (download !== -1 && /\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i.test(line.slice(download)))
      add('remote-script-pipe', 'high', 'Remote content appears to be piped into a shell.');
    if ((remove !== -1 && /-[a-z]*[rf]/i.test(line.slice(remove)))
      || (powershell !== -1 && /-Recurse/i.test(line.slice(powershell)))
      || /\b(?:del\s+\/[sq]|rmdir\s+\/s)|\bformat\s+[a-z]:/i.test(line))
      add('destructive-command', 'high', 'A potentially destructive command was detected.');
  }
  if (/\b(?:sudo|runas)\b|chmod\s+\+x/i.test(content)) add('privilege-change', 'high', 'Privilege or executable-permission changes need additional review.');
  if (/\b(?:postinstall|preinstall|prepare)\b\s*["']?\s*:/i.test(content)) add('lifecycle-script', 'high', 'Package lifecycle scripts may execute during installation.');
  if (candidate.commands.some(command => /(?:^|[\\/])(?:bash|sh|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i.test(command.executable)
    || command.args.some(arg => /^(?:-c|-command|-encodedcommand|\/c)$/i.test(arg))))
    add('shell-or-code', 'high', 'A shell or inline-code invocation is present. It is never executed by this library.');
  if (candidate.files.some(file => /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|credentials(?:\..*)?)$/i.test(file.path)
    || /-----BEGIN [\w ]*PRIVATE KEY-----/.test(file.content)))
    add('sensitive-file', 'high', 'A credential-like file was detected and hidden from the preview.');
  if (candidate.files.some(file => /\.(?:sh|ps1|cmd|bat|exe|py|js|mjs)$/i.test(file.path)))
    add('executable-resource', 'medium', 'Executable-looking resources are included as text, not executed.');
  if (candidate.source.url.startsWith('http:') || candidate.endpoint?.startsWith('http:'))
    add('plaintext-http', 'medium', 'An HTTP address has no TLS transport protection.');
  return { level: findings.some(item => item.level === 'high') ? 'high' : 'medium', findings,
    disclaimer: 'Heuristic warnings only, not malware detection, provenance verification, a sandbox or an execution permission.' };
}

export function publicCandidate(candidate) {
  const clean = createRedactor(credentialValues(candidate));
  const result = {
    kind: candidate.kind, name: clean(candidate.name), source: { url: clean(candidate.source.url),
      ...(candidate.source.revision ? { revision: clean(candidate.source.revision) } : {}) },
    destination: clean(candidate.destination),
    files: candidate.files.map(file => ({ path: clean(file.path), content: /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|credentials(?:\..*)?)$/i.test(file.path)
      || /-----BEGIN [\w ]*PRIVATE KEY-----/.test(file.content) ? REDACTED : clean(file.content) })),
    commands: candidate.commands.map(command => ({ executable: clean(command.executable), args: command.args.map(clean) })),
    env: Object.fromEntries(Object.entries(candidate.env).map(([key, value]) => [key, value === null || value === '' ? '[REQUIRED]' : REDACTED])),
    headers: Object.fromEntries(Object.entries(candidate.headers).map(([key, value]) => [key, value === null || value === '' ? '[REQUIRED]' : REDACTED])),
    ...(candidate.transport ? { transport: candidate.transport } : {}), ...(candidate.endpoint ? { endpoint: clean(candidate.endpoint) } : {}),
  };
  assertPreviewSize(result);
  return result;
}
