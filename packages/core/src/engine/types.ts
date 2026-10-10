import type { ErrorCode } from "../errors.js";
import type { Redactor } from "../redact.js";
import type { AncestryCheck } from "./history.js";
import type { Registry } from "../registry.js";
import type { Ctx, Drift, LockInfo, Plan, Receipt, ReceiptStore, ResolvedValue, ResourceDiff } from "../types.js";

/** Everything a `planRun`, `applyRun` or `destroyRun` needs. Only the first four are required. */
export interface RunOptions {
  plan: Plan;
  ctx: Ctx;
  registry: Registry;
  store: ReceiptStore;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  redactor?: Redactor;
  /** Required whenever the run can write to `production`. */
  approvedBy?: string;
  /** Overwrite values changed outside Sponson. `plan` uses it to predict what apply will do. */
  reconcile?: boolean;
  /**
   * Lines whose resources to delete and create again in this run, so the `once` outputs (ADR 0018) only a create
   * returns reach their dependents. Only resources Sponson created in this scope are ever deleted; a recreated
   * resource replaces one that existed, so rollback does not remove it.
   */
  recreate?: string[];
  /**
   * Manual steps (ADR 0021) a person says are done: apply records them as done, and `apply --destroy` forgets them
   * once their `undo` is done. Only lines of manual ops may be named. Never set by an agent on its own.
   */
  confirm?: string[];
  /** Who confirms the `confirm` steps (a person's name or email), recorded in the ledger. Required with `confirm`. */
  confirmedBy?: string;
  /** Poll for external events and locks instead of stopping. */
  wait?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  lockTtlMs?: number;
  /** Lets a run recognise a never-applied commit that is older than the last applied one. */
  isAncestor?: AncestryCheck;
  /** Test hook: called after each line so a scenario can crash the process mid-run. */
  onLineDone?: (id: string, receipt: Receipt) => Promise<void> | void;
  now?: () => Date;
}

/**
 * What apply would do to a line: write it (`create`/`update`), nothing, wait for it, or refuse it; `todo` is a
 * manual step a person still has to do (ADR 0021).
 */
export type PlanLineStatus = "create" | "update" | "unchanged" | "pending" | "todo" | "blocked" | "error";

/** A manual step as plan and apply show it to the person who must do it (ADR 0021). */
export interface ManualTodo {
  line: string;
  title: string;
  /** `do`: the step's instructions; `undo`: its undo instructions (destroy). */
  action: "do" | "undo";
  instructions: string;
  /** Whether a verify request can see it done (then confirming is not needed once it is). */
  observable: boolean;
}

/** One line of a plan result. */
export interface PlanLine {
  id: string;
  adapter: string;
  op: string;
  /**
   * blocked: apply would refuse this line (errorCode says why, e.g. DRIFT_CHANGED,
   * OWNED_BY_OTHER_SCOPE) or a line it depends on is in error/blocked.
   */
  status: PlanLineStatus;
  diffs: ResourceDiff[];
  inputs: Record<string, ResolvedValue>;
  /** Outputs known right now. Sensitive outputs are present as null, never as text. */
  outputs: Record<string, string | number | boolean | null>;
  /** Line this one waits on, and the external event when that is what it waits for (e.g. "deploy"). */
  waitingOn?: string;
  waitingFor?: string;
  /** For `todo` lines: what the person must do. */
  manual?: ManualTodo;
  error?: string;
  errorCode?: ErrorCode;
}

/** What `planRun` returns: one entry per active line, scope-wide drift, and whether applying needs approval. */
export interface PlanResult {
  environment: string;
  scope: string;
  planHash: string;
  lines: PlanLine[];
  drift: Drift[];
  warnings: string[];
  previous: Receipt | null;
  /** A run currently holding this scope's lock; plan output describes a moving target while set. */
  lock: LockInfo | null;
  /** Approval is required to apply: --env production, or a line writes to production. */
  requiresApproval: boolean;
}

/** What `applyRun` and `destroyRun` return: the receipt they wrote, drift seen on the way, and warnings for humans. */
export interface ApplyResultSummary {
  receipt: Receipt;
  drift: Drift[];
  warnings: string[];
  /** Manual steps this run left for a person to do (or undo), in plan order (ADR 0021). Absent when none. */
  manual?: ManualTodo[];
}
