import type { Redactor } from "../redact.js";
import type { Registry } from "../registry.js";
import type { Ctx, Drift, LockInfo, Plan, Receipt, ReceiptStore, ResolvedValue, ResourceDiff } from "../types.js";

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
  /** Poll for external events and locks instead of stopping. */
  wait?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  lockTtlMs?: number;
  /** Test hook: called after each line so a scenario can crash the process mid-run. */
  onLineDone?: (id: string, receipt: Receipt) => Promise<void> | void;
  now?: () => Date;
}

export type PlanLineStatus = "create" | "update" | "unchanged" | "pending" | "blocked" | "error";

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
  error?: string;
  errorCode?: string;
}

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

export interface ApplyResultSummary {
  receipt: Receipt;
  drift: Drift[];
  warnings: string[];
}
