import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ApprovalError, canonical, fail, freeze, jsonCopy, normalizeCandidate, text } from './input.js';
import { publicCandidate, riskFor } from './preview.js';
export { ApprovalError } from './input.js';
export { discoveryCandidate } from './preview.js';

const SAFETY = { requiresConfirmation: true, willWrite: false, willExecute: false };
const terminal = new Set(['saved', 'failed', 'expired', 'revoked']);

/** In-memory, single-process gate. The host owns authentication and durable saving. */
export class ImportApprovalGate {
  #key = randomBytes(32);
  #entries = new Map();
  #clock;
  #ttl;
  #limit;
  #record;
  #lastNow = 0;
  constructor({ now = Date.now, ttlMs = 300000, maxEntries = 64, recordDecision } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000
      || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024
      || (recordDecision !== undefined && typeof recordDecision !== 'function')) fail('invalid_options', 'Invalid gate options.');
    this.#clock = now; this.#ttl = ttlMs; this.#limit = maxEntries; this.#record = recordDecision;
  }
  #now() {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_clock', 'The gate clock is invalid.');
    this.#lastNow = Math.max(this.#lastNow, value);
    return this.#lastNow;
  }
  #digest(candidate, scope) {
    // Keyed per process: exported fingerprints cannot be used to guess low-entropy env values.
    return createHmac('sha256', this.#key).update(canonical({ version: 1, scope, candidate })).digest('hex');
  }
  #entry(id, scope) {
    const entry = this.#entries.get(id);
    if (!entry || entry.scope !== scope) fail('not_found', 'Preview does not exist in this scope.');
    if (entry.status === 'pending' && this.#now() >= entry.view.expiresAt) entry.status = 'expired';
    return entry;
  }
  preview(input, { scope } = {}) {
    if (!text(scope, 160)) fail('invalid_scope', 'A host-controlled approval scope is required.');
    const candidate = normalizeCandidate(input), createdAt = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.status === 'pending' && createdAt >= entry.view.expiresAt) entry.status = 'expired';
      if (terminal.has(entry.status)) this.#entries.delete(id);
    }
    if (this.#entries.size >= this.#limit) fail('capacity', 'Too many pending previews.');
    const view = freeze({ version: 1, previewId: randomUUID(), fingerprint: this.#digest(candidate, scope),
      createdAt, expiresAt: createdAt + this.#ttl, candidate: publicCandidate(candidate), risk: riskFor(candidate), ...SAFETY });
    this.#entries.set(view.previewId, { view, candidate, scope, status: 'pending' });
    return view;
  }
  status(previewId, { scope } = {}) { return this.#entry(previewId, scope).status; }
  revoke(previewId, { scope } = {}) {
    const entry = this.#entry(previewId, scope);
    if (!['pending', 'confirming'].includes(entry.status)) fail('consumed', 'The preview can no longer be revoked.');
    entry.status = 'revoked';
  }
  async confirmAndSave(request, save) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('confirmation_required', 'Explicit confirmation is required.');
    const { previewId, scope, fingerprint, confirmed, acknowledgeHighRisk, candidate } = jsonCopy(request);
    const entry = this.#entry(previewId, scope);
    if (entry.status === 'expired') fail('expired', 'Preview expired; prepare a new preview.');
    if (entry.status !== 'pending') fail('consumed', 'This preview is no longer available for confirmation.');
    if (confirmed !== true) fail('confirmation_required', 'Explicit confirmation is required.');
    let digest;
    try { digest = this.#digest(normalizeCandidate(candidate), scope); }
    catch { entry.status = 'revoked'; fail('content_changed', 'Current content is invalid; prepare a new preview.'); }
    if (fingerprint !== entry.view.fingerprint || digest !== fingerprint) {
      entry.status = 'revoked'; fail('content_changed', 'Content changed; prepare a new preview.');
    }
    if (entry.view.risk.level === 'high' && acknowledgeHighRisk !== true)
      fail('risk_acknowledgement_required', 'High-risk warnings require separate acknowledgement.');
    if (typeof save !== 'function') fail('invalid_callback', 'The host must provide a save-only callback.');
    // Consume synchronously before any await: parallel clicks cannot run two callbacks.
    entry.status = 'confirming';
    const decision = freeze({ previewId, fingerprint, scope, action: 'save_configuration', confirmedAt: this.#now(),
      expiresAt: entry.view.expiresAt, acknowledgeHighRisk: acknowledgeHighRisk === true, willExecute: false });
    try { if (this.#record) await this.#record(decision); }
    catch { entry.status = 'failed'; fail('record_failed', 'Confirmation record failed; saving was not authorized.'); }
    if (entry.status !== 'confirming') fail('revoked', 'Confirmation was revoked before saving.');
    if (this.#now() >= entry.view.expiresAt) { entry.status = 'expired'; fail('expired', 'Preview expired before saving.'); }
    entry.status = 'saving';
    try {
      const value = await save(entry.candidate, decision);
      entry.status = 'saved';
      return Object.freeze({ previewId, fingerprint, status: 'saved', willExecute: false, value });
    } catch {
      entry.status = 'failed';
      throw new ApprovalError('save_failed', 'Save callback failed; it may have partially written. Inspect storage and prepare a new preview; no automatic retry.');
    }
  }
}
