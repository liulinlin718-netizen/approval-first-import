# Approval-First Import

[中文](./README.md) | [English](./README_EN.md)

Approval-First Import is a zero-dependency Node.js library that establishes an explicit, auditable user-approval gate before an application saves an untrusted Skill or MCP configuration. It provides content-bound approval, redacted previews, risk findings, expiration, scope binding, and single-use confirmation.

The core question is not “how can installation be faster?” but “how can users understand what will happen before external capabilities are saved?” Search results never become drafts automatically, previews never write files, and this package never executes saved configurations.

## When to Use It

Importing third-party agent capabilities crosses several trust boundaries:

- Discovery metadata is not an installable configuration.
- A preview is not consent.
- Consent should bind to exact content and scope, not a mutable URL.
- Saving configuration is not permission to execute a command.
- High-risk commands require an additional acknowledgement.
- Failed or ambiguous saves must not replay an old approval automatically.

Approval-First Import turns these boundaries into a reusable state machine for host applications.

## Safety Flow

```mermaid
flowchart TD
    A["Search result / URL candidate"] --> B["Host: fetch safely and pin the original"]
    B --> C["Library: redacted preview + fingerprint + risk findings"]
    C --> D{"Explicit human approval?"}
    D -->|Reject or expire| E["Stop: do not call save"]
    D -->|Approve| F["Library: verify content, identity scope and lifetime"]
    F --> G["Host: atomically save configuration and receipt"]
    G -. Separate authorization .-> H["Host: later execution or activation"]
    classDef host fill:#f1f5f9,stroke:#64748b,color:#0f172a
    classDef gate fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    classDef consent fill:#fff7ed,stroke:#c2410c,color:#7c2d12
    classDef result fill:#ecfdf5,stroke:#047857,color:#064e3b
    class A,B,H host
    class C,F gate
    class D consent
    class E,G result
```

Execution always remains a separate operation and authorization. This package never runs an external command.

## Quick Start

Requires Node.js 22 or newer. After obtaining the repository, examples need no dependency installation, model key, network access, or build step.

```bash
git clone https://github.com/liulinlin718-netizen/approval-first-import.git
cd approval-first-import

node bin/approval-first-import.js demo
node bin/approval-first-import.js preview examples/skill.json
node bin/approval-first-import.js preview examples/mcp-high-risk.json
```

The CLI prints previews only. It exposes no save, install, confirm, or shell command. Integrate the library into a trusted backend for the full confirmation flow.

## See a Complete Import

This library has no graphical interface. The [runnable host demo](./examples/host-demo.js) below shows real synthetic output, not an application screenshot.

```bash
node examples/host-demo.js
```

The demo creates temporary storage inside the repository, simulates explicit approval, saves the fixture, reopens its receipt, then removes its own files. It never accesses the network or executes commands declared in the configuration.

```mermaid
sequenceDiagram
    actor User
    participant Host as Host application
    participant Gate as Approval-First Import
    participant Store as Configuration and receipt store
    Host->>Gate: Pinned original candidate + identity scope
    Gate-->>Host: Redacted preview, fingerprint, risk findings
    Host-->>User: Show source, configuration and risks
    User->>Host: Explicitly approve this preview
    Host->>Gate: Preview identity + current original + consent
    Gate->>Store: Host callbacks record audit and save
    Store-->>Host: Saved receipt, target version 1
    Note over Host,Store: If the response is lost, query the receipt; do not replay save
    Host->>Store: Look up previewId
    Store-->>Host: The same completed outcome
```

Key fields from the demo output are shown below; random identifiers, fingerprints, and timestamps are omitted from the table:

| Stage | Output field | Actual value | Meaning |
| --- | --- | --- | --- |
| Preview | `preview.candidate.name` | `Synthetic notes` | Synthetic MCP configuration |
| Preview | `preview.candidate.env.NOTES_TOKEN` | `[REDACTED]` | Original credentials stay out of the public view |
| Preview | `preview.requiresConfirmation` | `true` | Explicit consent is required before saving |
| Preview | `preview.willWrite` / `preview.willExecute` | `false` / `false` | Preview neither writes nor executes |
| After save | `saved.value.version` | `1` | The host saved the first configuration version |
| Reopened store | `afterRestart.value.version` | `1` | Look up the existing receipt instead of writing again |

Declining consent never calls save. Changed content, expired previews, or missing risk acknowledgement cannot authorize saving through the old preview. See the [host integration guide](./docs/host-integration.md) for the integration contract and production storage boundaries.

## Integration

```js
import { ImportApprovalGate } from './src/index.js';

const gate = new ImportApprovalGate({
  ttlMs: 5 * 60_000,
  recordDecision: async decision => auditStore.append(decision),
});

// Build this in trusted host code after safely fetching pinned content.
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

const scope = JSON.stringify([authenticatedUser.id, workspace.id]);
const preview = gate.preview(draft, { scope });

// Send only the redacted preview to the UI; retain the draft on the host.
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

Authentication, CSRF protection, audit storage, content fetching, and atomic persistence belong to the host application. A model-generated `confirmed: true` is not human consent.

The snippet depends on host-provided identity, audit, and storage services. The [host adapter](./examples/host-adapter.js) and [single-process file store](./examples/host-store.js) demonstrate how they fit together; the reference store is not a production database.

## Safety Contract

Every preview contains these literal values:

```json
{
  "requiresConfirmation": true,
  "willWrite": false,
  "willExecute": false
}
```

Approval binds to the normalized candidate, source URL and pinned revision, destinations and file contents, structured command descriptions, hidden environment and header values, user/workspace scope, preview lifetime, and one-time state. Any meaningful change invalidates the old approval.

The save callback receives the frozen original candidate, not an object reconstructed from the public preview.

## Public API

| Operation | Purpose |
| --- | --- |
| `discoveryCandidate(input)` | Validate discovery metadata only; never fetch content or construct commands. |
| `new ImportApprovalGate(options?)` | Create a bounded in-memory approval registry. |
| `gate.preview(candidate, { scope })` | Create a frozen redacted preview and content fingerprint. |
| `gate.confirmAndSave(request, save, { signal }?)` | Verify consent, content, scope, expiry, and risk acknowledgement before one save, with cooperative cancellation. |
| `gate.status(previewId, { scope })` | Read the current approval state. |
| `gate.revoke(previewId, { scope })` | Revoke a pending approval. |

Candidates may be multi-file text Skills or MCP configurations with structured stdio commands or HTTP/SSE endpoints. Unknown fields, accessors, cycles, prototype keys, oversized values, and unsafe portable destinations are rejected.

## Redaction and Risk Findings

Public previews hide environment and header values, URL query values and fragments, common credential arguments, bearer values, and credential-like file contents. Empty required values appear as `[REQUIRED]`.

Risk findings cover command declarations, shell or inline-code execution, remote-script pipes, destructive commands, lifecycle scripts, privilege changes, and executable-looking resources. Every external import starts at least at `medium`; `high` requires an additional acknowledgement but still does not authorize execution.

Redaction is a conservative defense, not a complete secret scanner or malicious-code detector. Always render imported content as text, never as trusted HTML.

Redaction matches original text only, never its generated placeholders. Candidates are limited to 512 KiB, each redacted field to 256 KiB, and the complete preview to 1 MiB, with an additional scan-work budget. Over-budget previews are rejected, not truncated into approvable packages. A warning appears when short secrets may also obscure source or command text.

## State Model and Host Responsibilities

```text
pending → confirming → saving → saved
   │           │           └→ failed / save_unknown
   │           ├→ expired / revoked / failed
   └→ expired / revoked
```

Concurrent confirmations cannot invoke the save callback twice. A failed save consumes the approval because a partial write may have occurred; there is no automatic retry or rollback.

Audit waiting defaults to 10 seconds and is also bounded by the remaining preview lifetime. Saving defaults to 30 seconds. Configure `recordTimeoutMs` / `saveTimeoutMs` as needed. An audit timeout never starts saving; timeout or cancellation after saving starts returns `save_unknown`, requiring host receipt lookup, not an assumption that nothing was written. Callbacks receive an `AbortSignal`, but must cooperate: the library cannot terminate blocking host code or undo writes.

Terminal states release the gate's original candidate; pending previews also release it on expiry. Small terminal records are pruned on the next preview. Caller-held views, callback-retained data, and on-disk storage are outside that cleanup boundary.

This library does not provide authentication, package discovery, SSRF protection, sandboxing, filesystem isolation, business-schema validation, immutable audit storage, or command execution. The host must pin the bytes shown in the preview, constrain network and destination access, save atomically, and authorize later MCP or script execution separately.

Approval state is process-local. Restarting requires a new preview; persisted audit records must never recreate live permission.

## Tests and Contributing

```bash
node --test
```

Tests use synthetic local fixtures and perform no network requests, model calls, package installation, or tool execution. Reproducible reports and security-boundary proposals are welcome in [Issues](https://github.com/liulinlin718-netizen/approval-first-import/issues).

## License

[MIT License](./LICENSE). This project was extracted from TAgent's separation of discovery, import preview, explicit confirmation, and execution authorization. See [NOTICE](./NOTICE) for provenance.
