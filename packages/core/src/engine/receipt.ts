import { resolveParams, type LineOutputs } from "../resolve.js";
import type { Change, LedgerEntry, LiveState, Receipt, ResourceRecord } from "../types.js";
import type { Lease } from "./lease.js";
import type { Prepared } from "./prepare.js";
import type { RunContext } from "./run-context.js";

/** Shared by apply and destroy: the receipt a run starts from, ledger entries as records, and re-reading a line. */

/** The receipt every writing run starts from. Call after `rc.load()`: it carries the ledger's history and hash key. */
export function receiptSkeleton(rc: RunContext, lease: Lease, startedAt: Date, approvedBy: string | undefined): Receipt {
  const { ctx, plan } = rc.opts;
  return {
    version: 2,
    runId: lease.holder,
    environment: ctx.env,
    scope: ctx.scope,
    status: "complete",
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    plan: { hash: plan.hash, ...(plan.path ? { path: plan.path } : {}) },
    ctx,
    lines: {},
    ledger: [],
    history: rc.previous?.history ?? [],
    hashKey: rc.ledger.hashKey,
    ...(approvedBy ? { approvedBy } : {}),
    ...(lease.preempted ? { lockPreempted: lease.preempted.holder } : {}),
  };
}

/** A ledger entry as the resource record adapters and receipt lines take. Intents count as Sponson's: if they exist, they are. */
export function toRecord(e: LedgerEntry): ResourceRecord {
  return { key: e.key, id: e.id, hash: e.hash, ...(e.label ? { label: e.label } : {}), createdBy: e.createdBy === "adopted" ? "adopted" : "sponson" };
}

/**
 * Read a line's live state again (rollback, destroy), resolving its params with whatever outputs are known
 * (none in destroy) and the run's secrets. `provider` is where the resources live, which for destroy is the
 * block recorded in the ledger, not necessarily the current plan's.
 */
export async function rereadLine(rc: RunContext, prepared: Prepared, change: Change, provider: Record<string, unknown>, outputs: Map<string, LineOutputs> = new Map()): Promise<LiveState | null> {
  const params = resolveParams(prepared.params.get(change.id)!, outputs, rc.secrets.values).params;
  return prepared.ops.get(change.id)!.read(rc.adapterContext(change.adapter, provider), params);
}
