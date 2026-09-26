import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ApprovalError, canonical, fail, freeze, confirmationInput, normalizeCandidate, text } from './input.js';
import { publicCandidate, riskFor } from './preview.js';
import { assertPreviewSize } from './redaction.js';
import { boundedCall, WaitError } from './wait.js';
export { ApprovalError } from './input.js';
export { discoveryCandidate } from './preview.js';

const SAFETY = { requiresConfirmation: true, willWrite: false, willExecute: false };
const terminal = new Set(['saved', 'failed', 'expired', 'revoked', 'save_unknown']);
const validTimeout = value => Number.isSafeInteger(value) && value >= 1 && value <= 3600000;

/** In-memory, single-process gate. The host owns authentication and durable saving. */
export class ImportApprovalGate {
  #key = randomBytes(32);
  #entries = new Map();
  #clock;
  #ttl;
  #limit;
  #record;
  #recordTimeout;
  #saveTimeout;
  #lastNow = 0;
  constructor({ now = Date.now, ttlMs = 300000, maxEntries = 64, recordDecision,
    recordTimeoutMs = 10000, saveTimeoutMs = 30000 } = {}) {
    if (typeof now !== 'function' || !validTimeout(ttlMs) || !validTimeout(recordTimeoutMs) || !validTimeout(saveTimeoutMs)
      || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024
      || (recordDecision !== undefined && typeof recordDecision !== 'function')) fail('invalid_options', 'Invalid gate options.');
    this.#clock = now; this.#ttl = ttlMs; this.#limit = maxEntries; this.#record = recordDecision;
    this.#recordTimeout = recordTimeoutMs; this.#saveTimeout = saveTimeoutMs;
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
    this.#expire(entry, this.#now());
    return entry;
  }
  #finish(entry, status) {
    entry.status = status;
    clearTimeout(entry.timer); entry.timer = undefined;
    entry.candidate = undefined;
    const controller = entry.auditController;
    entry.auditController = undefined;
    controller?.abort(new WaitError(status));
  }
  #expire(entry, now) {
    if (['pending', 'confirming'].includes(entry.status) && now >= entry.expiresAt) this.#finish(entry, 'expired');
  }
  preview(input, { scope } = {}) {
    if (!text(scope, 160)) fail('invalid_scope', 'A host-controlled approval scope is required.');
    const createdAt = this.#now();
    for (const [id, entry] of this.#entries) {
      this.#expire(entry, createdAt);
      if (terminal.has(entry.status)) this.#entries.delete(id);
    }
    if (this.#entries.size >= this.#limit) fail('capacity', 'Too many pending previews.');
    const candidate = normalizeCandidate(input);
    const view = freeze({ version: 1, previewId: randomUUID(), fingerprint: this.#digest(candidate, scope),
      createdAt, expiresAt: createdAt + this.#ttl, candidate: publicCandidate(candidate), risk: riskFor(candidate), ...SAFETY });
    assertPreviewSize(view);
    // Keep no redacted view internally; terminal entries retain only small lifecycle metadata.
    const entry = { candidate, scope, status: 'pending', fingerprint: view.fingerprint,
      expiresAt: view.expiresAt, riskLevel: view.risk.level };
    entry.timer = setTimeout(() => this.#finish(entry, 'expired'), Math.max(1, view.expiresAt - this.#now()));
    entry.timer.unref();
    this.#entries.set(view.previewId, entry);
    return view;
  }
  status(previewId, { scope } = {}) { return this.#entry(previewId, scope).status; }
  revoke(previewId, { scope } = {}) {
    const entry = this.#entry(previewId, scope);
    if (!['pending', 'confirming'].includes(entry.status)) fail('consumed', 'The preview can no longer be revoked.');
    this.#finish(entry, 'revoked');
  }
  async confirmAndSave(request, save, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid_options', 'Expected an AbortSignal.');
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('confirmation_required', 'Explicit confirmation is required.');
    const { previewId, scope, fingerprint, confirmed, acknowledgeHighRisk, candidate } = confirmationInput(request);
    const entry = this.#entry(previewId, scope);
    if (entry.status === 'expired') fail('expired', 'Preview expired; prepare a new preview.');
    if (entry.status !== 'pending') fail('consumed', 'This preview is no longer available for confirmation.');
    if (confirmed !== true) fail('confirmation_required', 'Explicit confirmation is required.');
    let digest;
    try { digest = this.#digest(normalizeCandidate(candidate), scope); }
    catch { this.#finish(entry, 'revoked'); fail('content_changed', 'Current content is invalid; prepare a new preview.'); }
    if (fingerprint !== entry.fingerprint || digest !== fingerprint) {
      this.#finish(entry, 'revoked'); fail('content_changed', 'Content changed; prepare a new preview.');
    }
    if (entry.riskLevel === 'high' && acknowledgeHighRisk !== true)
      fail('risk_acknowledgement_required', 'High-risk warnings require separate acknowledgement.');
    if (typeof save !== 'function') fail('invalid_callback', 'The host must provide a save-only callback.');
    if (signal?.aborted) { this.#finish(entry, 'revoked'); fail('cancelled', 'Confirmation cancelled before saving.'); }
    const confirmedAt = this.#now();
    this.#expire(entry, confirmedAt);
    if (entry.status === 'expired') fail('expired', 'Preview expired before confirmation.');
    // Consume synchronously before any await: parallel clicks cannot run two callbacks.
    entry.status = 'confirming';
    entry.auditController = new AbortController();
    const decision = freeze({ previewId, fingerprint, scope, action: 'save_configuration', confirmedAt,
      expiresAt: entry.expiresAt, acknowledgeHighRisk: acknowledgeHighRisk === true, willExecute: false });
    try {
      if (this.#record) {
        const remaining = entry.expiresAt - this.#now();
        await boundedCall(context => this.#record(decision, context), {
          timeoutMs: Math.min(remaining, this.#recordTimeout),
          timeoutCode: remaining <= this.#recordTimeout ? 'expired' : 'record_timeout',
          signal, stopSignal: entry.auditController.signal,
        });
      }
    } catch (error) {
      const reason = error instanceof WaitError ? error.code : 'record_failed';
      this.#finish(entry, reason === 'expired' ? 'expired' : ['cancelled', 'revoked'].includes(reason) ? 'revoked' : 'failed');
      throw new ApprovalError(reason, 'Confirmation audit did not finish successfully; saving was not authorized. Prepare a new preview.');
    }
    this.#expire(entry, this.#now());
    if (entry.status === 'expired') fail('expired', 'Preview expired before saving.');
    if (entry.status !== 'confirming') fail('revoked', 'Confirmation was revoked before saving.');
    if (signal?.aborted) { this.#finish(entry, 'revoked'); fail('cancelled', 'Confirmation cancelled before saving.'); }
    clearTimeout(entry.timer); entry.timer = undefined; entry.auditController = undefined;
    entry.status = 'saving';
    try {
      const value = await boundedCall(context => save(entry.candidate, decision, context), {
        timeoutMs: this.#saveTimeout, timeoutCode: 'save_timeout', signal,
      });
      this.#finish(entry, 'saved');
      return Object.freeze({ previewId, fingerprint, status: 'saved', willExecute: false, value });
    } catch (error) {
      if (error instanceof WaitError) {
        this.#finish(entry, 'save_unknown');
        throw new ApprovalError('save_unknown', 'Saving started, but its outcome is unknown. Query the host receipt before any new approval; do not retry automatically.');
      }
      this.#finish(entry, 'failed');
      throw new ApprovalError('save_failed', 'Save callback failed; it may have partially written. Inspect storage and prepare a new preview; no automatic retry.');
    }
  }
}
