export type ImportKind = 'skill' | 'mcp';
export type ApprovalStatus = 'pending' | 'confirming' | 'saving' | 'saved' | 'failed' | 'expired' | 'revoked';
export interface CommandDescription { executable: string; args?: string[] }
export interface ImportCandidate {
  kind: ImportKind;
  name: string;
  source: { url: string; revision?: string };
  /** Portable relative target label. The library does not resolve or write paths. */
  destination: string;
  files?: Array<{ path: string; content: string }>;
  commands?: CommandDescription[];
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
  transport?: 'stdio' | 'http' | 'sse';
  endpoint?: string;
}
export type DeepReadonly<T> = T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export interface NormalizedCandidate extends ImportCandidate {
  files: Array<{ path: string; content: string }>;
  commands: Array<{ executable: string; args: string[] }>;
  env: Record<string, string | null>;
  headers: Record<string, string | null>;
}
export interface PreviewSafety { requiresConfirmation: true; willWrite: false; willExecute: false }
export interface ImportPreview extends PreviewSafety {
  version: 1;
  previewId: string;
  /** Opaque, keyed content digest. Stable only within this gate instance. */
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  /** Redacted display data. Never submit this as the original candidate. */
  candidate: NormalizedCandidate;
  risk: { level: 'medium' | 'high'; findings: Array<{ code: string; level: 'medium' | 'high'; message: string }>; disclaimer: string };
}
export interface Decision {
  previewId: string; fingerprint: string; scope: string; action: 'save_configuration';
  confirmedAt: number; expiresAt: number; acknowledgeHighRisk: boolean; willExecute: false;
}
export interface Confirmation {
  previewId: string; fingerprint: string; scope: string; confirmed: true;
  acknowledgeHighRisk?: boolean;
  /** Current unredacted draft, supplied by the trusted host. */
  candidate: ImportCandidate;
}
export interface SaveReceipt<T> { readonly previewId: string; readonly fingerprint: string; readonly status: 'saved'; readonly willExecute: false; readonly value: T }
export class ApprovalError extends Error { readonly code: string; constructor(code: string, message: string) }
export class ImportApprovalGate {
  constructor(options?: { now?: () => number; ttlMs?: number; maxEntries?: number;
    /** Host-owned durable audit hook. A failure prevents calling save. */
    recordDecision?: (decision: DeepReadonly<Decision>) => void | Promise<void> });
  preview(candidate: ImportCandidate, context: { scope: string }): DeepReadonly<ImportPreview>;
  status(previewId: string, context: { scope: string }): ApprovalStatus;
  revoke(previewId: string, context: { scope: string }): void;
  confirmAndSave<T>(request: Confirmation,
    save: (candidate: DeepReadonly<NormalizedCandidate>, decision: DeepReadonly<Decision>) => T | Promise<T>): Promise<SaveReceipt<T>>;
}
export function discoveryCandidate(input: { name: string; kind: ImportKind; url: string; provider: string }):
  DeepReadonly<{ name: string; kind: ImportKind; url: string; provider: string; phase: 'discovery' } & PreviewSafety>;
