import { ImportApprovalGate } from 'approval-first-import';
import { HostError } from './host-store.js';
const terminal = new Set(['saved', 'failed', 'expired', 'revoked', 'save_unknown']);

/** Backend-only example. authenticate must verify BOTH identity and workspace access. */
export class ImportHost {
  #authenticate; #store; #gate; #drafts = new Map();
  constructor({ store, authenticate = () => null, gateOptions = {} }) {
    this.#store = store; this.#authenticate = authenticate;
    this.#gate = new ImportApprovalGate({ ...gateOptions, recordDecision: (decision, context) => store.audit(decision, context) });
  }
  async #identity(transportContext) {
    const identity = await this.#authenticate(transportContext);
    if (!identity || typeof identity.userId !== 'string' || typeof identity.workspaceId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(identity.userId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(identity.workspaceId))
      throw new HostError('unauthorized', 'Sign in and choose an authorized workspace.');
    return { ...identity, scope: JSON.stringify([identity.userId, identity.workspaceId]) };
  }
  #drop(previewId) {
    clearTimeout(this.#drafts.get(previewId)?.timer);
    this.#drafts.delete(previewId);
  }
  #find(previewId, scope) {
    const draft = this.#drafts.get(previewId);
    if (!draft || draft.scope !== scope) throw new HostError('not_found', 'Draft is not available in this scope.');
    return draft;
  }
  async prepare(context, candidate) {
    const identity = await this.#identity(context);
    for (const [id, draft] of this.#drafts) {
      try { if (terminal.has(this.#gate.status(id, { scope: draft.scope }))) this.#drop(id); }
      catch { this.#drop(id); }
    }
    // Validate before cloning. The host's decoded draft stays here, never in the response.
    const preview = this.#gate.preview(candidate, { scope: identity.scope });
    let draft;
    try {
      draft = { scope: identity.scope, candidate: structuredClone(candidate),
        expectedVersion: this.#store.version(identity.workspaceId, candidate.destination) };
    } catch (error) { this.#gate.revoke(preview.previewId, { scope: identity.scope }); throw error; }
    draft.timer = setTimeout(() => this.#drop(preview.previewId), Math.max(1, preview.expiresAt - Date.now()));
    draft.timer.unref(); this.#drafts.set(preview.previewId, draft);
    return { preview, targetVersion: draft.expectedVersion };
  }
  async confirm(context, body, options) {
    const identity = await this.#identity(context);
    // HTTP adapters must parse bounded JSON and enforce CSRF/origin checks before this call.
    if (!body || Object.keys(body).some(key => !['previewId', 'fingerprint', 'confirmed', 'acknowledgeHighRisk'].includes(key)))
      throw new HostError('invalid_input', 'Only preview identity and explicit consent may be submitted.');
    if (body.confirmed !== true) throw new HostError('confirmation_required', 'Confirm the preview before saving.');
    const previous = this.#store.receipt(identity.scope, body.previewId);
    if (previous) {
      if (previous.fingerprint !== body.fingerprint) throw new HostError('content_changed', 'Receipt fingerprint differs.');
      return previous;
    }
    const draft = this.#find(body.previewId, identity.scope);
    let storageError;
    try {
      return await this.#gate.confirmAndSave({ ...body, scope: identity.scope, candidate: draft.candidate },
        async (candidate, decision, callbackContext) => {
          try {
            return await this.#store.save({ scope: identity.scope, workspaceId: identity.workspaceId, candidate,
              decision, expectedVersion: draft.expectedVersion }, callbackContext);
          } catch (error) { storageError = error; throw error; }
        }, options);
    } catch (error) {
      if (error.code === 'save_failed' && storageError instanceof HostError && storageError.code === 'version_conflict') throw storageError;
      throw error;
    } finally {
      // Risk acknowledgement and invalid submissions leave a still-pending preview usable.
      try { if (terminal.has(this.#gate.status(body.previewId, { scope: identity.scope }))) this.#drop(body.previewId); }
      catch { this.#drop(body.previewId); }
    }
  }
  async receipt(context, previewId) {
    const identity = await this.#identity(context);
    return this.#store.receipt(identity.scope, previewId);
  }
  close() {
    for (const [id, draft] of this.#drafts) {
      try { this.#gate.revoke(id, { scope: draft.scope }); } catch { /* Already consumed. */ }
      this.#drop(id);
    }
  }
}
