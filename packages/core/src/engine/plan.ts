import { dependenciesOf } from "../plan.js";
import type { LineOutputs } from "../resolve.js";
import { scopeDrift } from "./drift.js";
import { staleness } from "./history.js";
import { inspectLine, waitingOn, type Inspection } from "./inspect.js";
import { hasExternalOutputs, planOutputs } from "./outputs.js";
import { prepare } from "./prepare.js";
import { RunContext } from "./run-context.js";
import type { PlanLine, PlanResult, RunOptions } from "./types.js";

/** Read-only: what apply would do right now, line by line, plus scope-wide drift. */
export async function planRun(opts: RunOptions): Promise<PlanResult> {
  const prepared = prepare(opts);
  const rc = new RunContext(opts);
  await rc.load();
  await rc.resolveSecrets(prepared);
  const lock = await opts.store.readLock(opts.ctx.env, opts.ctx.scope).catch(() => null);
  if (lock && Date.parse(lock.expiresAt) > Date.now()) rc.warnings.push(`An apply (${lock.holder}) is running on this scope; this plan describes a moving target.`);
  const st = await staleness(rc.previous?.history ?? [], opts.ctx.git.sha, opts.isAncestor);
  if (st.stale) rc.warnings.push(`Commit ${opts.ctx.git.short_sha} is older than the last applied commit ${st.last!.slice(0, 7)}; apply would skip this run as stale.`);

  const outputs = new Map<string, LineOutputs>();
  const lines: PlanLine[] = [];
  const inspected: Inspection[] = [];
  const uninspected = new Set<string>();
  const broken = new Set<string>();

  for (const c of prepared.ordered) {
    const op = prepared.ops.get(c.id)!;
    const line: PlanLine = { id: c.id, adapter: c.adapter, op: c.op, status: "unchanged", diffs: [], inputs: {}, outputs: {} };
    lines.push(line);

    const blockedBy = dependenciesOf(c).find((d) => broken.has(d));
    if (blockedBy) {
      Object.assign(line, { status: "blocked", error: `depends on \`${blockedBy}\`, which cannot be applied`, errorCode: "DEPENDENCY_BLOCKED" });
      broken.add(c.id);
      uninspected.add(c.id);
      continue;
    }

    let insp: Inspection;
    try {
      insp = await inspectLine(rc, c, op, prepared.params.get(c.id)!, outputs);
    } catch (e) {
      const err = rc.errorText(e);
      Object.assign(line, { status: "error", error: err.message, ...(err.code ? { errorCode: err.code } : {}) });
      broken.add(c.id);
      uninspected.add(c.id);
      continue;
    }
    inspected.push(insp);
    line.diffs = insp.diffs;
    line.inputs = insp.resolved.inputs;

    let values: Record<string, unknown> = { ...(insp.live?.outputs ?? {}) };
    if (insp.live && op.awaitExternal && hasExternalOutputs(op.outputs)) {
      // Read-only check whether the external event already happened (e.g. the deploy is READY).
      const ext = await op.awaitExternal(rc.adapterContext(c.adapter, insp.provider), insp.resolved.params, insp.live).catch(() => null);
      if (ext) values = { ...values, ...ext };
    }
    rc.guardOutputs(values, op.outputs);
    outputs.set(c.id, { values: values as LineOutputs["values"], specs: op.outputs });
    line.outputs = planOutputs(values, op.outputs);

    const wait = waitingOn(insp, prepared.ops);
    if (insp.refusal) {
      Object.assign(line, { status: "blocked", error: insp.refusal.message, errorCode: insp.refusal.code });
      broken.add(c.id);
    } else if (wait) {
      line.status = "pending";
      line.waitingOn = wait.line;
      if (wait.event) line.waitingFor = wait.event;
    } else if (insp.diffs.some((d) => d.kind === "create")) line.status = "create";
    else if (insp.diffs.some((d) => d.kind === "update")) line.status = "update";
  }

  const drift = [...inspected.flatMap((i) => i.drift), ...(await scopeDrift(rc, inspected, uninspected))];
  return {
    environment: opts.ctx.env,
    scope: opts.ctx.scope,
    planHash: opts.plan.hash,
    lines,
    drift,
    warnings: rc.warnings,
    previous: rc.previous,
    lock,
    requiresApproval: prepared.requiresApproval,
  };
}
