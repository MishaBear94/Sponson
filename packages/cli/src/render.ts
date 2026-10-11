/**
 * Text rendering (for humans) and the JSON envelopes (for agents).
 * Display strings such as `(secret)` or `(pending ← db.x)` exist only here, in text; JSON carries engine data as-is.
 */
import type { ErrorCode, ApplyResultSummary, DiffSide, Drift, LineStatus, ManualTodo, PlanLine, PlanLineStatus, PlanResult, ReceiptLine, ResourceDiff } from "@sponson/core";
import { cliHint } from "./output.js";

export interface RenderOptions {
  color: boolean;
}

/**
 * One glyph per status. `-` means something is (or was) removed, so it is kept for that alone: a line that is held
 * back (refused, or waiting on a refused line) is `x`, which reads as "not done", never as a delete.
 */
export const PLAN_SYMBOL: Record<PlanLineStatus, string> = { create: "+", update: "~", unchanged: "=", run: ">", pending: "?", todo: "*", blocked: "x", error: "!" };
export const LINE_SYMBOL: Record<LineStatus, string> = {
  applied: "+",
  unchanged: "=",
  waiting: "?",
  failed: "!",
  rolled_back: "-",
  rollback_failed: "!",
  skipped: "x",
  destroyed: "-",
  destroy_failed: "!",
  blocked: "x",
};
const ANSI: Record<string, string> = { "+": "32", "~": "33", "=": "2", "!": "31", x: "35" };

function paint(symbol: string, text: string, color: boolean): string {
  const code = ANSI[symbol];
  return color && code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/**
 * One side of a diff as text; undefined when there is nothing to show (absent). Labels follow what the value is in
 * the plan (the engine sets the side from the param, `describeInput`): `secret` only for a `{ secret }` reference,
 * `value hidden` for a sensitive value that is not one (a `{ from }` output, a live value the provider hides), and a
 * literal as itself. The PR comment (markdown.ts) uses the same words.
 */
export function sideText(s: DiffSide | undefined): string | undefined {
  if (!s) return undefined;
  const from = s.ref ? ` ← ${s.ref}` : "";
  switch (s.state) {
    case "literal":
      return s.value ?? "";
    case "sensitive":
      return `(value hidden${from})`;
    case "pending":
      return `(pending${from})`;
    case "secret":
      return `(secret${from})`;
    case "absent":
      return undefined;
  }
}

/**
 * One resource's diff as text. The value is left out where it says nothing the label does not (a Neon branch whose
 * label already ends in its name), and a change between two hidden values says what changed instead of
 * `(value hidden) → (value hidden)`. `drift` is what happened to the resource outside Sponson since the last apply
 * (`changed outside Sponson`), said here once: the line's error and the drift section leave it out.
 */
export function diffText(d: ResourceDiff, drift?: string): string {
  const after = sideText(d.after);
  if (after === undefined) return drift ? `${d.label}  ${drift}` : d.label;
  const before = sideText(d.before);
  if (before === undefined && d.after?.state === "literal" && (d.label === after || d.label.endsWith(` ${after}`))) return d.label;
  if (before !== undefined && hidden(d.before) && hidden(d.after)) return `${d.label}  ${drift ?? "changes"} ${after}`;
  return `${d.label}  ${drift ? `${drift}: ` : ""}${before !== undefined ? `${before} → ` : ""}${after}`;
}

function hidden(s: DiffSide | undefined): boolean {
  return s?.state === "sensitive" || s?.state === "secret";
}

/** Line errors in text output carry the same CLI remedy the JSON envelope does (from core's ERROR_CODES). */
function errorText(error: string | undefined, code: string | undefined): string {
  if (!error) return code ?? "";
  const hint = cliHint(code as ErrorCode | undefined);
  const text = hint ? `${error} ${hint}` : error;
  return code ? `${code}: ${text}` : text;
}

interface Row {
  symbol: string;
  id: string;
  op: string;
  status: string;
  detail: string;
  /** Extra lines printed under the row. */
  sub: string[];
}

function table(rows: Row[], color: boolean): string {
  const idW = Math.max(...rows.map((r) => r.id.length));
  const opW = Math.max(...rows.map((r) => r.op.length));
  const stW = Math.max(...rows.map((r) => r.status.length));
  const out: string[] = [];
  for (const r of rows) {
    const line = `${r.symbol} ${r.id.padEnd(idW)}  ${r.op.padEnd(opW)}  ${r.status.padEnd(stW)}  ${r.detail}`.trimEnd();
    out.push(paint(r.symbol, line, color));
    for (const s of r.sub) out.push(`    ${s}`);
  }
  return out.join("\n");
}

/** Drift not already said on a line of the table (`shown`: whether that line says it). */
function driftSection(drift: Drift[], shown: (d: Drift) => boolean = () => false): string {
  const rest = drift.filter((d) => !shown(d));
  if (rest.length === 0) return "";
  const kindW = Math.max(...rest.map((d) => d.kind.length));
  const adW = Math.max(...rest.map((d) => d.adapter.length));
  return "\ndrift\n" + rest.map((d) => `  ${d.kind.padEnd(kindW)}  ${d.adapter.padEnd(adW)}  ${d.message}`).join("\n") + "\n";
}

function warningsSection(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return "\nwarnings\n" + warnings.map((w) => `  ${w}`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/** What happened outside Sponson to each resource a line manages, by `line\0resourceKey`, from the plan's drift. */
function driftByResource(drift: Drift[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of drift) {
    if (d.kind === "changed" && d.line) out.set(`${d.line}\u0000${d.resource.key}`, d.replaced ? "deleted and re-created outside Sponson" : "changed outside Sponson");
  }
  return out;
}

/**
 * A plan line as a row. The resource identity is said once per line: a drifted resource says what happened to it on
 * its own sub-row, so the refused line's detail keeps only the code and the remedy.
 */
function planRow(l: PlanLine, drifted: Map<string, string>): Row {
  const row: Row = { symbol: PLAN_SYMBOL[l.status], id: l.id, op: `${l.adapter}.${l.op}`, status: l.status, detail: "", sub: [] };
  const driftOf = (d: ResourceDiff) => drifted.get(`${l.id}\u0000${d.key}`);
  const text = (d: ResourceDiff) => diffText(d, driftOf(d));
  const diffRows = () => l.diffs.map((d) => `${PLAN_SYMBOL[d.kind]} ${text(d)}`);
  if (l.status === "pending") {
    row.detail = l.waitingOn ? `waiting on \`${l.waitingOn}\`${l.waitingFor ? ` (${l.waitingFor})` : ""}` : `waiting${l.waitingFor ? ` on ${l.waitingFor}` : ""}`;
    row.sub = diffRows();
  } else if (l.status === "error" || l.status === "blocked") {
    const saidBelow = l.status === "blocked" && l.errorCode === "DRIFT_CHANGED" && l.diffs.some(driftOf);
    row.detail = saidBelow ? `DRIFT_CHANGED: ${cliHint("DRIFT_CHANGED")}` : errorText(l.error, l.errorCode);
    if (l.status === "blocked") row.sub = diffRows();
  } else if (l.manual) {
    row.detail = `by hand: ${l.manual.title}`;
    row.sub = todoText(l.manual);
  } else if (l.diffs.length === 1) {
    row.detail = text(l.diffs[0]!);
  } else if (l.diffs.length > 1) {
    row.sub = diffRows();
  }
  return row;
}

/** Whether a line of the plan's table shows the drifted resource (its diff), so the drift section need not. */
function shownInPlan(lines: PlanLine[]): (d: Drift) => boolean {
  return (d) => d.kind === "changed" && lines.some((l) => l.id === d.line && l.status !== "error" && !l.manual && l.diffs.some((x) => x.key === d.resource.key));
}

export function planSummary(lines: PlanLine[]): string {
  const counts = new Map<PlanLineStatus, number>();
  for (const l of lines) counts.set(l.status, (counts.get(l.status) ?? 0) + 1);
  const label: Record<PlanLineStatus, string> = { create: "to create", update: "to update", unchanged: "unchanged", run: "to run", pending: "pending", todo: "to do by hand", blocked: "blocked", error: "error" };
  const parts = (Object.keys(label) as PlanLineStatus[]).filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${label[s]}`);
  return parts.length ? parts.join(", ") : "nothing to do";
}

export function renderPlan(result: PlanResult, opts: RenderOptions): string {
  const header = `sponson plan · ${result.environment} · ${result.scope} · plan ${result.planHash.slice(0, 8)}`;
  const notes: string[] = [];
  if (result.lock) notes.push(`! an apply is running on this scope; this plan may change (lock held by ${result.lock.holder} until ${result.lock.expiresAt})`);
  if (result.requiresApproval) notes.push("! apply needs approval: it writes to production (--approved-by <who>, from a human)");
  const noteText = notes.length ? `\n${notes.join("\n")}\n` : "";
  const drifted = driftByResource(result.drift);
  const body = result.lines.length ? table(result.lines.map((l) => planRow(l, drifted)), opts.color) : "(no lines for this environment)";
  return `${header}\n${noteText}\n${body}\n${driftSection(result.drift, shownInPlan(result.lines))}${warningsSection(result.warnings)}\n${planSummary(result.lines)}\n`;
}

/**
 * A manual step for the person who must do it (ADR 0021): its instructions as written, then how to say it is done.
 * Shown whole, never truncated: it is the only place a person reads them.
 */
function todoText(t: ManualTodo): string[] {
  const done = t.action === "do" ? "Then confirm it" : "Then confirm the undo";
  const verify = t.action === "do" && t.observable ? " (or let its verify request see it: the next apply records it)" : "";
  const flag = t.action === "do" ? `sponson apply --confirm ${t.line}` : `sponson apply --destroy --confirm ${t.line}`;
  return [...t.instructions.replace(/\s+$/, "").split("\n").map((l) => `| ${l}`.trimEnd()), `${done}: ${flag}${verify}`];
}

function manualSection(todos: ManualTodo[] | undefined): string {
  if (!todos?.length) return "";
  const blocks = todos.map((t) => [`  ${t.line}: ${t.action === "undo" ? "undo " : ""}${t.title}`, ...todoText(t).map((l) => `    ${l}`)].join("\n"));
  return `\nmanual steps (a person does these; agents never confirm them)\n${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function receiptRow(l: ReceiptLine): Row {
  const row: Row = { symbol: LINE_SYMBOL[l.status], id: l.id, op: `${l.adapter}.${l.op}`, status: l.status, detail: "", sub: [] };
  if (l.orphan) row.detail = "(removed from the plan; left alone)";
  else if (l.status === "waiting") row.detail = `waiting on ${l.waitingFor ?? "external event"}`;
  else if (l.error || l.errorCode) row.detail = errorText(l.error, l.errorCode);
  else row.detail = l.resources.map((r) => r.label ?? r.key).join(", ");
  return row;
}

/** What a partial run waits on, by event, and which lines are blocked. */
function partialParts(lines: ReceiptLine[]): string[] {
  const byEvent = new Map<string, string[]>();
  for (const l of lines) if (l.status === "waiting") byEvent.set(l.waitingFor ?? "external event", [...(byEvent.get(l.waitingFor ?? "external event") ?? []), l.id]);
  const blocked = lines.filter((l) => l.status === "blocked").map((l) => l.id);
  const parts = [...byEvent].map(([ev, ids]) => `waiting on ${ev} for lines ${ids.join(", ")}`);
  if (blocked.length) parts.push(`blocked: ${blocked.join(", ")}`);
  return parts;
}

/**
 * The run's outcome in one line. `brief`: under the table, whose row already says what went wrong and the fix, a
 * failure names the line and its code only; alone (the MCP summary) it says it all.
 */
export function finalLine(summary: ApplyResultSummary, brief = false): string {
  const { receipt } = summary;
  const verb = receipt.destroy ? "destroy" : "apply";
  if (receipt.stale) {
    const newest = receipt.history.at(-1)?.sha;
    return `${verb} skipped (stale): a newer commit${newest ? ` (${newest.slice(0, 7)})` : ""} was already applied to this scope`;
  }
  const lines = Object.values(receipt.lines).filter((l) => !l.orphan);
  if (receipt.status === "complete") return `${verb} complete`;
  if (receipt.status === "partial") return `${verb} partial: ${partialParts(lines).join("; ")}`;
  const first = lines.find((l) => ["failed", "rollback_failed", "destroy_failed", "blocked"].includes(l.status));
  if (!first) return `${verb} failed: unknown error`;
  if (brief) return `${verb} failed: ${first.id} (${first.errorCode ?? first.status}, above)`;
  return `${verb} failed: ${first.id}: ${errorText(first.error, first.errorCode) || first.status}`;
}

/**
 * The apply (or destroy) report. Outputs are listed for what exists after the run: a destroy deleted what they
 * describe, so it lists none (the receipt keeps them). A drift the refused line's error already states (its
 * resource named in the message) is not repeated in the drift section.
 */
export function renderApply(summary: ApplyResultSummary, opts: RenderOptions): string {
  const { receipt } = summary;
  const approval = receipt.approvedBy ? ` · approved by ${receipt.approvedBy}` : "";
  const header = `sponson ${receipt.destroy ? "apply --destroy" : "apply"} · ${receipt.environment} · ${receipt.scope} · run ${receipt.runId}${approval}`;
  const lines = Object.values(receipt.lines);
  const body = lines.length ? table(lines.map(receiptRow), opts.color) : "(nothing to do)";
  const outputs = receipt.destroy ? [] : lines.flatMap((l) => Object.entries(l.outputs).map(([k, v]) => `  ${l.id}.${k} = ${String(v)}`));
  const outputSection = outputs.length ? `\noutputs\n${outputs.join("\n")}\n` : "";
  const saidOnLine = (d: Drift) => d.kind === "changed" && lines.some((l) => l.id === d.line && l.errorCode === "DRIFT_CHANGED" && (l.error ?? "").includes(d.resource.label ?? d.resource.key));
  return `${header}\n\n${body}\n${outputSection}${manualSection(summary.manual)}${driftSection(summary.drift, saidOnLine)}${warningsSection(summary.warnings)}\n${finalLine(summary, true)}\n`;
}

// ---------------------------------------------------------------------------
// JSON envelopes: engine data passed through, nothing added for display.
// ---------------------------------------------------------------------------

export function planJson(result: PlanResult, ok: boolean) {
  return {
    ok,
    command: "plan" as const,
    environment: result.environment,
    scope: result.scope,
    planHash: result.planHash,
    requiresApproval: result.requiresApproval,
    lock: result.lock,
    lines: result.lines,
    drift: result.drift,
    warnings: result.warnings,
  };
}

/**
 * The apply envelope. `code` is the command's exit code: 0 is `ok`. Manual steps left for a person come as `manual`,
 * and, when nothing failed, as the reason the command did not succeed (`error.code` MANUAL_STEP_PENDING).
 */
export function applyJson(summary: ApplyResultSummary, code: number) {
  const manual = summary.manual?.length ? summary.manual : undefined;
  return {
    ok: code === 0,
    command: "apply" as const,
    receipt: summary.receipt,
    drift: summary.drift,
    warnings: summary.warnings,
    ...(manual ? { manual } : {}),
    ...(manual && summary.receipt.status !== "failed" ? { error: manualError(manual) } : {}),
  };
}

function manualError(manual: ManualTodo[]) {
  const steps = manual.map((t) => `\`${t.line}\` (${t.action === "undo" ? "undo: " : ""}${t.title})`).join(", ");
  const hint = cliHint("MANUAL_STEP_PENDING");
  return {
    code: "MANUAL_STEP_PENDING" as const,
    message: `${manual.length === 1 ? "A manual step waits" : `${manual.length} manual steps wait`} for a person: ${steps}. Their instructions are in \`manual\`.`,
    ...(hint ? { hint } : {}),
    lines: manual.map((t) => t.line),
  };
}
