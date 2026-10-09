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

import type { ErrorCode } from "./errors.js";

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

/**
 * `{ keep: true }` — whatever value the resource has live. Sponson manages that it exists and
 * who owns it, not its value. This is how adopted values enter a plan without being copied anywhere.
 */
export interface KeepRef {
  keep: true;
}

export type Literal = string | number | boolean;

export type ValueSpec = Literal | FromRef | SecretRef | KeepRef;

export function isFromRef(v: unknown): v is FromRef {
  return typeof v === "object" && v !== null && "from" in v && typeof (v as FromRef).from === "string";
}

export function isKeepRef(v: unknown): v is KeepRef {
  return typeof v === "object" && v !== null && "keep" in v && (v as KeepRef).keep === true;
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

export type ValueState = "literal" | "resolved" | "pending" | "secret" | "kept";

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
  /**
   * Stable key within the adapter and provider block, e.g. `env:preview:feat/x:DATABASE_URL`.
   * Must include every dimension that makes two resources distinct in the provider
   * (target, git branch, …): the ledger treats equal keys as the same resource.
   */
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

/**
 * One side of a diff, as data. Renderers turn it into text; JSON carries it as-is.
 * `value` is present only for non-sensitive literal values; everything else is described by state.
 */
export interface DiffSide {
  state: "literal" | "sensitive" | "pending" | "secret" | "absent";
  /** Non-sensitive value only. */
  value?: string;
  /** For pending/secret: the reference (`db.connection_string`, `env://KEY`). */
  ref?: string;
}

export interface ResourceDiff {
  key: string;
  kind: DiffKind;
  label: string;
  before?: DiffSide;
  after?: DiffSide;
}

export interface ApplyResult {
  /** Every resource this change now manages (not only the ones written in this call). */
  resources: ResourceRecord[];
  outputs: Record<string, Literal>;
  /** Keys of resources that did not exist before this apply. Must be a subset of what was passed to `intend`. */
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
  /**
   * Declare the keys about to be CREATED, before the write request is sent.
   * The engine persists the intent so a crash, a lost response or a failed call that
   * actually succeeded server-side is still recognised as Sponson's on the next run.
   * Updates of existing resources need no intent.
   */
  intend(keys: string[]): Promise<void>;
  /** Mask every known secret (in all its encodings). Call it on provider text BEFORE truncating it. */
  redact(text: string): string;
}

/**
 * One plan line proposed by `OpSpec.adopt`. The CLI adds `adapter`, `op` and `environments`, and makes `id` unique.
 */
export interface AdoptedLine {
  /** Suggested line id (made unique against the plan by the caller). */
  id: string;
  /** The line's params. Never a copied value: only references such as `{ keep: true }`, or identifying names. */
  params: Record<string, unknown>;
  /** Resource keys this line takes over. */
  keys: string[];
}

/**
 * The marker contract. After `resolveParams`, a param leaf that is not a concrete value is a marker string;
 * classify it with `markerKind(v)` from `@sponson/core` (never by inspecting the string):
 *
 *   "pending" — a `{ from: line.output }` not known yet. `diff` shows it as pending with its reference
 *               (`pendingRef(v)`); `apply` never receives one (the engine waits instead).
 *   "secret"  — a `{ secret: "scheme://…" }` whose value is not resolved in this command (plan). `diff`
 *               shows it as secret with its reference; `apply` never receives one (it gets the value).
 *   "keep"    — `{ keep: true }`: equal to whatever is live. `diff` reports it unchanged when the resource
 *               exists and PARAM_INVALID when it does not; `apply` leaves the live value alone.
 *   null      — a concrete value.
 *
 * `desiredSide`, `diffValue` and `assertNoPending` in `@sponson/adapters` implement this contract.
 */
export interface OpSpec {
  outputs: Record<string, OutputSpec>;
  /** Fill in defaults (e.g. a branch name) given the context. Returns a new params object. */
  defaults?(params: ResolvedParams, ctx: Ctx): ResolvedParams;
  /**
   * The deployment environment this change writes to, when the op targets one explicitly
   * (Vercel env `target`). The engine requires approval when any line writes to `production`,
   * whatever the run's environment is. Return null when the op is not environment-specific.
   */
  writesEnvironment?(params: ResolvedParams, ctx: Ctx): string | null;
  /** Find what currently exists for this change. Null when nothing exists. Must not write. */
  read(actx: AdapterContext, params: ResolvedParams): Promise<LiveState | null>;
  /** Compare live state against desired params. Must not write. Params may carry markers (see the marker contract above). */
  diff(live: LiveState | null, params: ResolvedParams): ResourceDiff[];
  /**
   * Create or update. Must be idempotent: calling with the same params twice performs no writes the second time.
   * Params never carry pending or secret markers here; `{ keep: true }` markers mean "leave the live value".
   */
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
   * List every resource this change could plausibly own, for drift and adoption.
   * E.g. all env vars in the project's preview target, branch-scoped and project-wide.
   * The engine removes everything any scope's ledger already manages.
   */
  listScope?(actx: AdapterContext, params: ResolvedParams): Promise<ResourceRecord[]>;
  /**
   * Turn unmanaged resources that this op's `listScope` reported into plan lines (`sponson init`).
   * Values are never copied into the plan: Vercel env vars become `{ keep: true }`, grouped into one
   * line per (target, git branch), with `branch: "*"` for project-wide ones; a Neon branch becomes a
   * line with its `name:`; a Clerk redirect a line with its `url:`. Every given key must be in exactly
   * one returned line. Pure: no provider calls.
   */
  adopt?(resources: Array<Pick<ResourceRecord, "key" | "label"> & { id?: string }>, ctx: Ctx): AdoptedLine[];
}

export interface ResourceAdapter {
  name: string;
  ops: Record<string, OpSpec>;
}

export interface SecretSource {
  /** URL scheme, e.g. `env`, `doppler`, `op`. */
  scheme: string;
  /** Resolve the value. Called by every command so the value can be registered for redaction; only apply sends it anywhere. */
  resolve(ref: string, env: NodeJS.ProcessEnv): Promise<string>;
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
  | "destroy_failed"
  | "blocked";

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
  errorCode?: ErrorCode;
  notes?: Record<string, unknown>;
  /** Carried over from a previous receipt; the plan no longer has this line. */
  orphan?: boolean;
}

/**
 * The ledger: every resource Sponson knows about in this environment+scope, keyed by identity,
 * independent of plan lines and carried forward across runs whatever a run's outcome.
 */
export interface LedgerEntry {
  adapter: string;
  op: string;
  /** The provider block (project, team) the resource lives in; destroy uses this, not the current plan. */
  provider: Record<string, unknown>;
  key: string;
  id: string;
  /** Keyed hash of the value we last wrote or accepted; see Receipt.hashKey. */
  hash: string;
  label?: string;
  /**
   * sponson: created by Sponson, destroyed with the scope.
   * adopted: existed before, never destroyed.
   * intent: Sponson was about to create it; claimed as sponson if found live, dropped if not.
   */
  createdBy: "sponson" | "adopted" | "intent";
  /** Line that declares (or last declared) this resource. */
  line: string;
  /** True when no line of the current plan declares it any more; kept until destroy. */
  orphan?: boolean;
  /** Non-sensitive outputs last seen for the owning line (including external ones like preview_url). */
  outputs?: Record<string, Literal>;
}

export interface Receipt {
  version: 2;
  runId: string;
  environment: string;
  scope: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  plan: { hash: string; path?: string };
  ctx: Ctx;
  /** What this run did, per plan line. */
  lines: Record<string, ReceiptLine>;
  /** What Sponson manages after this run. */
  ledger: LedgerEntry[];
  /** Commits applied to this scope, oldest first; a run for an older one is stale. */
  history: Array<{ sha: string; at: string }>;
  /** Random per-scope key for value hashes, so low-entropy secrets cannot be looked up from a receipt. */
  hashKey: string;
  /** Who approved this run, when approval was required. */
  approvedBy?: string;
  /** Set when this run was a destroy. */
  destroy?: boolean;
  /** Set when this run was skipped because a newer commit was already applied. */
  stale?: boolean;
  /** Set when a lock was preempted from a crashed run. */
  lockPreempted?: string;
  /** Set on a branch scope whose resources a pull request scope took over. */
  supersededBy?: string;
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
  /**
   * Write the receipt. When `holder` is given the write is fenced: it fails with LockLostError
   * unless `holder` still holds the scope's lock at the moment of writing.
   */
  write(receipt: Receipt, opts?: { holder?: string }): Promise<void>;
  list(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>>;
  /** Returns the preempted lock when an expired lock was taken over. Throws LockHeldError when held and not expired. */
  acquireLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<LockInfo | null>;
  /** Extend a lock we hold. Throws LockLostError when someone else holds it now. */
  renewLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<void>;
  /** Current lock, or null. Never throws for a missing/unreadable lock. */
  readLock(environment: string, scope: string): Promise<LockInfo | null>;
  releaseLock(environment: string, scope: string, holder: string): Promise<void>;
}

export class LockLostError extends Error {
  constructor(public readonly holder: string, public readonly current: LockInfo | null) {
    super(`Lock for this scope is no longer held by ${holder}${current ? ` (now ${current.holder})` : ""}`);
    this.name = "LockLostError";
  }
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
  /** For `unmanaged`: the op whose `listScope` reported it (the op that can adopt it). */
  op?: string;
  resource: { key: string; id?: string; label?: string };
  message: string;
  /** For `changed`: the live resource was replaced (different provider id), not just edited. */
  replaced?: boolean;
}
