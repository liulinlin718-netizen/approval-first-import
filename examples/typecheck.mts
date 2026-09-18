import { ImportApprovalGate, discoveryCandidate, type ImportCandidate, type SaveReceipt } from 'approval-first-import';

const candidate: ImportCandidate = {
  kind: 'skill', name: 'Handoff', source: { url: 'https://example.org/handoff', revision: 'v1' },
  destination: 'skills/handoff', files: [{ path: 'SKILL.md', content: 'Summarize known decisions.' }],
};
const gate = new ImportApprovalGate({ recordDecision: async decision => { const action: 'save_configuration' = decision.action; void action; } });
const view = gate.preview(candidate, { scope: 'example-user' });
const willExecute: false = view.willExecute;
const receipt: Promise<SaveReceipt<number>> = gate.confirmAndSave({
  previewId: view.previewId, fingerprint: view.fingerprint, scope: 'example-user', candidate, confirmed: true,
}, approved => approved.files.length);
const found = discoveryCandidate({ kind: 'skill', name: 'Handoff', url: candidate.source.url, provider: 'example' });
void willExecute; void receipt; void found;
