/**
 * Text rendering (for humans) and the JSON envelopes (for agents).
 * Display strings such as `(secret)` or `(pending ← db.x)` exist only here, in text; JSON carries engine data as-is.
 */
import type { ErrorCode, ApplyResultSummary, DiffSide, Drift, LineStatus, PlanLine, PlanLineStatus, PlanResult, ReceiptLine, ResourceDiff } from "@sponson/core";
import { cliHint } from "./output.js";

export interface RenderOptions {
  color: boolean;
}

export const PLAN_SYMBOL: Record<PlanLineStatus, string> = { create: "+", update: "~", unchanged: "=", pending: "?", blocked: "-", error: "!" };
export const LINE_SYMBOL: Record<LineStatus, string> = {
  applied: "+",
  unchanged: "=",
  waiting: "?",
  failed: "!",
  rolled_back: "-",
  rollback_failed: "!",
  skipped: "-",
  destroyed: "-",
  destroy_failed: "!",
  blocked: "-",
};
const ANSI: Record<string, string> = { "+": "32", "~": "33", "=": "2", "!": "31" };

function paint(symbol: string, text: string, color: boolean): string {
  const code = ANSI[symbol];
  return color && code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** One side of a diff as text; undefined when there is nothing to show (absent). */
export function sideText(s: DiffSide | undefined): string | undefined {
  if (!s) return undefined;
  switch (s.state) {
    case "literal":
      return s.value ?? "";
    case "sensitive":
      return "(secret)";
    case "pending":
      return s.ref ? `(pending ← ${s.ref})` : "(pending)";
    case "secret":
      return s.ref ? `(secret ← ${s.ref})` : "(secret)";
    case "absent":
      return undefined;
  }
}

export function diffText(d: ResourceDiff): string {
  const after = sideText(d.after);
  if (after === undefined) return d.label;
  const before = sideText(d.before);
  return `${d.label}  ${before !== undefined ? `${before} → ` : ""}${after}`;
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

function driftSection(drift: Drift[]): string {
  if (drift.length === 0) return "";
  const kindW = Math.max(...drift.map((d) => d.kind.length));
  const adW = Math.max(...drift.map((d) => d.adapter.length));
  return "\ndrift\n" + drift.map((d) => `  ${d.kind.padEnd(kindW)}  ${d.adapter.padEnd(adW)}  ${d.message}`).join("\n") + "\n";
}

function warningsSection(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return "\nwarnings\n" + warnings.map((w) => `  ${w}`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function planRow(l: PlanLine): Row {
  const row: Row = { symbol: PLAN_SYMBOL[l.status], id: l.id, op: `${l.adapter}.${l.op}`, status: l.status, detail: "", sub: [] };
  const diffRows = () => l.diffs.map((d) => `${PLAN_SYMBOL[d.kind]} ${diffText(d)}`);
  if (l.status === "pending") {
    row.detail = l.waitingOn ? `waiting on \`${l.waitingOn}\`${l.waitingFor ? ` (${l.waitingFor})` : ""}` : `waiting${l.waitingFor ? ` on ${l.waitingFor}` : ""}`;
    row.sub = diffRows();
  } else if (l.status === "error" || l.status === "blocked") {
    row.detail = errorText(l.error, l.errorCode);
    if (l.status === "blocked") row.sub = diffRows();
  } else if (l.diffs.length === 1) {
    row.detail = diffText(l.diffs[0]!);
  } else if (l.diffs.length > 1) {
    row.sub = diffRows();
  }
  return row;
}

export function planSummary(lines: PlanLine[]): string {
  const counts = new Map<PlanLineStatus, number>();
  for (const l of lines) counts.set(l.status, (counts.get(l.status) ?? 0) + 1);
  const label: Record<PlanLineStatus, string> = { create: "to create", update: "to update", unchanged: "unchanged", pending: "pending", blocked: "blocked", error: "error" };
  const parts = (Object.keys(label) as PlanLineStatus[]).filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${label[s]}`);
  return parts.length ? parts.join(", ") : "nothing to do";
}

export function renderPlan(result: PlanResult, opts: RenderOptions): string {
  const header = `sponson plan · ${result.environment} · ${result.scope} · plan ${result.planHash.slice(0, 8)}`;
  const notes: string[] = [];
  if (result.lock) notes.push(`! an apply is running on this scope; this plan may change (lock held by ${result.lock.holder} until ${result.lock.expiresAt})`);
  if (result.requiresApproval) notes.push("! apply needs approval: it writes to production (--approved-by <who>, from a human)");
  const noteText = notes.length ? `\n${notes.join("\n")}\n` : "";
  const body = result.lines.length ? table(result.lines.map(planRow), opts.color) : "(no lines for this environment)";
  return `${header}\n${noteText}\n${body}\n${driftSection(result.drift)}${warningsSection(result.warnings)}\n${planSummary(result.lines)}\n`;
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

export function finalLine(summary: ApplyResultSummary): string {
  const { receipt } = summary;
  const verb = receipt.destroy ? "destroy" : "apply";
  if (receipt.stale) {
    const newest = receipt.history.at(-1)?.sha;
    return `${verb} skipped (stale): a newer commit${newest ? ` (${newest.slice(0, 7)})` : ""} was already applied to this scope`;
  }
  const lines = Object.values(receipt.lines).filter((l) => !l.orphan);
  if (receipt.status === "complete") return `${verb} complete`;
  if (receipt.status === "partial") {
    const byEvent = new Map<string, string[]>();
    for (const l of lines) if (l.status === "waiting") byEvent.set(l.waitingFor ?? "external event", [...(byEvent.get(l.waitingFor ?? "external event") ?? []), l.id]);
    const blocked = lines.filter((l) => l.status === "blocked").map((l) => l.id);
    const parts = [...byEvent].map(([ev, ids]) => `waiting on ${ev} for lines ${ids.join(", ")}`);
    if (blocked.length) parts.push(`blocked: ${blocked.join(", ")}`);
    return `${verb} partial: ${parts.join("; ")}`;
  }
  const first = lines.find((l) => ["failed", "rollback_failed", "destroy_failed", "blocked"].includes(l.status));
  return `${verb} failed: ${first ? `${first.id}: ${errorText(first.error, first.errorCode) || first.status}` : "unknown error"}`;
}

export function renderApply(summary: ApplyResultSummary, opts: RenderOptions): string {
  const { receipt } = summary;
  const approval = receipt.approvedBy ? ` · approved by ${receipt.approvedBy}` : "";
  const header = `sponson ${receipt.destroy ? "apply --destroy" : "apply"} · ${receipt.environment} · ${receipt.scope} · run ${receipt.runId}${approval}`;
  const lines = Object.values(receipt.lines);
  const body = lines.length ? table(lines.map(receiptRow), opts.color) : "(nothing to do)";
  const outputs = lines.flatMap((l) => Object.entries(l.outputs).map(([k, v]) => `  ${l.id}.${k} = ${String(v)}`));
  const outputSection = outputs.length ? `\noutputs\n${outputs.join("\n")}\n` : "";
  return `${header}\n\n${body}\n${outputSection}${driftSection(summary.drift)}${warningsSection(summary.warnings)}\n${finalLine(summary)}\n`;
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

export function applyJson(summary: ApplyResultSummary, ok: boolean) {
  return { ok, command: "apply" as const, receipt: summary.receipt, drift: summary.drift, warnings: summary.warnings };
}
