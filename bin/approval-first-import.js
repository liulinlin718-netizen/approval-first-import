#!/usr/bin/env node
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImportApprovalGate, ApprovalError, discoveryCandidate } from '../src/index.js';

export async function run(argv, print = value => console.log(JSON.stringify(value, null, 2))) {
  const [command, path] = argv;
  if (command === 'demo' && argv.length === 1) {
    const candidate = { kind: 'mcp', name: 'Synthetic notes server', source: { url: 'https://example.org/notes', revision: 'demo-v1' },
      destination: 'config/mcp-notes.json', transport: 'stdio', commands: [{ executable: 'node', args: ['notes-server.mjs'] }],
      env: { NOTES_TOKEN: 'synthetic-not-a-real-token' } };
    const scope = 'offline-demo', gate = new ImportApprovalGate(), preview = gate.preview(candidate, { scope });
    print(discoveryCandidate({ name: candidate.name, kind: 'mcp', url: candidate.source.url, provider: 'offline-example' }));
    print(preview);
    let savedCount = 0;
    const request = { previewId: preview.previewId, fingerprint: preview.fingerprint, scope, confirmed: true, candidate };
    const receipt = await gate.confirmAndSave(request, () => { savedCount++; return 'in-memory-only'; });
    print({ ...receipt, savedCount, note: 'Simulated explicit confirmation. No disk save, shell, package installation or network access.' });
    try { await gate.confirmAndSave(request, () => { savedCount++; }); }
    catch (error) { print({ duplicateConfirmation: error.code, savedCount }); }
    return;
  }
  if (command === 'preview' && argv.length === 2) {
    const file = resolve(path), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 524288) throw new ApprovalError('invalid_input', 'Use a regular JSON file no larger than 512 KiB.');
    const handle = await open(file, 'r');
    let bytes;
    try {
      if (!(await handle.stat()).isFile()) throw new ApprovalError('invalid_input', 'Use a regular JSON file.');
      const buffer = Buffer.alloc(524289); let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 524288) throw new ApprovalError('invalid_input', 'Input file exceeds 512 KiB.');
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    print(new ImportApprovalGate().preview(candidate, { scope: 'offline-cli' }));
    return;
  }
  if (command === '--help' || !command) {
    print({ usage: ['approval-first-import preview candidate.json', 'approval-first-import demo'],
      note: 'Offline only. CLI previews expire with this process; integrate the library for confirmation and saving.' });
    return;
  }
  throw new ApprovalError('usage', 'Use preview <candidate.json>, demo, or --help.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch(error => {
    // JSON parser and filesystem errors may quote the input or a private path.
    console.error(JSON.stringify({ error: error instanceof ApprovalError ? error.code : 'input_error',
      message: error instanceof ApprovalError ? error.message : 'Could not read a valid UTF-8 candidate JSON file.' }));
    process.exitCode = 1;
  });
}
