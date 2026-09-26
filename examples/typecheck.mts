import { ImportApprovalGate, discoveryCandidate, type ImportCandidate, type SaveReceipt, type ApprovalStatus } from 'approval-first-import';

const candidate: ImportCandidate = {
  kind: 'skill', name: 'Handoff', source: { url: 'https://example.org/handoff', revision: 'v1' },
  destination: 'skills/handoff', files: [{ path: 'SKILL.md', content: 'Summarize known decisions.' }],
};
const gate = new ImportApprovalGate({ recordTimeoutMs: 1000, saveTimeoutMs: 2000,
  recordDecision: async (decision, context) => {
    const action: 'save_configuration' = decision.action;
    context.signal.throwIfAborted(); void action;
  } });
const view = gate.preview(candidate, { scope: 'example-user' });
const willExecute: false = view.willExecute;
const receipt: Promise<SaveReceipt<number>> = gate.confirmAndSave({
  previewId: view.previewId, fingerprint: view.fingerprint, scope: 'example-user', candidate, confirmed: true,
}, (approved, decision, context) => {
  const signal: AbortSignal = context.signal;
  signal.throwIfAborted(); void decision;
  return approved.files.length;
}, { signal: new AbortController().signal });
const uncertain: ApprovalStatus = 'save_unknown';
const found = discoveryCandidate({ kind: 'skill', name: 'Handoff', url: candidate.source.url, provider: 'example' });
void willExecute; void receipt; void found; void uncertain;
