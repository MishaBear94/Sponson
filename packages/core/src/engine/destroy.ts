import { randomUUID } from "node:crypto";
import { SponsonError } from "../errors.js";
import type { LedgerEntry, Receipt, ReceiptLine } from "../types.js";
import { Lease, withParentLock } from "./lease.js";
import type { Ledger } from "./ledger.js";
import { destroyManual } from "./manual.js";
import { prepare, requireApproval, type Prepared } from "./prepare.js";
import { receiptSkeleton, rereadLine, toRecord } from "./receipt.js";
import { RunContext } from "./run-context.js";
import type { ApplyResultSummary, ManualTodo, RunOptions } from "./types.js";

/**
 * Remove everything the ledger says Sponson created in this scope, newest first, using the
 * provider block recorded with each resource (not the current plan's). Adopted resources are
 * forgotten, never deleted. Use it when a pull request closes; takes the same options as `applyRun`.
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

    checkUndoConfirm(rc, prepared);
    await locateIntents(rc, prepared);
    const todos: ManualTodo[] = [];
    for (const group of groups(rc.ledger).reverse()) todos.push(...(await destroyGroup(rc, prepared, receipt, group, lease.holder, now().toISOString())));

    receipt.ledger = rc.ledger.toJSON();
    const statuses = Object.values(receipt.lines).map((l) => l.status);
    receipt.status = statuses.includes("destroy_failed") ? "failed" : statuses.includes("waiting") ? "partial" : "complete";
    receipt.finishedAt = now().toISOString();
    await lease.write(receipt);
    return { receipt, drift: [], warnings: rc.warnings, ...(todos.length ? { manual: todos.reverse() } : {}) };
  } finally {
    const warning = await lease.release();
    if (warning) rc.warnings.push(warning);
  }
}

/**
 * Destroy one line's resources: what Sponson created is deleted, adopted ones are forgotten, and an intent
 * nobody could locate fails the line (it may exist, and only a human can tell).
 */
async function destroyGroup(rc: RunContext, prepared: Prepared, receipt: Receipt, group: LedgerEntry[], holder: string, at: string): Promise<ManualTodo[]> {
  const head = group[0]!;
  const line: ReceiptLine = receipt.lines[head.line] ?? { id: head.line, adapter: head.adapter, op: head.op, status: "destroyed", createdBy: "sponson", resources: [], outputs: head.outputs ?? {} };
  receipt.lines[head.line] = line;
  // Manual steps (ADR 0021): a person undoes them; there is nothing to delete at a provider.
  const manual = group.filter((e) => e.createdBy === "sponson" && e.manual);
  if (manual.length) {
    const todos = destroyManual(rc, line, manual, at);
    line.resources = rc.ledger.all().filter((x) => x.line === head.line).map(toRecord);
    return todos;
  }
  const ours = group.filter((e) => e.createdBy === "sponson");
  const adopted = group.filter((e) => e.createdBy === "adopted");
  const unknown = group.filter((e) => e.createdBy === "intent");

  for (const e of adopted) rc.ledger.delete(e);
  if (adopted.length) line.notes = { ...line.notes, adoptedKept: adopted.map((e) => e.key) };
  if (unknown.length) {
    line.status = "destroy_failed";
    line.errorCode = "INTENT_UNRESOLVED";
    line.error = `Sponson may have created ${unknown.map((e) => e.key).join(", ")} in an interrupted run but cannot locate it (the line is gone from the plan or its read failed). Check the provider and remove it by hand if it exists.`;
  }
  if (ours.length === 0) {
    if (line.status === "destroyed") {
      line.status = "skipped";
      line.error = adopted.length ? "skipped: adopted resources are never destroyed" : "skipped: nothing created by Sponson";
    }
    return [];
  }
  await deleteOurs(rc, prepared, line, head, ours, holder);
  line.resources = rc.ledger.all().filter((x) => x.line === head.line).map(toRecord);
  return [];
}

/**
 * `confirm` on destroy names manual steps whose undo a person did: lines of manual steps in the ledger (a line the
 * plan no longer has included). It needs the person's name.
 */
function checkUndoConfirm(rc: RunContext, prepared: Prepared): void {
  const confirm = rc.opts.confirm ?? [];
  if (confirm.length === 0) return;
  if (!(rc.opts.confirmedBy ?? "").trim()) throw new SponsonError("USAGE", `Confirming the undo of ${confirm.map((l) => `\`${l}\``).join(", ")} needs the name of the person who did it (confirmedBy).`, { confirm });
  const manual = new Set([...rc.ledger.all().filter((e) => e.manual).map((e) => e.line), ...prepared.ordered.filter((c) => prepared.ops.get(c.id)!.manual).map((c) => c.id)]);
  const wrong = confirm.filter((id) => !manual.has(id));
  if (wrong.length) throw new SponsonError("USAGE", `Cannot confirm ${wrong.map((id) => `\`${id}\``).join(", ")}: only manual steps can be confirmed. Manual steps here: ${[...manual].join(", ") || "(none)"}`, { confirm: wrong });
}

/**
 * Delete what Sponson created for one line; a failure is recorded on the line, never thrown. Resources inside a
 * shared parent object are removed holding its lease (ADR 0019), found from the ledger, not the plan.
 */
async function deleteOurs(rc: RunContext, prepared: Prepared, line: ReceiptLine, head: LedgerEntry, ours: LedgerEntry[], holder: string): Promise<void> {
  try {
    const op = rc.opts.registry.op(head.adapter, head.op);
    const actx = rc.adapterContext(head.adapter, head.provider);
    actx.log(`destroy ${head.line}`);
    const parent = ours.find((e) => e.parent)?.parent;
    await withParentLock(rc.opts, holder, parent, rc.warnings, () => op.destroy(actx, ours.map(toRecord)));
    for (const e of ours) rc.ledger.delete(e);
    const survivors = await stillPresent(rc, prepared, head, ours);
    if (survivors.length) {
      line.notes = { ...line.notes, notSponsons: survivors };
      rc.warnings.push(survivorWarning(head.line, survivors));
    }
  } catch (e) {
    const err = rc.errorText(e);
    line.status = "destroy_failed";
    line.error = err.message;
    line.errorCode = err.code ?? "DESTROY_FAILED";
  }
}

function survivorWarning(lineId: string, survivors: string[]): string {
  const one = survivors.length === 1;
  return `\`${lineId}\`: ${survivors.join(", ")} still exist${one ? "s" : ""} after destroy: ${one ? "it was" : "they were"} replaced outside Sponson, so ${one ? "it is" : "they are"} not Sponson's and ${one ? "was" : "were"} left alone.`;
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
