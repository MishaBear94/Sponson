/**
 * Core domain types for Sponson.
 *
 * Vocabulary:
 *   Plan      — the parsed release.plan.yaml
 *   Change    — one line of the plan (one adapter op)
 *   Value     — a literal, a reference to another line's output, or a secret reference
 *   Resource  — one thing an adapter created or manages (an env var, a branch, a redirect URL)
 *   Receipt   — what actually happened the last time this scope was applied
 */

// ---------------------------------------------------------------------------
// Plan file
// ---------------------------------------------------------------------------

/** `{ from: "db.connection_string" }` — read another line's output. */
export interface FromRef {
  from: string;
}

/** `{ secret: "env://STRIPE_KEY" }` — resolved only inside apply, never written anywhere. */
export interface SecretRef {
  secret: string;
}

export type Literal = string | number | boolean;

export type ValueSpec = Literal | FromRef | SecretRef;

export function isFromRef(v: unknown): v is FromRef {
  return typeof v === "object" && v !== null && "from" in v && typeof (v as FromRef).from === "string";
}

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object" && v !== null && "secret" in v && typeof (v as SecretRef).secret === "string";
}

export interface Change {
  id: string;
  adapter: string;
  op: string;
  /** Environments this line applies to. Absent means all. */
  environments?: string[];
  /** Explicit ordering when there is no data dependency. */
  depends_on?: string[];
  /** Adapter-specific parameters. Any nested value may be a ValueSpec. */
  params: Record<string, unknown>;
}

export interface Plan {
  version: 1;
  /** Declared environments. Used to validate `--env`. */
  environments: string[];
  /** Per-adapter static configuration (project ids, team ids). */
  providers: Record<string, Record<string, unknown>>;
  /** Which receipt store to use. */
  receipts: "git-branch" | "local";
  changes: Change[];
  /** sha256 of the canonical file contents, for the receipt. */
  hash: string;
  /** Path the plan was loaded from, for messages. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

export interface Ctx {
  env: string;
  git: { branch: string; sha: string; short_sha: string };
  pr: { number: number | null };
  /** Derived lifecycle unit: `pr-42`, `branch-feat-x`, or `main`. */
  scope: string;
}

// ---------------------------------------------------------------------------
// Resolved values
// ---------------------------------------------------------------------------

export type ValueState = "literal" | "resolved" | "pending" | "secret";

export interface ResolvedValue {
  state: ValueState;
  /** null when pending or secret (or resolved but sensitive). */
  value: Literal | null;
  /** The reference string, when the value came from a `from:` or `secret:`. */
  ref?: string;
  /** True when the value is known but must never be displayed. */
  sensitive?: boolean;
  /** The id of the line this value depends on, when `from:`. */
  dependsOn?: string;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface OutputSpec {
  /** immediate: known once this line is applied. external: known only after an event the adapter can observe. */
  available: "immediate" | "external";
  /** Name of the external event, for messages (e.g. "deploy"). */
  event?: string;
  /** Sensitive outputs are never displayed, logged, or written to receipts. */
  sensitive?: boolean;
}

/** One concrete thing in the provider. */
export interface ResourceRecord {
  /** Stable key within the adapter+target scope, e.g. `env:preview:DATABASE_URL`. */
  key: string;
  /** Provider-side identifier used to update or delete it. */
  id: string;
  /** sha256 of the current value, or of a canonical representation. */
  hash: string;
  /** Human label for display. */
  label?: string;
  /** Set in receipts: whether Sponson created it (safe to destroy) or found it (never destroyed). */
  createdBy?: "sponson" | "adopted";
}

export interface LiveState {
  resources: ResourceRecord[];
  /** Outputs derivable from live state right now. Sensitive ones are still returned here; the engine masks them. */
  outputs: Record<string, Literal>;
}

export type DiffKind = "create" | "update" | "unchanged";

export interface ResourceDiff {
  key: string;
  kind: DiffKind;
  label: string;
  /** Display-safe before/after. Sensitive values are already masked. */
  before?: string;
  after?: string;
}

export interface ApplyResult {
  resources: ResourceRecord[];
  outputs: Record<string, Literal>;
  /** Keys of resources that did not exist before this apply (rollback deletes only these). */
  created: string[];
  /** Adapter-specific notes written into the receipt (e.g. `redeployed: true`). */
  notes?: Record<string, unknown>;
}

/** Parameters after every ValueSpec has been replaced with its concrete value. */
export type ResolvedParams = Record<string, unknown>;

export interface AdapterContext {
  ctx: Ctx;
  /** The `providers.<adapter>` block of the plan. */
  provider: Record<string, unknown>;
  /** Process environment, for tokens and base URLs. */
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

export interface OpSpec {
  outputs: Record<string, OutputSpec>;
  /** Fill in defaults (e.g. a branch name) given the context. Returns a new params object. */
  defaults?(params: ResolvedParams, ctx: Ctx): ResolvedParams;
  /** Find what currently exists for this change. Null when nothing exists. Must not write. */
  read(actx: AdapterContext, params: ResolvedParams): Promise<LiveState | null>;
  /** Compare live state against desired params. Must not write. */
  diff(live: LiveState | null, params: ResolvedParams): ResourceDiff[];
  /** Create or update. Must be idempotent: calling with the same params twice performs no writes the second time. */
  apply(actx: AdapterContext, params: ResolvedParams, live: LiveState | null): Promise<ApplyResult>;
  /** Delete the given resources. A resource that is already gone is a success, not an error. */
  destroy(actx: AdapterContext, resources: ResourceRecord[]): Promise<void>;
  /**
   * For ops with external outputs: check whether the event has happened.
   * Returns the outputs when available, null when still waiting.
   * Throws when the event failed permanently (e.g. the deployment errored).
   */
  awaitExternal?(actx: AdapterContext, params: ResolvedParams, live: LiveState): Promise<Record<string, Literal> | null>;
  /**
   * List every resource in the same target scope as this change, for drift detection.
   * E.g. all env vars in the Vercel project's preview target.
   */
  listScope?(actx: AdapterContext, params: ResolvedParams): Promise<ResourceRecord[]>;
}

export interface ResourceAdapter {
  name: string;
  ops: Record<string, OpSpec>;
}

export interface SecretSource {
  /** URL scheme, e.g. `env`, `doppler`, `op`. */
  scheme: string;
  /** Resolve the value. Called only inside apply. */
  resolve(ref: string, env: NodeJS.ProcessEnv): Promise<string>;
  /** A version or hash that changes when the value changes, without exposing it. */
  fingerprint(ref: string, env: NodeJS.ProcessEnv): Promise<string>;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export type LineStatus =
  | "applied"
  | "unchanged"
  | "waiting"
  | "failed"
  | "rolled_back"
  | "rollback_failed"
  | "skipped"
  | "destroyed"
  | "destroy_failed";

export type RunStatus = "complete" | "partial" | "failed";

export interface ReceiptLine {
  id: string;
  adapter: string;
  op: string;
  status: LineStatus;
  /** sponson: created by a Sponson apply and safe to destroy. adopted: existed before; never destroyed. */
  createdBy: "sponson" | "adopted";
  resources: ResourceRecord[];
  /** Non-sensitive outputs, for display and for agents. */
  outputs: Record<string, Literal>;
  /** Fingerprints of secret inputs at apply time, keyed by the reference string. */
  secretFingerprints?: Record<string, string>;
  waitingFor?: string;
  error?: string;
  /** Stable code when the error was a SponsonError (e.g. DRIFT_CHANGED), so agents can branch without parsing prose. */
  errorCode?: string;
  notes?: Record<string, unknown>;
  /** Carried over from a previous receipt; the plan no longer has this line. */
  orphan?: boolean;
}

export interface Receipt {
  version: 1;
  runId: string;
  environment: string;
  scope: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  plan: { hash: string; path?: string };
  ctx: Ctx;
  lines: Record<string, ReceiptLine>;
  /** Set when this run was a destroy. */
  destroy?: boolean;
  /** Set when a lock was preempted from a crashed run. */
  lockPreempted?: string;
}

export interface LockInfo {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ReceiptStore {
  readonly kind: string;
  /** Latest receipt for this environment+scope, or null. */
  read(environment: string, scope: string): Promise<Receipt | null>;
  write(receipt: Receipt): Promise<void>;
  list(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>>;
  /** Returns the preempted lock when an expired lock was taken over. Throws LockHeldError when held and not expired. */
  acquireLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<LockInfo | null>;
  releaseLock(environment: string, scope: string, holder: string): Promise<void>;
}

export class LockHeldError extends Error {
  constructor(public readonly lock: LockInfo) {
    super(`Scope is locked by ${lock.holder} until ${lock.expiresAt}`);
    this.name = "LockHeldError";
  }
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type DriftKind = "unmanaged" | "changed" | "missing" | "orphan";

export interface Drift {
  kind: DriftKind;
  adapter: string;
  /** Line id when known. */
  line?: string;
  resource: { key: string; id?: string; label?: string };
  message: string;
}
