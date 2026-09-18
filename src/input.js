export const MAX_INPUT_BYTES = 524288;

export class ApprovalError extends Error {
  constructor(code, message) { super(message); this.name = 'ApprovalError'; this.code = code; }
}
export function fail(code, message) { throw new ApprovalError(code, message); }

// Inspect descriptors instead of invoking input getters/toJSON while validating.
export function jsonCopy(value, depth = 0, ancestors = new Set(), budget = { bytes: 0, nodes: 0 }) {
  if (++budget.nodes > 10000) fail('invalid_input', 'Too many input values.');
  if (depth > 16) fail('invalid_input', 'Input nesting is too deep.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > MAX_INPUT_BYTES) fail('invalid_input', 'Input is too large.');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) fail('invalid_input', 'Only finite, acyclic JSON data is supported.');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array && value.length > 2048) fail('invalid_input', 'Input array is too large.');
  if (!array && prototype !== Object.prototype && prototype !== null) fail('invalid_input', 'Only plain JSON objects are supported.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 2048) fail('invalid_input', 'Too many input fields.');
  const result = array ? [] : Object.create(null);
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
      || (array && !/^(0|[1-9]\d*)$/.test(key))) fail('invalid_input', 'Unsupported input key.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid_input', 'Input accessors and hidden fields are unsupported.');
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > MAX_INPUT_BYTES) fail('invalid_input', 'Input is too large.');
    result[key] = jsonCopy(descriptor.value, depth + 1, ancestors, budget);
  }
  ancestors.delete(value);
  if (array && result.length !== keys.length - 1) fail('invalid_input', 'Sparse arrays are unsupported.');
  return result;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export function text(value, max = 512, allowEmpty = false) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || !!value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
function keysOnly(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key)))
    fail('invalid_input', 'Unsupported fields in import input.');
}
export function relativePath(value) {
  return text(value, 240) && !/[\\:*?"<>|\r\n]/.test(value) && value.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function sourceUrl(value) {
  if (!text(value, 2048) || /[\r\n]/.test(value)) fail('invalid_input', 'Source must be an HTTP(S) URL without credentials.');
  let url;
  try { url = new URL(value); } catch { fail('invalid_input', 'Source URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('invalid_input', 'Source must be an HTTP(S) URL without credentials.');
  return url.toString();
}
function variables(value) {
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 128)
    fail('invalid_input', 'Invalid environment or header fields.');
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(key) || (item !== null && !text(item, 8192, true)))
      fail('invalid_input', 'Invalid environment or header fields.');
  }
  return value;
}

export function normalizeCandidate(input) {
  const value = jsonCopy(input);
  if (Buffer.byteLength(canonical(value), 'utf8') > MAX_INPUT_BYTES) fail('invalid_input', 'Import exceeds 512 KiB.');
  keysOnly(value, ['kind', 'name', 'source', 'destination', 'files', 'commands', 'env', 'headers', 'transport', 'endpoint']);
  if (!['skill', 'mcp'].includes(value.kind) || !text(value.name, 120) || !relativePath(value.destination))
    fail('invalid_input', 'Kind, name and a portable relative destination are required.');
  keysOnly(value.source, ['url', 'revision']);
  if (value.source.revision !== undefined && !text(value.source.revision, 160)) fail('invalid_input', 'Invalid source revision.');
  const source = { url: sourceUrl(value.source.url), ...(value.source.revision ? { revision: value.source.revision } : {}) };
  const files = value.files ?? [], commands = value.commands ?? [];
  if (!Array.isArray(files) || files.length > 64 || !Array.isArray(commands) || commands.length > 16)
    fail('invalid_input', 'At most 64 text files and 16 command descriptions are supported.');
  const paths = new Set();
  for (const file of files) {
    keysOnly(file, ['path', 'content']);
    if (!relativePath(file.path) || typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > 131072)
      fail('invalid_input', 'Invalid text file path or content exceeds 128 KiB.');
    const key = file.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) fail('invalid_input', 'File paths collide on a case-insensitive filesystem.');
    paths.add(key);
  }
  const normalizedCommands = commands.map(command => {
    keysOnly(command, ['executable', 'args']);
    if (!text(command.executable, 512) || /[\r\n]/.test(command.executable) || !Array.isArray(command.args ?? [])
      || (command.args ?? []).length > 128 || (command.args ?? []).some(arg => !text(arg, 8192, true)))
      fail('invalid_input', 'Invalid command description.');
    return { executable: command.executable, args: command.args ?? [] };
  });
  if (value.kind === 'skill' && (value.transport !== undefined || value.endpoint !== undefined))
    fail('invalid_input', 'Transport and endpoint belong to MCP imports.');
  if (value.kind === 'mcp') {
    if (!['stdio', 'http', 'sse'].includes(value.transport)) fail('invalid_input', 'MCP transport is required.');
    if (value.transport === 'stdio' ? !normalizedCommands.length || value.endpoint !== undefined : normalizedCommands.length || !value.endpoint)
      fail('invalid_input', 'MCP transport and command/endpoint disagree.');
  }
  const endpoint = value.endpoint === undefined ? undefined : sourceUrl(value.endpoint);
  return freeze({ kind: value.kind, name: value.name.trim(), source, destination: value.destination,
    files, commands: normalizedCommands, env: variables(value.env), headers: variables(value.headers),
    ...(value.transport ? { transport: value.transport } : {}), ...(endpoint ? { endpoint } : {}) });
}
