# Host Integration Reference

This example keeps Approval-First Import a small approval library. It adds no login system, server framework, package downloader, model client, installer, or execution engine.

## Run Offline

```bash
node examples/host-demo.js
node --test test/host.test.js
```

The demo writes **synthetic** configuration and audit/receipt data into a temporary directory beside the repository's README, prints only redacted previews and metadata receipts, then removes its own files. It never follows source URLs or runs the described `node notes.mjs` command. The separate preview CLI still does not write configurations.

## Host Flow

`examples/host-adapter.js` exposes four backend operations:

| Method | Responsibility |
| --- | --- |
| `prepare(context, candidate)` | Authenticate, validate the server-provided draft, capture target version, retain an independent original, return only a redacted preview and version. |
| `confirm(context, body, { signal }?)` | Reauthenticate, find the current server draft, verify explicit consent, audit, then compare-and-save. A prior matching receipt is returned without repeating the write. |
| `receipt(context, previewId)` | Reauthenticate and return this user's workspace-scoped receipt, or `null`. It never restores permission. |
| `close()` | Revoke retained pending/confirming approvals and release drafts. It cannot undo a started save. |

The confirmation body contains only `previewId`, `fingerprint`, `confirmed`, and optional `acknowledgeHighRisk`. The frontend must not send an original candidate, a masked candidate, a user ID, or a workspace scope. The backend obtains them from trusted state. Editing a draft calls `prepare` again and requires fresh human approval.

`authenticate(context)` defaults to denial. The example's `WeakMap` models a trusted session lookup; it is **not** a login mechanism. A real adapter must validate the session and workspace membership on every operation, including receipt queries. If using cookie-authenticated HTTP, enforce CSRF/origin checks, bounded JSON parsing, request rate limits, and body-schema validation before these methods. Do not map unverified request fields directly into identity.

`confirmed: true` in the demo is synthetic consent for a fixture. In an application it must come from the explicit human confirmation screen; model output or an automatic pipeline must not supply it.

## Save and Recover

`examples/host-store.js` is a bounded local-file reference store. It serializes writes in one process, stores a configuration version plus its `previewId` receipt in one JSON document, flushes a temporary file, then replaces `state.json` by rename. Source file names and declared destinations are labels in this document, not paths the example writes or executes.

Two previews prepared at version 0 cannot both silently overwrite that target: the first commit moves it to 1; the second returns `version_conflict`. The user must review a fresh preview at version 1 and confirm again. Different workspaces have different target keys. Targets use NFC and case folding consistently with the library's portable-path model.

If a save response is lost or times out, query `receipt(context, previewId)` first. A receipt proves this example committed that configuration and version. It survives reopening the file store, whereas the gate's pending approvals and process-keyed fingerprints do not. Returning an existing receipt is a read of a completed outcome, not replaying its save callback. An absent receipt while a write may still be running is **not** evidence that nothing was written.

For production, use a transaction that couples configuration version updates with a unique idempotency record. The local-file example has important limits:

- Exactly one store instance/process may own a directory at a time. No distributed locking, concurrent-process support, or cross-process cache invalidation is provided. Quiesce the old owner before reopening.
- Directory permissions/ACLs, filesystem trust, symlink restrictions, backup and crash recovery belong to the host. File flushing and rename do not promise power-loss durability on every platform/filesystem; there is no portable directory fsync guarantee here.
- `state.json` contains the original secret values. Protect it with host-managed ACLs and encryption/secret storage as appropriate. POSIX mode hints are not a Windows ACL policy. Never return the raw file to the frontend or commit it to git.
- Audit history is not tamper-evident or immutable. Audit failure denies saving but may itself leave a partial or late audit record. An audit entry alone is not a save receipt or an authorization after restart.
- The example stops at 16 MiB or 1,000 audit decisions. Do not silently delete receipts to evade capacity: archive with an explicit host retention/recovery policy.
- Store files are trusted host state, not an external import format. A real storage adapter should validate its persistent schema and handle corruption/migration before serving requests.

## Error Recovery

| Code | Safe next step |
| --- | --- |
| `unauthorized` / `not_found` | Reauthenticate or choose an authorized workspace. Do not reveal another scope's draft. |
| `confirmation_required` / `risk_acknowledgement_required` | Show the existing valid preview and request the missing human decision. |
| `expired` / `revoked` / `cancelled` | Create a fresh preview and obtain fresh approval. Audit-stage cancellation has not started saving. |
| `content_changed` / `version_conflict` | Review the changed candidate or target version and prepare a new preview. |
| `capacity` / `preview_too_large` / `preview_complexity` | Finish/revoke pending work or split the candidate, then preview again. Never truncate an approvable preview. |
| `record_failed` / `record_timeout` | Fix audit storage; saving did not start. Old confirmation is consumed. |
| `save_failed` | A write may be partial. Inspect receipt and storage, repair if necessary, then request fresh approval. |
| `save_unknown` | Save started but completion is unknown. Query receipts and reconcile storage before any new approval; do not retry the callback. |
| `consumed` | Query the host receipt/status. A used preview is not a fresh permit. |

All errors should remain understandable user-facing states, not a generic automatic-retry button. Never expose raw callback exceptions, credentials, or storage paths.

## Time and Resource Budgets

`recordTimeoutMs` defaults to 10,000 and is capped by remaining TTL; `saveTimeoutMs` defaults to 30,000. Both accept integer values from 1 through 3,600,000 milliseconds. A caller `AbortSignal` is supplied as the third `confirmAndSave` argument, not in its untrusted JSON body. The audit hook receives `(decision, { signal })`; the save hook receives `(candidate, decision, { signal })`. Existing callbacks ignoring extra arguments remain compatible.

Expiration, revocation, audit timeout, and audit cancellation cannot be reversed by a late callback. Save timeout/abort uses terminal `save_unknown`, not `failed` or `saved`. Timers/listeners are cleared after settlement; expired and terminal entries drop their original candidate and keep only small metadata until the next preview cleans them up. Pending expiration timers are unreferenced so they do not keep an idle Node process alive. Active wait timers remain referenced until settlement. No automatic retry occurs.

Timers cannot preempt synchronous CPU-bound callbacks, and cancellation cannot roll back an external side effect. Cooperating callbacks should check the signal before beginning each operation; the reference store checks again immediately before replacement. A late outcome can still occur, so durable idempotency receipts remain necessary. Host-retained callback references and copies are not securely erased by gate cleanup.

Candidate JSON is capped at 512 KiB; confirmation metadata is validated separately, and the candidate is normalized once per operation. Existing file/count/depth limits still apply. Redaction renders merged ranges from original text only, deduplicates known secret values, and caps a field at 256 KiB, the serialized preview at 1 MiB, marked ranges at 1,000,000, and known-value scan work at 64 Mi UTF-16 units (text length times unique values, across fields). Excess work fails closed. These are conservative processing limits, not an exhaustive secret scanner, a malware verdict, or a strict wall-clock SLA.

## Integration with Agent Applications

The example can replace repeated host approval plumbing: keep drafts on the server, bind identity/workspace scope, use target revisions, and expose a separate receipt query. It does not replace the application's URL-fetch safety, Skill/MCP schema validation, user confirmation UI, storage policy, or independent MCP activation authorization. Start with a single bounded import route and preserve these host responsibilities.

## 中文摘要

运行 `node examples/host-demo.js` 即可查看离线接入示例。原稿只保留在服务端；用户确认只提交预览标识、指纹和同意项。身份钩子默认拒绝，必须同时验证登录身份和工作区权限。文件示例通过单进程串行写入、目标版本检查和原子替换，把配置与回执一起保存；旧版本冲突要重新预览和确认。

响应丢失或 `save_unknown` 时先查回执，不能自动重放保存。示例存储包含原始密钥，不是加密保险箱、生产数据库或跨进程锁；宿主必须负责 ACL、CSRF、持久化与故障恢复。示例仅作为宿主接入参考，不执行导入命令。
