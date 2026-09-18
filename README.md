# Approval-First Import

A small, zero-dependency Node.js library for **reviewing a Skill/MCP import before saving its configuration**.

[Source repository](https://github.com/liulinlin718-netizen/approval-first-import) | [Issue tracker](https://github.com/liulinlin718-netizen/approval-first-import/issues)

An import button should not silently turn a search result into an installation. This package gives application authors a bounded approval gate with redacted previews, content binding, expiration and single-use confirmation. It does not download packages or execute commands.

```text
Discovery metadata -> Host fetches a pinned draft -> Redacted preview
                                                     |
                                             Explicit confirmation
                                                     |
                                  Same content + same scope + not expired?
                                                     |
                                    Host records decision, then saves

Running the imported tool is a separate operation and authorization.
```

## Run locally

Node.js 22 or later. No installation, model key, network access or build step is needed:

```sh
git clone https://github.com/liulinlin718-netizen/approval-first-import.git
cd approval-first-import
node --test
node bin/approval-first-import.js demo
node bin/approval-first-import.js preview examples/skill.json
node bin/approval-first-import.js preview examples/mcp-high-risk.json
```

The demo uses synthetic credentials and an in-memory save callback. The CLI only prints JSON; it has no install, confirm, shell or save command. A CLI preview cannot be confirmed in a later process. Use the library inside your application's trusted backend for that workflow.

This directory is self-contained and can be extracted without the TAgent workspace. It includes ESM exports, TypeScript declarations, MIT licensing and Node built-in tests. It has **not** been published to npm.

## Small integration

```js
import { ImportApprovalGate } from './src/index.js';

const gate = new ImportApprovalGate({
  ttlMs: 5 * 60_000,
  // Optional durable audit hook. A rejection prevents the save callback.
  recordDecision: async decision => auditStore.append(decision),
});

// Both scope and draft are derived by the trusted host, not the model.
const scope = `${authenticatedUser.id}:${workspace.id}`;
const draft = {
  kind: 'mcp',
  name: 'Notes',
  source: { url: 'https://example.org/notes', revision: 'pinned-revision' },
  destination: 'config/notes.json',
  transport: 'stdio',
  commands: [{ executable: 'node', args: ['notes-server.mjs'] }],
  env: { NOTES_TOKEN: 'user-supplied-value' },
};
const preview = gate.preview(draft, { scope });
// Return preview to your UI. Show files, commands, destinations and risk findings.
// Keep the unredacted draft on the host; do not reconstruct it from the preview.

// In a separate, authenticated user-confirmation handler:
const receipt = await gate.confirmAndSave({
  previewId: preview.previewId,
  fingerprint: preview.fingerprint,
  scope,
  candidate: currentDraft,       // The current host-owned draft, including secrets.
  confirmed: userForm.confirmed === true,
  acknowledgeHighRisk: userForm.acknowledgeHighRisk === true,
}, async (approved, decision) => {
  // Application-supplied, save-only operation; never pass this data to a shell.
  return configStore.saveAtomically(decision.previewId, approved);
});
```

`auditStore`, authentication, forms and `configStore` above are host application services, not included globals. The runnable CLI demo shows the same flow without these services. A model-generated `confirmed: true` is **not** human consent: only your authenticated user action should reach this handler. Protect it against CSRF where applicable.

The callback receives the frozen, normalized original candidate, not an object submitted after an asynchronous wait. Any meaningful change to the current draft, including hidden environment values, source revision, file contents or destination, invalidates the old approval. Object key order, omitted empty collections and surrounding name whitespace are normalized.

## API

| Operation | Responsibility |
| --- | --- |
| `discoveryCandidate({name, kind, url, provider})` | Validates metadata only. Does not search, construct commands or make a draft. |
| `new ImportApprovalGate(options?)` | Creates a bounded in-memory approval registry. |
| `gate.preview(candidate, {scope})` | Produces a frozen redacted view and opaque content fingerprint; no writes. |
| `gate.confirmAndSave(request, save)` | Validates explicit consent, scope, content, risk acknowledgement and expiry; then invokes the host callback once. |
| `gate.status(previewId, {scope})` | Reports current state within this gate instance. |
| `gate.revoke(previewId, {scope})` | Revokes a pending confirmation, including one awaiting the audit hook. |

Every preview has these literal values:

```json
{ "requiresConfirmation": true, "willWrite": false, "willExecute": false }
```

Commands use structured `executable` and `args` descriptions. There is no executable shell command string API. Skill imports support multiple text files. MCP imports support `stdio` descriptions or HTTP/SSE endpoint configuration. Unknown fields, accessors, cycles and prototype keys are rejected rather than silently discarded.

Defaults: a 5-minute TTL, at most 64 active entries, at most 512 KiB input, 64 text files, 128 KiB per file and 16 command descriptions. Maximum configurable TTL is one hour. There is no truncated-preview approval path; oversized input is rejected. Binary archives and arbitrary MCP configuration schemas are outside this package.

States:

```text
pending -> confirming -> saving -> saved
   |           |            |
expired     expired        failed
revoked     revoked
            failed (decision could not be recorded)
```

Concurrent confirmations cannot call the host twice. A failed save consumes the approval because it may have partially written. There is no automatic retry or rollback. Expiry/revocation is checked again after the audit hook and before saving. Once a save callback has started, expiration cannot undo it.

Common `ApprovalError.code` values: `invalid_input`, `invalid_scope`, `capacity`, `not_found`, `confirmation_required`, `content_changed`, `risk_acknowledgement_required`, `expired`, `consumed`, `revoked`, `record_failed`, `save_failed`.

## Redaction and risk

- All environment/header values are hidden, not only those named `TOKEN`. Empty/null values display `[REQUIRED]`.
- URL query values/fragments, known secret argument values, common inline credential assignments, bearer values and credential-like files are hidden. Preview URLs are display data; keep original URLs separately on the host.
- Fingerprints are keyed HMACs scoped to the gate instance and user/workspace scope. They are not portable public hashes of low-entropy secrets and are not execution tokens.
- Risk checks warn about shell/inline code, remote script pipes, destructive commands, lifecycle scripts, privilege changes and executable-looking resources.
- All external content starts at `medium`, not a green "safe" label. `high` requires an additional acknowledgement, but does **not** grant permission to run anything.
- General secret detection and malicious-code detection are unsolved here. Unlabelled or encoded secrets may remain in arbitrary file text; do not feed real production secrets into untrusted package material or log raw drafts. Render all imported text as text, never HTML.

## Explicit limits

This library is a confirmation contract, **not** authentication, package discovery, an SSRF guard, a sandbox, a filesystem jail, a code verifier or an immutable audit ledger. It does not verify that a claimed revision exists. The host must fetch safely, pin and retain the exact downloaded bytes before preview, validate package schemas, and keep external instructions separate from application authority. Do not refetch mutable remote content after approval.

Portable relative destinations reject common traversal and Windows device names, but the host must map them under its own allowed root, resolve symlinks safely, use atomic storage and make the callback idempotent. The callback is trusted code and must not execute shell commands or activate the saved MCP configuration.

Approval records are process-local. Restarting loses all approvals, which requires a new preview. Terminal entries are retired when another preview is created; this is not a history database. For multiple workers, put requests on one owner or implement transactional shared storage before using this contract across processes. Persisted confirmation audit records alone must never recreate a live permission.

No test performs a model call, network request, package install, email operation or tool command. Synthetic fixtures cover content/credential changes, duplicate confirmation, audit/save failure, expiry during persistence, cancellation, input bounds, path validation, redaction and CLI preview behavior.

## Origin

Extracted from TAgent's separation of Skill/MCP discovery, import preview and explicit approvals. This standalone implementation has no TAgent runtime dependency. See [NOTICE](./NOTICE) for provenance and [LICENSE](./LICENSE) for the MIT license; this license does not relicense imported third-party packages or the rest of TAgent.
