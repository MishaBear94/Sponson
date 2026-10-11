/**
 * Manual steps (ADR 0021): lines a person does by hand, for state no API can change (a Google OAuth client's
 * redirect URIs). The op describes the step (`OpSpec.manual`); the engine owns its state:
 *
 * - done when its verify request sees it (`observable` steps: `read` returns its resource), or when the ledger
 *   records a person's confirmation of these very instructions; otherwise a `todo`;
 * - apply records a todo only when the run confirms it (`RunOptions.confirm`), and otherwise leaves the line waiting
 *   for a confirmation with MANUAL_STEP_PENDING (its dependents wait too, nothing is rolled back);
 * - a step a verify request saw done and no longer sees is `missing` drift, and a todo again;
 * - rollback never undoes one (a person did it); destroy shows its `undo` and forgets it only once confirmed.
 */
import { SponsonError } from "../errors.js";
import type { ResolveResult } from "../resolve.js";
import type { Change, Drift, LedgerEntry, ManualStep, OpSpec, ReceiptLine, ResourceDiff } from "../types.js";
import type { Inspection } from "./inspect.js";
import type { RunContext } from "./run-context.js";
import type { ManualTodo, RunOptions } from "./types.js";

/** What inspection found out about a manual line whose inputs are all known. */
export interface ManualState {
  step: ManualStep;
  /** Done: seen by its verify request, or confirmed by a person for these instructions. */
  done: boolean;
  /** Seen done by its verify request in this inspection. */
  verified: boolean;
}

/** The receipt's `waitingFor` of a manual step (and of the lines that depend on it) until it is confirmed. */
export const CONFIRMATION = "confirmation";

/** The label a manual step's resource and diff carry. */
export function manualLabel(step: Pick<ManualStep, "title">): string {
  return `manual step: ${step.title}`;
}

/** The ledger entry of the step, unless it is only an intent (never written for manual steps, but be strict). */
function recorded(rc: RunContext, change: Change, provider: Record<string, unknown>, key: string): LedgerEntry | undefined {
  const e = rc.ledger.get(change.adapter, provider, key);
  return e && e.createdBy !== "intent" ? e : undefined;
}

/**
 * Inspect a manual line: read its verify request (if any), and judge it against the ledger instead of the generic
 * drift rules (`judge`): a step has no provider object another scope could own or a console could edit.
 */
export async function inspectManual(rc: RunContext, change: Change, op: OpSpec, provider: Record<string, unknown>, resolved: ResolveResult): Promise<Inspection> {
  const step = op.manual!(resolved.params, rc.opts.ctx);
  const base = { change, op, provider, resolved, drift: [] as Drift[] };
  if (!step) return { ...base, live: null, diffs: op.diff(null, resolved.params), desired: new Set() };
  const e = recorded(rc, change, provider, step.key);
  const verified = step.observable && (await op.read(rc.adapterContext(change.adapter, provider), resolved.params)) !== null;
  const confirmed = e?.manual?.how === "confirmed" && e.hash === rc.ledger.keyed(step.hash);
  const done = verified || confirmed;
  const label = manualLabel(step);
  const live = done ? { resources: [{ key: step.key, id: "manual", hash: step.hash, label }], outputs: {} } : null;
  const inspection: Inspection = { ...base, live, diffs: [manualDiff(step, e, done)], desired: new Set([step.key]), manual: { step, done, verified } };
  if (e?.manual?.how === "verified" && !verified) {
    inspection.drift.push({ kind: "missing", adapter: change.adapter, line: change.id, resource: { key: step.key, id: e.id, label }, message: `${label} was seen done by its verify request, which no longer sees it. It is a step to do again.` });
  }
  return inspection;
}

function manualDiff(step: ManualStep, e: LedgerEntry | undefined, done: boolean): ResourceDiff {
  const label = manualLabel(step);
  if (done) return { key: step.key, kind: "unchanged", label };
  // Recorded before with other instructions (or seen done before): to do again, as an update of the step.
  const before = e?.manual ? { state: "literal" as const, value: e.manual.title } : { state: "absent" as const };
  return { key: step.key, kind: e ? "update" : "create", label, before, after: { state: "literal", value: step.title } };
}

/** The step as shown to the person who must do it. Text is masked like every output. */
export function todoOf(rc: RunContext, line: string, step: ManualStep, action: ManualTodo["action"]): ManualTodo {
  const instructions = action === "do" ? step.instructions : (step.undo ?? "");
  return { line, title: rc.redactor.redact(step.title), action, instructions: rc.redactor.redact(instructions), observable: step.observable };
}

/** The waiting receipt line of a manual step nobody confirmed yet. */
export function pendingLine(line: ReceiptLine, title: string, action: ManualTodo["action"]): void {
  Object.assign(line, {
    status: "waiting",
    waitingFor: CONFIRMATION,
    errorCode: "MANUAL_STEP_PENDING",
    error: `manual step \`${title}\` ${action === "do" ? "is not done" : "must be undone"}; a person does it, then confirms it`,
  } satisfies Partial<ReceiptLine>);
}

/**
 * The ledger entry that records a done step: who confirmed it and when, or when a verify request first saw it.
 * Keeps the previous record when nothing about the step changed, so the first confirmation stays on file.
 */
export function manualEntry(rc: RunContext, change: Change, provider: Record<string, unknown>, state: ManualState, confirmedNow: boolean, at: string): { entry: LedgerEntry; changed: boolean } {
  const { step } = state;
  const prev = recorded(rc, change, provider, step.key);
  const hash = rc.ledger.keyed(step.hash);
  const how = confirmedNow ? "confirmed" : state.verified ? "verified" : (prev?.manual?.how ?? "confirmed");
  const kept = prev?.manual && prev.hash === hash && prev.manual.how === how && !confirmedNow;
  const redact = (t: string) => rc.redactor.redact(t);
  const manual: NonNullable<LedgerEntry["manual"]> = kept
    ? prev.manual!
    : { title: redact(step.title), ...(step.undo ? { undo: redact(step.undo) } : {}), how, ...(confirmedNow ? { by: rc.opts.confirmedBy!.trim() } : {}), at };
  const entry: LedgerEntry = { adapter: change.adapter, op: change.op, provider, key: step.key, id: "manual", hash, label: manualLabel(step), createdBy: "sponson", line: change.id, manual };
  return { entry, changed: !kept || prev.line !== change.id };
}

/** `confirm` needs a person's name, and may name only manual lines active in this run. */
export function checkConfirm(opts: RunOptions, lines: Array<{ id: string; op: OpSpec }>): void {
  const confirm = opts.confirm ?? [];
  if (confirm.length === 0) return;
  if (!(opts.confirmedBy ?? "").trim()) throw new SponsonError("USAGE", `Confirming ${confirm.map((l) => `\`${l}\``).join(", ")} needs the name of the person who did it (confirmedBy).`, { confirm });
  const manual = new Set(lines.filter((l) => l.op.manual).map((l) => l.id));
  const wrong = confirm.filter((id) => !manual.has(id));
  if (wrong.length) {
    throw new SponsonError("USAGE", `Cannot confirm ${wrong.map((id) => `\`${id}\``).join(", ")}: only manual steps can be confirmed. Manual steps here: ${[...manual].join(", ") || "(none)"}`, { confirm: wrong });
  }
}

/**
 * Destroy a manual step's record: there is nothing to delete at a provider, but a person may have to undo it. With
 * no `undo`, or once confirmed, the record is forgotten; otherwise the line waits for that confirmation and the undo
 * instructions are returned for the person.
 */
export function destroyManual(rc: RunContext, line: ReceiptLine, entries: LedgerEntry[], at: string): ManualTodo[] {
  const todos: ManualTodo[] = [];
  const confirmed = (rc.opts.confirm ?? []).includes(line.id);
  for (const e of entries) {
    const m = e.manual!;
    if (m.undo && !confirmed) {
      pendingLine(line, m.title, "undo");
      todos.push({ line: line.id, title: m.title, action: "undo", instructions: m.undo, observable: false });
      continue;
    }
    rc.ledger.delete(e);
    line.notes = { ...line.notes, manual: m.undo ? { undoneBy: rc.opts.confirmedBy!.trim(), undoneAt: at } : { nothingToUndo: true } };
  }
  return todos;
}

/** Lines `confirm` named that this run did not confirm (still waiting on an input, or done already). */
export function unusedConfirmations(opts: RunOptions, used: Set<string>): string | undefined {
  const unused = (opts.confirm ?? []).filter((id) => !used.has(id));
  if (unused.length === 0) return undefined;
  return `Not confirmed: ${unused.map((id) => `\`${id}\``).join(", ")} (done already, or still waiting on an input, so there was nothing to confirm yet).`;
}
