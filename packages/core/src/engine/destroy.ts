import { randomUUID } from "node:crypto";
import type { LedgerEntry, Receipt, ReceiptLine } from "../types.js";
import { Lease } from "./lease.js";
import type { Ledger } from "./ledger.js";
import { prepare, requireApproval, type Prepared } from "./prepare.js";
import { receiptSkeleton, rereadLine, toRecord } from "./receipt.js";
import { RunContext } from "./run-context.js";
import type { ApplyResultSummary, RunOptions } from "./types.js";

/**
 * Remove everything the ledger says Sponson created in this scope, newest first, using the
 * provider block recorded with each resource (not the current plan's). Adopted resources are
 * forgotten, never deleted.
 */
export async function destroyRun(opts: RunOptions): Promise<ApplyResultSummary> {
  const prepared = prepare(opts);
  const approvedBy = requireApproval(opts, prepared);
  const now = opts.now ?? (() => new Date());
  const rc = new RunContext(opts);
  const lease = await Lease.acquire(opts, `destroy-${randomUUID().slice(0, 8)}`);
  try {
    if (lease.preempted) rc.warnings.push(`Took over an expired lock held by ${lease.preempted.holder} since ${lease.preempted.acquiredAt}.`);
    await rc.load();
    // Secrets are resolved only so that provider errors echoing them are masked.
    await rc.resolveSecrets(prepared);
    const receipt: Receipt = { ...receiptSkeleton(rc, lease, now(), approvedBy), destroy: true };

    if (rc.ledger.all().length === 0) {
      rc.warnings.push("Nothing to destroy: no receipt for this scope.");
      receipt.finishedAt = now().toISOString();
      return { receipt, drift: [], warnings: rc.warnings };
    }

    await locateIntents(rc, prepared);
    for (const group of groups(rc.ledger).reverse()) {
      const head = group[0]!;
      const rl: ReceiptLine = receipt.lines[head.line] ?? { id: head.line, adapter: head.adapter, op: head.op, status: "destroyed", createdBy: "sponson", resources: [], outputs: head.outputs ?? {} };
      receipt.lines[head.line] = rl;
      const ours = group.filter((e) => e.createdBy === "sponson");
      const adopted = group.filter((e) => e.createdBy === "adopted");
      const unknown = group.filter((e) => e.createdBy === "intent");
      for (const e of adopted) rc.ledger.delete(e);
      if (adopted.length) rl.notes = { ...(rl.notes ?? {}), adoptedKept: adopted.map((e) => e.key) };
      if (unknown.length) {
        rl.status = "destroy_failed";
        rl.errorCode = "INTENT_UNRESOLVED";
        rl.error = `Sponson may have created ${unknown.map((e) => e.key).join(", ")} in an interrupted run but cannot locate it (the line is gone from the plan or its read failed). Check the provider and remove it by hand if it exists.`;
      }
      if (ours.length === 0) {
        if (!unknown.length && rl.status === "destroyed") {
          rl.status = "skipped";
          rl.error = adopted.length ? "skipped: adopted resources are never destroyed" : "skipped: nothing created by Sponson";
        }
        continue;
      }
      try {
        const op = opts.registry.op(head.adapter, head.op);
        const actx = rc.adapterContext(head.adapter, head.provider);
        actx.log(`destroy ${head.line}`);
        await op.destroy(actx, ours.map(toRecord));
        for (const e of ours) rc.ledger.delete(e);
        const survivors = await stillPresent(rc, prepared, head, ours);
        if (survivors.length) {
          rl.notes = { ...(rl.notes ?? {}), notSponsons: survivors };
          rc.warnings.push(`\`${head.line}\`: ${survivors.join(", ")} still exist${survivors.length === 1 ? "s" : ""} after destroy: ${survivors.length === 1 ? "it was" : "they were"} replaced outside Sponson, so ${survivors.length === 1 ? "it is" : "they are"} not Sponson's and ${survivors.length === 1 ? "was" : "were"} left alone.`);
        }
      } catch (e) {
        const err = rc.errorText(e);
        rl.status = "destroy_failed";
        rl.error = err.message;
        rl.errorCode = err.code ?? "DESTROY_FAILED";
      }
      rl.resources = rc.ledger.all().filter((x) => x.line === head.line).map(toRecord);
    }

    receipt.ledger = rc.ledger.toJSON();
    receipt.status = Object.values(receipt.lines).some((l) => l.status === "destroy_failed") ? "failed" : "complete";
    receipt.finishedAt = now().toISOString();
    await lease.write(receipt);
    return { receipt, drift: [], warnings: rc.warnings };
  } finally {
    await lease.release();
  }
}

/** Consecutive entries of the same line/adapter/op/provider, in ledger (creation) order. */
function groups(ledger: Ledger): LedgerEntry[][] {
  const out: LedgerEntry[][] = [];
  for (const e of ledger.all()) {
    const last = out[out.length - 1];
    const h = last?.[0];
    if (h && h.line === e.line && h.adapter === e.adapter && h.op === e.op && JSON.stringify(h.provider) === JSON.stringify(e.provider)) last.push(e);
    else out.push([e]);
  }
  return out;
}

/** An interrupted run may have created something it never confirmed; find it through the line that intended it. */
async function locateIntents(rc: RunContext, prepared: Prepared): Promise<void> {
  const intents = rc.ledger.all().filter((e) => e.createdBy === "intent");
  for (const e of intents) {
    const change = prepared.ordered.find((c) => c.id === e.line && c.adapter === e.adapter);
    if (!change) continue;
    try {
      const live = await rereadLine(rc, prepared, change, e.provider);
      const r = live?.resources.find((x) => x.key === e.key);
      if (r) rc.ledger.put({ ...e, id: r.id, hash: rc.ledger.keyed(r.hash), createdBy: "sponson" });
      else rc.ledger.delete(e);
    } catch {
      /* stays an intent; reported as destroy_failed */
    }
  }
}

/**
 * Destroy deletes by provider id; a resource a human re-created under the same key has a new id
 * and survives. Re-read the line (when the plan still declares it) so the receipt says so.
 */
async function stillPresent(rc: RunContext, prepared: Prepared, head: LedgerEntry, destroyed: LedgerEntry[]): Promise<string[]> {
  const change = prepared.ordered.find((c) => c.id === head.line && c.adapter === head.adapter);
  if (!change) return [];
  try {
    const live = await rereadLine(rc, prepared, change, head.provider);
    const keys = new Set(destroyed.map((e) => e.key));
    return (live?.resources ?? []).filter((r) => keys.has(r.key)).map((r) => r.label ?? r.key);
  } catch {
    return [];
  }
}
