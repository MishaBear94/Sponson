import { dependenciesOf } from "../plan.js";
import type { LineOutputs } from "../resolve.js";
import type { Change } from "../types.js";
import { scopeDrift } from "./drift.js";
import { staleness } from "./history.js";
import { inspectLine, waitingOn, type Inspection } from "./inspect.js";
import { hasExternalOutputs, planOutputs } from "./outputs.js";
import { prepare, type Prepared } from "./prepare.js";
import { RunContext } from "./run-context.js";
import type { PlanLine, PlanResult, RunOptions } from "./types.js";

/**
 * What `applyRun` would do right now, line by line, plus scope-wide drift. Performs no writes, so it is safe to
 * call at any time; show its result to a human (or an agent's user) before applying.
 *
 * @example
 * ```ts
 * import { applyRun, loadPlan, LocalReceiptStore, planRun, type RunOptions } from "@sponson/core";
 * import { createRegistry } from "@sponson/adapters";
 * import { detectCtx } from "sponson";
 *
 * const { plan } = await loadPlan("release.plan.yaml");
 * const opts: RunOptions = {
 *   plan,
 *   ctx: await detectCtx({ env: "preview" }),
 *   registry: createRegistry(),
 *   store: new LocalReceiptStore(".sponson/receipts"),
 * };
 * const preview = await planRun(opts); // reads only
 * if (!preview.lines.some((l) => l.status === "error" || l.status === "blocked")) {
 *   const { receipt } = await applyRun(opts);
 *   console.log(receipt.status); // complete | partial | failed
 * }
 * ```
 */
export async function planRun(opts: RunOptions): Promise<PlanResult> {
  const prepared = prepare(opts);
  const rc = new RunContext(opts);
  await rc.load();
  await rc.resolveSecrets(prepared);
  const lock = await opts.store.readLock(opts.ctx.env, opts.ctx.scope).catch(() => null);
  if (lock && Date.parse(lock.expiresAt) > Date.now()) rc.warnings.push(`An apply (${lock.holder}) is running on this scope; this plan describes a moving target.`);
  const st = await staleness(rc.previous?.history ?? [], opts.ctx.git.sha, opts.isAncestor);
  if (st.stale) rc.warnings.push(`Commit ${opts.ctx.git.short_sha} is older than the last applied commit ${st.last.slice(0, 7)}; apply would skip this run as stale.`);

  const walk: PlanWalk = { outputs: new Map(), inspected: [], uninspected: new Set(), broken: new Set() };
  const lines: PlanLine[] = [];
  for (const c of prepared.ordered) lines.push(await planLine(rc, prepared, walk, c));

  const drift = [...walk.inspected.flatMap((i) => i.drift), ...(await scopeDrift(rc, walk.inspected, walk.uninspected))];
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

/** What the walk over the lines has learned so far. */
interface PlanWalk {
  /** Outputs known per line, for the lines that read them. */
  outputs: Map<string, LineOutputs>;
  inspected: Inspection[];
  /** Lines never inspected (errored or blocked); scope drift must not judge their resources. */
  uninspected: Set<string>;
  /** Lines in error or blocked: everything that depends on them is blocked too. */
  broken: Set<string>;
}

async function planLine(rc: RunContext, prepared: Prepared, walk: PlanWalk, c: Change): Promise<PlanLine> {
  const op = prepared.ops.get(c.id)!;
  const line: PlanLine = { id: c.id, adapter: c.adapter, op: c.op, status: "unchanged", diffs: [], inputs: {}, outputs: {} };

  const blockedBy = dependenciesOf(c).find((d) => walk.broken.has(d));
  if (blockedBy) {
    Object.assign(line, { status: "blocked", error: `depends on \`${blockedBy}\`, which cannot be applied`, errorCode: "DEPENDENCY_BLOCKED" });
    walk.broken.add(c.id);
    walk.uninspected.add(c.id);
    return line;
  }

  let inspection: Inspection;
  try {
    inspection = await inspectLine(rc, c, op, prepared.params.get(c.id)!, walk.outputs);
  } catch (e) {
    const err = rc.errorText(e);
    Object.assign(line, { status: "error", error: err.message, ...(err.code ? { errorCode: err.code } : {}) });
    walk.broken.add(c.id);
    walk.uninspected.add(c.id);
    return line;
  }
  walk.inspected.push(inspection);
  line.diffs = inspection.diffs;
  line.inputs = inspection.resolved.inputs;
  line.outputs = await knownOutputs(rc, walk, inspection);

  const wait = waitingOn(inspection, prepared.ops);
  if (inspection.refusal) {
    Object.assign(line, { status: "blocked", error: inspection.refusal.message, errorCode: inspection.refusal.code });
    walk.broken.add(c.id);
  } else if (wait) {
    line.status = "pending";
    line.waitingOn = wait.line;
    if (wait.event) line.waitingFor = wait.event;
  } else if (inspection.diffs.some((d) => d.kind === "create")) line.status = "create";
  else if (inspection.diffs.some((d) => d.kind === "update")) line.status = "update";
  return line;
}

/** The line's outputs as they are live right now, including external ones whose event already happened. */
async function knownOutputs(rc: RunContext, walk: PlanWalk, inspection: Inspection): Promise<PlanLine["outputs"]> {
  const { change: c, op, live } = inspection;
  let values: Record<string, unknown> = { ...live?.outputs };
  if (live && op.awaitExternal && hasExternalOutputs(op.outputs)) {
    // Read-only check whether the external event already happened (e.g. the deploy is READY).
    const ext = await op.awaitExternal(rc.adapterContext(c.adapter, inspection.provider), inspection.resolved.params, live).catch(() => null);
    if (ext) values = { ...values, ...ext };
  }
  rc.guardOutputs(values, op.outputs);
  walk.outputs.set(c.id, { values: values as LineOutputs["values"], specs: op.outputs });
  return planOutputs(values, op.outputs);
}
