import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export class HostError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const targetKey = (workspaceId, destination) => createHash('sha256')
  .update(JSON.stringify([workspaceId, destination.normalize('NFC').toLowerCase()])).digest('hex');

/** Reference only: one owner/process per file, on a trusted local filesystem. */
export class FileConfigStore {
  #directory; #state; #tail = Promise.resolve();
  static async open(directory) {
    const store = new FileConfigStore();
    store.#directory = resolve(directory);
    await mkdir(store.#directory, { recursive: true, mode: 0o700 });
    store.#state = { format: 1, configs: {}, receipts: {}, decisions: [] };
    try {
      if ((await stat(join(store.#directory, 'state.json'))).size > 16777216)
        throw new HostError('storage_invalid', 'Store exceeds the example size limit.');
      const state = JSON.parse(await readFile(join(store.#directory, 'state.json'), 'utf8'));
      if (state.format !== 1 || !state.configs || !state.receipts || !Array.isArray(state.decisions))
        throw new HostError('storage_invalid', 'Invalid example store.');
      store.#state = state;
    } catch (error) { if (error.code !== 'ENOENT') throw new HostError('storage_invalid', 'Cannot read the example store. Inspect it before continuing.'); }
    return store;
  }
  version(workspaceId, destination) { return this.#state.configs[targetKey(workspaceId, destination)]?.version ?? 0; }
  receipt(scope, previewId) {
    const record = this.#state.receipts[previewId];
    return record?.scope === scope ? structuredClone(record.receipt) : null;
  }
  #transaction(change, signal) {
    const operation = this.#tail.then(async () => {
      signal?.throwIfAborted();
      const next = structuredClone(this.#state), value = change(next);
      const bytes = JSON.stringify(next);
      if (Buffer.byteLength(bytes) > 16777216 || next.decisions.length > 1000)
        throw new HostError('storage_capacity', 'Archive the example store before adding more records.');
      const temporary = join(this.#directory, `.state-${randomUUID()}.tmp`);
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(bytes, 'utf8'); await file.sync(); await file.close(); file = undefined;
        signal?.throwIfAborted();
        // Configuration version and idempotency receipt are replaced in the same document.
        await rename(temporary, join(this.#directory, 'state.json'));
        this.#state = next;
        return structuredClone(value);
      } finally {
        try { await file?.close(); }
        finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  audit(decision, { signal } = {}) {
    return this.#transaction(state => { state.decisions.push(structuredClone(decision)); }, signal);
  }
  save({ scope, workspaceId, candidate, decision, expectedVersion }, { signal } = {}) {
    return this.#transaction(state => {
      const existing = state.receipts[decision.previewId];
      if (existing) {
        if (existing.scope !== scope || existing.receipt.fingerprint !== decision.fingerprint)
          throw new HostError('receipt_conflict', 'Receipt identity does not match.');
        return existing.receipt.value;
      }
      const key = targetKey(workspaceId, candidate.destination), current = state.configs[key]?.version ?? 0;
      if (current !== expectedVersion) throw new HostError('version_conflict', 'Target changed. Review its new version and explicitly approve a new preview.');
      const value = { version: current + 1 };
      state.configs[key] = { version: value.version, candidate: structuredClone(candidate) };
      state.receipts[decision.previewId] = { scope, receipt: { previewId: decision.previewId,
        fingerprint: decision.fingerprint, status: 'saved', willExecute: false, value } };
      return value;
    }, signal);
  }
}
