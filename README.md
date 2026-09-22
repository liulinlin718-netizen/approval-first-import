# Approval-First Import

Approval-First Import is a zero-dependency Node.js library for reviewing an untrusted Skill or MCP configuration before an application saves it.

It provides a content-bound approval gate with redacted previews, risk findings, expiration, scope binding, and single-use confirmation. Search results do not become drafts automatically, previews do not write files, and saved configurations are never executed by this package.

```text
Discovery candidate
  → trusted host fetches and pins exact content
  → redacted preview + risk findings
  → authenticated user confirmation
  → same content, same scope, still valid?
  → host records the decision and saves atomically

Execution remains a separate operation and authorization.
```

## Why Use It

Importing third-party Agent capabilities crosses several trust boundaries. A useful approval flow should make these distinctions explicit:

- Discovery metadata is not an installable configuration.
- A preview is not consent.
- Consent applies to exact content and scope, not a mutable URL.
- Saving configuration is not permission to execute it.
- High-risk commands require an additional acknowledgement.
- A failed or ambiguous save must not be retried automatically with the old approval.

## Quick Start

Requires Node.js 22 or newer. No dependency installation, model key, network access, or build step is required.

```sh
git clone https://github.com/liulinlin718-netizen/approval-first-import.git
cd approval-first-import

node bin/approval-first-import.js demo
node bin/approval-first-import.js preview examples/skill.json
node bin/approval-first-import.js preview examples/mcp-high-risk.json
```

The CLI prints previews only. It does not expose a save, install, confirm, or shell command. Use the library inside a trusted backend for the full confirmation flow.

## Integration

```js
import { ImportApprovalGate } from './src/index.js';

const gate = new ImportApprovalGate({
  ttlMs: 5 * 60_000,
  recordDecision: async decision => auditStore.append(decision),
});

// Build this draft in trusted host code after safely fetching pinned content.
const draft = {
  kind: 'mcp',
  name: 'Notes',
  source: {
    url: 'https://example.org/notes',
    revision: 'pinned-revision',
  },
  destination: 'config/notes.json',
  transport: 'stdio',
  commands: [{ executable: 'node', args: ['notes-server.mjs'] }],
  env: { NOTES_TOKEN: 'user-supplied-value' },
};

const scope = `${authenticatedUser.id}:${workspace.id}`;
const preview = gate.preview(draft, { scope });

// Send only the redacted preview to the UI. Keep the original draft on the host.

const receipt = await gate.confirmAndSave({
  previewId: preview.previewId,
  fingerprint: preview.fingerprint,
  scope,
  candidate: currentHostDraft,
  confirmed: userForm.confirmed === true,
  acknowledgeHighRisk: userForm.acknowledgeHighRisk === true,
}, async (approved, decision) => {
  return configStore.saveAtomically(decision.previewId, approved);
});
```

Authentication, CSRF protection, the audit store, content fetching, and atomic persistence belong to the host application. A model-generated `confirmed: true` is not human consent.

## Safety Contract

Every preview includes these literal values:

```json
{
  "requiresConfirmation": true,
  "willWrite": false,
  "willExecute": false
}
```

The gate binds approval to:

- the normalized Skill/MCP candidate
- source URL and pinned revision
- destination and file contents
- structured command descriptions
- hidden environment and header values
- user/workspace scope
- preview lifetime and one-time state

Any meaningful change invalidates the old approval. The save callback receives the frozen original candidate, not an object reconstructed from the public preview.

## Public API

| Operation | Purpose |
| --- | --- |
| `discoveryCandidate(input)` | Validate discovery metadata only; never fetch or construct commands. |
| `new ImportApprovalGate(options?)` | Create a bounded in-memory approval registry. |
| `gate.preview(candidate, { scope })` | Create a frozen redacted preview and content fingerprint. |
| `gate.confirmAndSave(request, save)` | Validate consent, content, scope, expiry, and risk acknowledgement before one save callback. |
| `gate.status(previewId, { scope })` | Read the current state of a preview in this gate. |
| `gate.revoke(previewId, { scope })` | Revoke a pending approval. |

Supported candidates include multi-file text Skills and MCP configurations using structured stdio commands or HTTP/SSE endpoints. Unknown fields, accessors, cycles, prototype keys, oversized values, and unsafe portable destinations are rejected.

## Redaction and Risk Findings

The public preview hides environment and header values, URL query values and fragments, known credential arguments, bearer values, and credential-like file contents. Empty required values are shown as `[REQUIRED]`.

Risk findings cover command declarations, shell or inline-code execution, remote-script pipes, destructive commands, lifecycle scripts, privilege changes, and executable-looking resources. All external imports start at least at `medium`; `high` requires additional acknowledgement but still does not permit execution.

Redaction is deliberately conservative, but it is not a complete secret scanner or malicious-code detector. Render imported content as text, never as trusted HTML.

## State Model

```text
pending → confirming → saving → saved
   │           │           └→ failed
   │           ├→ expired / revoked / failed
   └→ expired / revoked
```

Concurrent confirmations cannot invoke the host save callback twice. A failed save consumes the approval because a partial write may have occurred. There is no automatic retry or rollback.

## Host Responsibilities

This library does not provide authentication, package discovery, SSRF protection, sandboxing, filesystem isolation, schema verification, immutable audit storage, or command execution.

The host must:

- fetch remote content through its own network policy
- pin and retain the exact bytes shown in the preview
- validate package-specific schemas
- map destinations under an allowed root and resolve symlinks safely
- persist atomically and make save handling idempotent
- authorize any later MCP or script execution separately
- use shared transactional storage if approvals span multiple workers

Approvals are process-local. Restarting the gate requires a new preview; persisted audit records must never recreate live permission.

## Tests

```sh
node --test
```

Tests use synthetic local fixtures and do not perform network requests, model calls, package installation, or tool execution.

## License

MIT. This package was extracted from TAgent's separation of discovery, import preview, explicit confirmation, and execution authorization. See [NOTICE](./NOTICE) for provenance.
