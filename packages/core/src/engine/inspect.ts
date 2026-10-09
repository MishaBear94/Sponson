import { resolveParams, type LineOutputs, type ResolveResult } from "../resolve.js";
import type { Change, DiffSide, Drift, LiveState, OpSpec, ResourceDiff, ResourceRecord } from "../types.js";
import type { RunContext } from "./run-context.js";

/** Why apply would refuse a line, before writing anything. */
export interface Refusal {
  code: "DRIFT_CHANGED" | "OWNED_BY_OTHER_SCOPE" | "SECRET_UNRESOLVED";
  message: string;
}

/** Everything known about one line without writing: the single source for both plan and apply. */
export interface Inspection {
  change: Change;
  op: OpSpec;
  provider: Record<string, unknown>;
  resolved: ResolveResult;
  live: LiveState | null;
  diffs: ResourceDiff[];
  refusal?: Refusal;
  drift: Drift[];
  /** Keys this line declares (whatever exists live). */
  desired: Set<string>;
}

/**
 * Read one line's live state and judge it against the ledger.
 * Secrets were resolved up front, so diffs compare real values (a rotated secret shows as an update).
 */
export async function inspectLine(rc: RunContext, change: Change, op: OpSpec, params: Record<string, unknown>, outputs: Map<string, LineOutputs>): Promise<Inspection> {
  const provider = rc.provider(change.adapter);
  const resolved = resolveParams(params, outputs, rc.secrets.values);
  const live = await op.read(rc.adapterContext(change.adapter, provider), resolved.params);
  if (live) rc.guardOutputs(live.outputs, op.outputs);
  const diffs = op.diff(live, resolved.params).map((d) => scrubDiff(rc, d));
  const insp: Inspection = { change, op, provider, resolved, live, diffs, drift: [], desired: new Set(diffs.map((d) => d.key)) };

  const missingSecret = resolved.secrets.find((s) => rc.secrets.failures.has(s.ref));
  if (missingSecret) {
    insp.refusal = { code: "SECRET_UNRESOLVED", message: `${missingSecret.ref}: ${rc.secrets.failures.get(missingSecret.ref)}` };
  }

  const byKey = new Map<string, ResourceRecord>((live?.resources ?? []).map((r) => [r.key, r]));
  for (const d of diffs) {
    const where = { adapter: change.adapter, provider, key: d.key };
    const r = byKey.get(d.key);
    const foreign = rc.foreignScopeOf(where);
    // Another scope may rely on what it manages, but never have it changed or recreated under it.
    if (foreign && d.kind !== "unchanged") {
      insp.refusal ??= { code: "OWNED_BY_OTHER_SCOPE", message: `${d.label} is managed by scope \`${foreign}\` in this environment; this scope may not ${r ? "change" : "create"} it.` };
      continue;
    }
    const e = rc.ledger.get(change.adapter, provider, d.key);
    if (!e || e.createdBy === "intent") continue;
    const label = e.label ?? d.label;
    if (!r) {
      insp.drift.push({ kind: "missing", adapter: change.adapter, line: change.id, resource: { key: d.key, id: e.id, label }, message: `${label} was applied by Sponson but no longer exists. It will be recreated.` });
      continue;
    }
    if (e.id && r.id !== e.id) {
      insp.drift.push({ kind: "changed", replaced: true, adapter: change.adapter, line: change.id, resource: { key: d.key, id: r.id, label }, message: `${label} was deleted and re-created outside Sponson. The new one is not Sponson's; apply refuses this line unless --reconcile is given, and will then treat it as adopted.` });
      if (!rc.opts.reconcile) insp.refusal ??= { code: "DRIFT_CHANGED", message: `${label} was replaced outside Sponson since the last apply. Re-run with --reconcile to take it over as adopted, or update the plan.` };
    } else if (e.hash && rc.ledger.keyed(r.hash) !== e.hash) {
      // A console edit that already matches the plan is accepted silently; one that conflicts is refused.
      if (d.kind === "unchanged") continue;
      insp.drift.push({ kind: "changed", adapter: change.adapter, line: change.id, resource: { key: d.key, id: r.id, label }, message: `${label} was changed outside Sponson since the last apply. Apply will refuse this line unless --reconcile is given.` });
      if (!rc.opts.reconcile) insp.refusal ??= { code: "DRIFT_CHANGED", message: `${label} was changed outside Sponson since the last apply. Re-run with --reconcile to overwrite it, or update the plan to match.` };
    }
  }
  return insp;
}

/**
 * Adapters only know which of their own fields are sensitive; a secret or sensitive output can
 * still arrive in a plain field through a reference. Whatever matches a registered secret is
 * described as sensitive instead of carried as a value.
 */
function scrubDiff(rc: RunContext, d: ResourceDiff): ResourceDiff {
  const scrub = (side: DiffSide | undefined): DiffSide | undefined =>
    side?.state === "literal" && side.value !== undefined && rc.redactor.leaks(side.value).length > 0 ? { state: "sensitive" } : side;
  const before = scrub(d.before);
  const after = scrub(d.after);
  return { key: d.key, kind: d.kind, label: rc.redactor.redact(d.label), ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** The first unresolved `from:` reference, with the external event it waits for when there is one. */
export function waitingOn(insp: Inspection, ops: Map<string, OpSpec>): { line: string; event?: string } | undefined {
  const p = insp.resolved.pending.find((x) => !x.ref.includes("://"));
  if (!p) return undefined;
  const output = p.ref.split(".").slice(1).join(".");
  const spec = ops.get(p.line)?.outputs[output];
  return spec?.available === "external" ? { line: p.line, event: spec.event ?? "external event" } : { line: p.line };
}
