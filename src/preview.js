import { freeze, jsonCopy, sourceUrl, text, fail } from './input.js';

const REDACTED = '[REDACTED]';
const sensitive = /token|password|passwd|secret|api[-_]?key|credential|authorization|cookie|private[-_]?key/i;
function displayUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    if (url.username || url.password) { url.username = REDACTED; url.password = REDACTED; }
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, REDACTED);
    if (url.hash) url.hash = REDACTED;
    return url.toString();
  } catch { return value; }
}
function scrub(value, known) {
  let output = value;
  for (const secret of known) output = output.split(secret).join(REDACTED);
  output = output.replace(/https?:\/\/[^\s<>"']+/gi, displayUrl);
  output = output.replace(/\bBearer\s+[^\s,"';]+/gi, `Bearer ${REDACTED}`);
  output = output.replace(/((?:[\w.-]*(?:token|password|passwd|secret|api[_-]?key|credential|authorization|cookie|private[_-]?key)[\w.-]*)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, `$1${REDACTED}`);
  return output.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '\uFFFD');
}

/** No fetch, draft, command construction or filesystem access happens here. */
export function discoveryCandidate(input) {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['name', 'kind', 'url', 'provider'].includes(key))
    || !text(value.name, 120) || !['skill', 'mcp'].includes(value.kind) || !text(value.provider, 80))
    fail('invalid_input', 'Discovery accepts metadata only.');
  return freeze({ kind: value.kind, name: scrub(value.name, []), provider: scrub(value.provider, []),
    url: displayUrl(sourceUrl(value.url)), phase: 'discovery', requiresConfirmation: true, willWrite: false, willExecute: false });
}

export function riskFor(candidate) {
  const findings = [];
  const add = (code, level, message) => { if (!findings.some(item => item.code === code)) findings.push({ code, level, message }); };
  add('external-content', 'medium', 'Source authenticity and package behavior have not been verified.');
  if (!candidate.source.revision) add('mutable-source', 'medium', 'No immutable version/commit was supplied; the host must pin downloaded content.');
  if (candidate.commands.length) add('command-declared', 'medium', 'Commands are descriptions only. Running them requires a separate policy and authorization.');
  if (Object.keys(candidate.env).length || Object.keys(candidate.headers).length) add('credentials', 'medium', 'Environment and header values are hidden. Review names and use your own credentials.');
  const content = [...candidate.files.map(file => file.content), ...candidate.commands.map(command => [command.executable, ...command.args].join(' '))].join('\n');
  if (/\b(?:curl|wget)\b[^\r\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i.test(content))
    add('remote-script-pipe', 'high', 'Remote content appears to be piped into a shell.');
  if (/\brm\s+[^\r\n]*-[a-z]*[rf]|\b(?:del\s+\/[sq]|rmdir\s+\/s)|Remove-Item[^\r\n]*-Recurse|\bformat\s+[a-z]:/i.test(content))
    add('destructive-command', 'high', 'A potentially destructive command was detected.');
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
  const known = [...Object.values(candidate.env), ...Object.values(candidate.headers)].filter(value => typeof value === 'string' && value)
    .sort((a, b) => b.length - a.length);
  // Flagged command arguments can contain credentials not duplicated in env.
  for (const command of candidate.commands) for (let index = 0; index < command.args.length; index++) {
    const arg = command.args[index];
    if (/^--?/.test(arg) && sensitive.test(arg.split('=')[0])) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : command.args[index + 1];
      if (value) known.push(value);
    }
  }
  const clean = value => scrub(value, known);
  return {
    kind: candidate.kind, name: clean(candidate.name), source: { url: clean(displayUrl(candidate.source.url)),
      ...(candidate.source.revision ? { revision: clean(candidate.source.revision) } : {}) },
    destination: clean(candidate.destination),
    files: candidate.files.map(file => ({ path: clean(file.path), content: /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|credentials(?:\..*)?)$/i.test(file.path)
      || /-----BEGIN [\w ]*PRIVATE KEY-----/.test(file.content) ? REDACTED : clean(file.content) })),
    commands: candidate.commands.map(command => ({ executable: clean(command.executable), args: command.args.map(clean) })),
    env: Object.fromEntries(Object.entries(candidate.env).map(([key, value]) => [key, value === null || value === '' ? '[REQUIRED]' : REDACTED])),
    headers: Object.fromEntries(Object.entries(candidate.headers).map(([key, value]) => [key, value === null || value === '' ? '[REQUIRED]' : REDACTED])),
    ...(candidate.transport ? { transport: candidate.transport } : {}), ...(candidate.endpoint ? { endpoint: clean(displayUrl(candidate.endpoint)) } : {}),
  };
}
