/**
 * One-off actions (ADR 0022): lines that send one request when their trigger changes (an Inngest sync for a new
 * deployment, a cache purge, a deploy notification), with nothing at the provider to read back or delete. The op
 * describes the trigger (`OpSpec.action`); the engine owns the line's state:
 *
 * - the ledger entry `action:<line id>` records the keyed hash of the last trigger that ran, how to undo it (the
 *   record id) and its outputs; `plan` shows `run` when no run of the current trigger is recorded, `unchanged`
 *   otherwise, and reports no drift (nothing can be read back);
 * - `apply` sends it and records it afterwards: never an intent, so a crash between sending and recording sends it
 *   again on the next run (at-least-once, with an idempotency key derived from the ledger key and the trigger
 *   hash where the API takes one);
 * - rollback never undoes it (it is never in a run's rollback set); `apply --destroy` sends its undo, if it has one,
 *   and forgets it;
 * - another scope's record of the same key does not block it: an action owns nothing at the provider.
 */
import { canonicalJson, sha256 } from "../hash.js";
import type { ResolveResult } from "../resolve.js";
import type { Change, DiffSide, Drift, LedgerEntry, LiveState, OpSpec, ResourceDiff } from "../types.js";
import type { Inspection } from "./inspect.js";
import type { RunContext } from "./run-context.js";

/** What inspection found out about an action line whose trigger is known. */
export interface ActionState {
  /** The ledger key, `action:<line id>`. */
  key: string;
  /** `sha256(canonicalJson(trigger))`, raw (the ledger keeps it keyed). */
  hash: string;
  /** What it does, masked. */
  label: string;
  /** Apply sends it: no run of this trigger is recorded, or the run asks for it again (`recreate`). */
  run: boolean;
}

/** The ledger key of an action line. */
export function actionKey(change: Change): string {
  return `action:${change.id}`;
}

/** The recorded run of the action, unless it is only an intent (never written for actions, but be strict). */
function recorded(rc: RunContext, change: Change, provider: Record<string, unknown>, key: string): LedgerEntry | undefined {
  const e = rc.ledger.get(change.adapter, provider, key);
  return e && e.createdBy !== "intent" ? e : undefined;
}

/** The trigger as a diff side: its values, unless one of them is a secret (then only that it is sensitive). */
function triggerSide(rc: RunContext, trigger: Record<string, unknown>): DiffSide {
  const value = canonicalJson(trigger);
  return rc.redactor.leaks(value).length > 0 ? { state: "sensitive" } : { state: "literal", value };
}

/**
 * Inspect an action line against the ledger instead of live state (`read` is never called): `run` when the
 * current trigger has not run in this scope, `unchanged` when it has.
 */
export function inspectAction(rc: RunContext, change: Change, op: OpSpec, provider: Record<string, unknown>, resolved: ResolveResult): Inspection {
  const key = actionKey(change);
  const base = { change, op, provider, resolved, drift: [] as Drift[], desired: new Set([key]) };
  const t = op.action!(resolved.params, rc.opts.ctx);
  const e = recorded(rc, change, provider, key);
  const before: DiffSide = e ? { state: "literal", value: `ran ${e.action?.at ?? "before"}` } : { state: "absent" };
  if (!t) {
    const p = resolved.pending[0];
    const after: DiffSide = p ? { state: "pending", ref: p.ref } : { state: "pending" };
    return { ...base, live: null, diffs: [{ key, kind: "run", label: `${change.adapter}.${change.op} ${change.id}`, before, after }] };
  }
  const hash = sha256(canonicalJson(t.trigger));
  const label = rc.redactor.redact(t.label);
  const ran = e !== undefined && e.hash === rc.ledger.keyed(hash);
  const run = !ran || (rc.opts.recreate ?? []).includes(change.id);
  const diff: ResourceDiff = run ? { key, kind: "run", label, before, after: triggerSide(rc, t.trigger) } : { key, kind: "unchanged", label };
  // Live state is the recorded run of this very trigger: its outputs are current. Otherwise there is nothing.
  const live: LiveState | null = ran ? { resources: [{ key, id: e.id, hash, label }], outputs: e.outputs ?? {} } : null;
  return { ...base, live, diffs: [diff], action: { key, hash, label, run } };
}
