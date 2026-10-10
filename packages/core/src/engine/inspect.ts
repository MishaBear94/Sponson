import { isSponsonError } from "../errors.js";
import { resolveParams, type LineOutputs, type ResolveResult } from "../resolve.js";
import type { Change, DiffSide, Drift, LiveState, OpSpec, ResourceDiff, ResourceRecord } from "../types.js";
import type { RunContext } from "./run-context.js";

/** Why apply would refuse a line, before writing anything. */
export interface Refusal {
  code: "DRIFT_CHANGED" | "OWNED_BY_OTHER_SCOPE" | "SECRET_UNRESOLVED" | "OUTPUT_UNAVAILABLE";
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
  const spent = diffOrSpent(change, op, live, resolved);
  const diffs = spent.diffs.map((d) => scrubDiff(rc, d));
  const inspection: Inspection = { change, op, provider, resolved, live, diffs, drift: [], desired: new Set(diffs.map((d) => d.key)) };
  if (spent.refusal) inspection.refusal = spent.refusal;

  const missingSecret = resolved.secrets.find((s) => rc.secrets.failures.has(s.ref));
  if (missingSecret) {
    // The one place a secret failure gets its reference: sources throw the reason only, so it is never named twice.
    inspection.refusal = { code: "SECRET_UNRESOLVED", message: `${missingSecret.ref}: ${rc.secrets.failures.get(missingSecret.ref)}` };
  }

  const byKey = new Map<string, ResourceRecord>((live?.resources ?? []).map((r) => [r.key, r]));
  for (const d of diffs) {
    const verdict = judge(rc, change, provider, d, byKey.get(d.key));
    if (verdict.drift) inspection.drift.push(verdict.drift);
    // The first refusal is the one reported: it is the earliest line item apply would stop at.
    if (verdict.refusal) inspection.refusal ??= verdict.refusal;
  }
  return inspection;
}

/**
 * The line's diffs. A spent `once` output reaches the line as `{ keep: true }`; when the line has nothing to keep
 * (its adapter rejects the keep marker as PARAM_INVALID, as `diffValue` does), it would need the value itself,
 * which no later run can have: that is a refusal naming the output, not a parameter error.
 */
function diffOrSpent(change: Change, op: OpSpec, live: LiveState | null, resolved: ResolveResult): { diffs: ResourceDiff[]; refusal?: Refusal } {
  try {
    return { diffs: op.diff(live, resolved.params) };
  } catch (e) {
    const spent = resolved.spent[0];
    if (!spent || !isSponsonError(e) || e.code !== "PARAM_INVALID") throw e;
    const message =
      `\`${change.id}\` needs \`${spent.ref}\`, which the provider reveals only when \`${spent.line}\` creates its resource, and that happened in an earlier run. ` +
      `Nothing was written. To pass a new value on, make \`${spent.line}\` create a new one: delete it in the provider (the next apply re-creates it) or give it a new name in the plan.`;
    return { diffs: [], refusal: { code: "OUTPUT_UNAVAILABLE", message } };
  }
}

/** What one diffed resource means against the ledger: drift to report, and why apply must refuse it. */
interface Verdict {
  drift?: Drift;
  refusal?: Refusal;
}

/**
 * Judge one resource of a line: `d` is its diff, `live` what exists now (undefined: nothing does). Pure: reads
 * the ledger and the run's options, writes nothing.
 */
function judge(rc: RunContext, change: Change, provider: Record<string, unknown>, d: ResourceDiff, live: ResourceRecord | undefined): Verdict {
  // Another scope may rely on what it manages, but never have it changed or recreated under it.
  const foreign = rc.foreignScopeOf({ adapter: change.adapter, provider, key: d.key });
  if (foreign && d.kind !== "unchanged") {
    return { refusal: { code: "OWNED_BY_OTHER_SCOPE", message: `${d.label} is managed by scope \`${foreign}\` in this environment; this scope may not ${live ? "change" : "create"} it.` } };
  }

  const e = rc.ledger.get(change.adapter, provider, d.key);
  if (!e || e.createdBy === "intent") return {};
  const label = e.label ?? d.label;
  const at = (id: string | undefined) => ({ adapter: change.adapter, line: change.id, resource: { key: d.key, id, label } });
  const refuse = (message: string): Verdict => (rc.opts.reconcile ? {} : { refusal: { code: "DRIFT_CHANGED", message } });

  if (!live) {
    return { drift: { kind: "missing", ...at(e.id), message: `${label} was applied by Sponson but no longer exists. It will be recreated.` } };
  }
  if (e.id && live.id !== e.id) {
    return {
      drift: { kind: "changed", replaced: true, ...at(live.id), message: `${label} was deleted and re-created outside Sponson. The new one is not Sponson's; apply refuses this line unless the run reconciles, and then treats it as adopted.` },
      ...refuse(`${label} was replaced outside Sponson since the last apply. Apply with reconcile to take it over as adopted, or update the plan.`),
    };
  }
  // A console edit that already matches the plan is accepted silently; one that conflicts is refused.
  if (e.hash && rc.ledger.keyed(live.hash) !== e.hash && d.kind !== "unchanged") {
    return {
      drift: { kind: "changed", ...at(live.id), message: `${label} was changed outside Sponson since the last apply. Apply refuses this line unless the run reconciles.` },
      ...refuse(`${label} was changed outside Sponson since the last apply. Apply with reconcile to overwrite it, or update the plan to match.`),
    };
  }
  return {};
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
export function waitingOn(inspection: Inspection, ops: Map<string, OpSpec>): { line: string; event?: string } | undefined {
  const p = inspection.resolved.pending[0]; // output references only; secrets are never pending here
  if (!p) return undefined;
  const output = p.ref.split(".").slice(1).join(".");
  const spec = ops.get(p.line)?.outputs[output];
  return spec?.available === "external" ? { line: p.line, event: spec.event ?? "external event" } : { line: p.line };
}
