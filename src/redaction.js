import { fail } from './input.js';

export const REDACTED = '[REDACTED]';
export const MAX_PREVIEW_BYTES = 1048576;
const MAX_FIELD_BYTES = 262144, MAX_MATCHES = 1000000;
const MAX_SCAN_UNITS = 64 * 1024 * 1024;
export const sensitive = /token|password|passwd|secret|api[-_]?key|credential|authorization|cookie|private[-_]?key/i;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

export function assertPreviewSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PREVIEW_BYTES)
    fail('preview_too_large', 'The complete redacted preview exceeds 1 MiB; split the import and preview again.');
}

/** Mark ranges in the original string, then render once. Generated masks are never scanned. */
export function createRedactor(values = []) {
  const known = [...new Set(values.filter(value => typeof value === 'string' && value))];
  let totalBytes = 0, matches = 0, scanUnits = 0;
  return value => {
    scanUnits += value.length * Math.max(1, known.length);
    if (scanUnits > MAX_SCAN_UNITS) fail('preview_complexity', 'Redaction exceeds the work budget; split the import and preview again.');
    const changes = new Int32Array(value.length + 1);
    const mark = (start, end) => {
      if (end <= start) return;
      if (++matches > MAX_MATCHES) fail('preview_complexity', 'Redaction exceeds the work budget; split the import and preview again.');
      changes[start]++; changes[end]--;
    };
    for (const secret of known) {
      let start = value.indexOf(secret);
      while (start !== -1) { mark(start, start + secret.length); start = value.indexOf(secret, start + 1); }
    }
    for (const match of value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      const raw = match[0], offset = match.index;
      const authorityStart = raw.indexOf('://') + 3;
      const authorityEnd = raw.slice(authorityStart).search(/[/?#]/);
      const at = raw.lastIndexOf('@', authorityEnd < 0 ? raw.length : authorityStart + authorityEnd);
      if (at >= authorityStart) mark(offset + authorityStart, offset + at);
      const fragment = raw.indexOf('#'), query = raw.indexOf('?');
      if (fragment !== -1) mark(offset + fragment + 1, offset + raw.length);
      if (query !== -1 && (fragment === -1 || query < fragment)) {
        const end = fragment === -1 ? raw.length : fragment;
        let start = query + 1;
        while (start < end) {
          let stop = raw.indexOf('&', start); if (stop < 0 || stop > end) stop = end;
          const equal = raw.slice(start, stop).indexOf('=');
          if (equal !== -1) mark(offset + start + equal + 1, offset + stop);
          start = stop + 1;
        }
      }
    }
    for (const match of value.matchAll(/\b(?:Bearer|Basic)[ \t]+([^\s,"';]+)/gi))
      mark(match.index + match[0].length - match[1].length, match.index + match[0].length);
    // Consume each token/value once instead of retrying a greedy prefix at every character.
    const words = /[\w.-]+/g;
    let word;
    while ((word = words.exec(value))) {
      if (!sensitive.test(word[0])) continue;
      let cursor = words.lastIndex;
      if (value[cursor] === '"' || value[cursor] === "'") cursor++;
      while (value[cursor] === ' ' || value[cursor] === '\t') cursor++;
      if (value[cursor] !== ':' && value[cursor] !== '=') continue;
      cursor++;
      while (value[cursor] === ' ' || value[cursor] === '\t') cursor++;
      const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor++] : undefined;
      const start = cursor;
      while (cursor < value.length && value[cursor] !== '\r' && value[cursor] !== '\n') {
        if (quote) {
          if (value[cursor] === quote) break;
          if (value[cursor] === '\\' && cursor + 1 < value.length) { cursor += 2; continue; }
        } else if (/[\s,;}]/.test(value[cursor])) break;
        cursor++;
      }
      mark(start, cursor);
      words.lastIndex = Math.max(words.lastIndex, cursor);
    }
    const parts = []; let fieldBytes = 0;
    const append = part => {
      const clean = part.replace(controls, '\uFFFD');
      const bytes = Buffer.byteLength(clean, 'utf8'); fieldBytes += bytes; totalBytes += bytes;
      if (fieldBytes > MAX_FIELD_BYTES || totalBytes > MAX_PREVIEW_BYTES)
        fail('preview_too_large', 'Redacted text exceeds its field or total byte budget; split the import and preview again.');
      parts.push(clean);
    };
    let active = 0, hidden = false, start = 0;
    for (let index = 0; index <= value.length; index++) {
      active += changes[index];
      if (active > 0 && !hidden) { append(value.slice(start, index)); hidden = true; }
      if (active === 0 && hidden) { append(REDACTED); start = index; hidden = false; }
    }
    append(value.slice(start));
    return parts.join('');
  };
}
