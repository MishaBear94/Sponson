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

/** A concrete param or output value. Outputs are always literals; anything richer is serialised by the adapter. */
export type Literal = string | number | boolean;

/** What a plan param may hold: a literal, or a reference resolved by the engine (`from`, `secret`, `keep`). */
export type ValueSpec = Literal | FromRef | SecretRef | KeepRef;

/** True for `{ from: "line.output" }`. Use the `is*Ref` guards rather than inspecting objects by hand. */
export function isFromRef(v: unknown): v is FromRef {
  return typeof v === "object" && v !== null && "from" in v && typeof v.from === "string";
}

/** True for `{ keep: true }`. */
export function isKeepRef(v: unknown): v is KeepRef {
  return typeof v === "object" && v !== null && "keep" in v && v.keep === true;
}

/** True for `{ secret: "scheme://..." }`. */
export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === "object" && v !== null && "secret" in v && typeof v.secret === "string";
}

/** One line of the plan: which adapter op to run, where, and with what params. `parsePlan` produces them. */
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

/** A parsed and validated `release.plan.yaml`. Get one from `loadPlan` or `parsePlan`; every run takes one. */
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

/**
 * Where a run happens: environment, commit and pull request, and the scope derived from them. Build it with
 * `detectCtx` (package `sponson`) or by hand with `scopeFor`.
 */
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

/** How a param value stands at plan time; see `ResolvedValue`. */
export type ValueState = "literal" | "resolved" | "pending" | "secret" | "kept";

/** One param as plan output shows it: its state, and its value only when it may be displayed. */
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

/** Declares one output of an op: when it becomes known, and whether it must never be shown. */
export interface OutputSpec {
  /** immediate: known once this line is applied. external: known only after an event the adapter can observe. */
  available: "immediate" | "external";
  /** Name of the external event, for messages (e.g. "deploy"). */
  event?: string;
  /** Sensitive outputs are never displayed, logged, or written to receipts. */
  sensitive?: boolean;
  /**
   * The provider reveals this value only in the response that creates the resource (a database password's
   * plaintext): `read` never returns it and Sponson never stores it, so declare it `sensitive` too. It reaches
   * dependent lines in the run that creates the resource. In any later run, a `from:` reference to it resolves to
   * `{ keep: true }`: a dependent that already holds the value keeps it, and one that would have to write it is
   * refused with OUTPUT_UNAVAILABLE instead of receiving an empty value. Nothing is ever re-created to get the value
   * back. See docs/adr/0017-once-only-outputs.md.
   */
  once?: boolean;
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
  /**
   * sha256 of the current value, or of a canonical representation. One hash per resource, and it must cover
   * every field the plan controls (`sha256(canonicalJson({ value, type }))` for two): the engine detects console
   * drift only by comparing it with the hash it recorded, so a field left out can change unnoticed. Ids, timestamps
   * and other provider bookkeeping stay out.
   *
   * The engine stores it (keyed) in the ledger. Changing what it covers is therefore a breaking change: every
   * existing ledger entry then disagrees with live state, which is accepted silently while the plan matches live
   * but reported as `changed` drift (apply refuses without `--reconcile`) as soon as the plan changes that
   * resource. Ship it with a `**Breaking:**` changeset telling users to run `sponson apply` once with an
   * unchanged plan after upgrading (that re-records every hash) before changing those lines.
   */
  hash: string;
  /** Human label for display. */
  label?: string;
  /** Set in receipts: whether Sponson created it (safe to destroy) or found it (never destroyed). */
  createdBy?: "sponson" | "adopted";
}

/** What `OpSpec.read` found in the provider for one line: its resources and the outputs derivable from them. */
export interface LiveState {
  resources: ResourceRecord[];
  /** Outputs derivable from live state right now. Sensitive ones are still returned here; the engine masks them. */
  outputs: Record<string, Literal>;
}

/** What apply would do to one resource. */
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

/**
 * One resource's difference between live and desired, as `OpSpec.diff` returns it. Data only; renderers format
 * it.
 */
export interface ResourceDiff {
  key: string;
  kind: DiffKind;
  label: string;
  before?: DiffSide;
  after?: DiffSide;
}

/** What `OpSpec.apply` returns: everything the line now manages, its outputs, and which keys it created. */
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

/**
 * What the engine hands every adapter call: the run context, the plan's provider block, the environment for
 * credentials, logging and redaction, and `intend` for crash-safe creates. Adapters name it `actx` by convention.
 */
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
  /**
   * Compare live state against desired params. Must not write. Params may carry markers (see the marker contract
   * above).
   *
   * Exactly one diff per resource the line manages, whatever the number of fields: `key` is the resource's
   * `ResourceRecord.key` (the ledger key) and `kind` is `update` when any field differs. Compare fields through the
   * same canonical form `ResourceRecord.hash` uses, so `diff` and drift detection agree on what "equal" means.
   * Resources with independent lifecycles (Vercel: one env var per target) are separate resources and diffs.
   */
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

/**
 * A provider integration: a name (the plan's `adapter:`) and its ops. Register it with `Registry.addAdapter`;
 * see `OpSpec` for the contract and `@sponson/core/testing` for a complete in-memory adapter.
 *
 * @example
 * ```ts
 * // `- { id: hello, adapter: memo, op: note, name: hello, value: world }` in a plan
 * const notes = new Map<string, { id: string; value: string }>();
 * const key = (params: ResolvedParams) => `note:${String(params.name)}`;
 *
 * export const memo: ResourceAdapter = {
 *   name: "memo",
 *   ops: {
 *     note: {
 *       outputs: { id: { available: "immediate" } },
 *       async read(_actx, params) {
 *         const n = notes.get(key(params));
 *         return n ? { resources: [{ key: key(params), id: n.id, hash: sha256(n.value) }], outputs: { id: n.id } } : null;
 *       },
 *       diff(live, params) {
 *         return [diffValue({ key: key(params), label: key(params), live: live?.resources[0], desired: params.value, sensitive: false })];
 *       },
 *       async apply(actx, params, live) {
 *         if (!live) await actx.intend([key(params)]); // always before a create
 *         const note = { id: live?.resources[0]?.id ?? `n${notes.size + 1}`, value: String(params.value) };
 *         notes.set(key(params), note);
 *         const resources = [{ key: key(params), id: note.id, hash: sha256(note.value) }];
 *         return { resources, outputs: { id: note.id }, created: live ? [] : [key(params)] };
 *       },
 *       async destroy(_actx, resources) {
 *         for (const r of resources) notes.delete(r.key);
 *       },
 *     },
 *   },
 * };
 * ```
 */
export interface ResourceAdapter {
  name: string;
  ops: Record<string, OpSpec>;
  /**
   * What a user must configure, declared once and used by the adapter's own code and by the generated
   * docs (docs/plan-format.md). Built-in adapters must set it; plugins should.
   */
  about?: AdapterAbout;
}

/** The environment an adapter reads: its credential, and the variable that overrides its API base URL. */
export interface AdapterAbout {
  /** Environment variable holding the credential, e.g. `NEON_API_KEY`. */
  credentialEnv: string;
  /** Environment variable that overrides the API base URL (the sim and tests use it), when there is one. */
  baseUrlEnv?: string;
  /** Further variables the credential needs, when one is not enough (PlanetScale: the service token's id). */
  extraCredentialEnv?: readonly string[];
}

/**
 * Resolves `{ secret: "<scheme>://..." }` references. Register one with `Registry.addSecretSource` to support a
 * new secret manager.
 */
export interface SecretSource {
  /** URL scheme (the part before `://`). */
  scheme: string;
  /** The reference form users write, for docs, e.g. "`env://NAME`". Built-in sources must set it. */
  form?: string;
  /** How a reference is resolved, for docs (which CLI or API, where configuration comes from). */
  resolvedBy?: string;
  /**
   * Resolve the value. Called by every command so the value can be registered for redaction; only apply sends it anywhere.
   * Throw a reason only ("the `aws` CLI is not installed or not on PATH"); the engine prefixes the reference once,
   * and the message must never contain the value.
   */
  resolve(ref: string, env: NodeJS.ProcessEnv): Promise<string>;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** What a run did to one line, as recorded in its receipt. */
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

/** Outcome of a whole run: `partial` means lines wait on an external event (a deploy), not that anything failed. */
export type RunStatus = "complete" | "partial" | "failed";

/** One line of a receipt: what the run did to it, the resources it manages and its public outputs. */
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

/**
 * The record of one run for an environment and scope, and the ledger it leaves behind. Stores persist it; agents
 * read it to learn what actually happened.
 */
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

/** The scope lock as stored: who holds it and until when. */
export interface LockInfo {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

/**
 * Where receipts and scope locks live. Implement it to keep receipts somewhere other than a git branch or a
 * directory; `scenarios/` and `receipts/stores.test.ts` show the behaviour each method must have.
 */
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
  /** Release what the store holds locally (a temporary working clone). Whoever constructed the store calls it once done. */
  close?(): Promise<void>;
}

/** Thrown by a store when a fenced write or renewal finds the lock held by someone else (or gone). */
export class LockLostError extends Error {
  constructor(public readonly holder: string, public readonly current: LockInfo | null) {
    super(`Lock for this scope is no longer held by ${holder}${current ? ` (now ${current.holder})` : ""}`);
    this.name = "LockLostError";
  }
}

/** Thrown by `acquireLock` when another holder's lock has not expired. */
export class LockHeldError extends Error {
  constructor(public readonly lock: LockInfo) {
    super(`Scope is locked by ${lock.holder} until ${lock.expiresAt}`);
    this.name = "LockHeldError";
  }
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * How live state departs from what Sponson recorded: an unknown resource, a changed or missing one, or one no
 * line declares any more.
 */
export type DriftKind = "unmanaged" | "changed" | "missing" | "orphan";

/** One finding of drift, reported by plan and apply. `unmanaged` findings are what `sponson init` can adopt. */
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
