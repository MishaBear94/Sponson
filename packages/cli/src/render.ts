import type { ApplyResultSummary, Drift, LineStatus, PlanLine, PlanLineStatus, PlanResult, ReceiptLine, ResourceDiff } from "@sponson/core";

export interface RenderOptions {
  color: boolean;
  /** Line id → name of the external event its outputs wait on (e.g. "deploy"), for pending lines. */
  events?: Record<string, string>;
}

const PLAN_SYMBOL: Record<PlanLineStatus, string> = { create: "+", update: "~", unchanged: "=", pending: "?", blocked: "-", error: "!" };
const LINE_SYMBOL: Record<LineStatus, string> = {
  applied: "+",
  unchanged: "=",
  waiting: "?",
  failed: "!",
  rolled_back: "-",
  rollback_failed: "!",
  skipped: "-",
  destroyed: "-",
  destroy_failed: "!",
};
const ANSI: Record<string, string> = { "+": "32", "~": "33", "=": "2", "!": "31" };

function paint(symbol: string, text: string, color: boolean): string {
  const code = ANSI[symbol];
  return color && code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function diffText(d: ResourceDiff): string {
  if (d.after === undefined) return d.label;
  return `${d.label}  ${d.before !== undefined ? `${d.before} → ` : ""}${d.after}`;
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

function planRow(l: PlanLine, events: Record<string, string>): Row {
  const row: Row = { symbol: PLAN_SYMBOL[l.status], id: l.id, op: `${l.adapter}.${l.op}`, status: l.status, detail: "", sub: [] };
  if (l.status === "pending") {
    const ev = l.waitingOn ? events[l.waitingOn] : undefined;
    row.detail = `waiting on \`${l.waitingOn}\`${ev ? ` (${ev})` : ""}`;
    row.sub = l.diffs.map((d) => `${PLAN_SYMBOL[d.kind]} ${diffText(d)}`);
  } else if (l.status === "error" || l.status === "blocked") {
    row.detail = l.error ?? "";
  } else if (l.diffs.length === 1) {
    row.detail = diffText(l.diffs[0]!);
  } else if (l.diffs.length > 1) {
    row.sub = l.diffs.map((d) => `${PLAN_SYMBOL[d.kind]} ${diffText(d)}`);
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
  const body = result.lines.length ? table(result.lines.map((l) => planRow(l, opts.events ?? {})), opts.color) : "(no lines for this environment)";
  return `${header}\n\n${body}\n${driftSection(result.drift)}${warningsSection(result.warnings)}\n${planSummary(result.lines)}\n`;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function receiptRow(l: ReceiptLine): Row {
  const row: Row = { symbol: LINE_SYMBOL[l.status], id: l.id, op: `${l.adapter}.${l.op}`, status: l.status, detail: "", sub: [] };
  if (l.orphan) row.detail = "(removed from the plan; left alone)";
  else if (l.status === "waiting") row.detail = `waiting on ${l.waitingFor ?? "external event"}`;
  else if (l.error) row.detail = l.error;
  else row.detail = l.resources.map((r) => r.label ?? r.key).join(", ");
  return row;
}

export function finalLine(summary: ApplyResultSummary): string {
  const { receipt } = summary;
  const verb = receipt.destroy ? "destroy" : "apply";
  const lines = Object.values(receipt.lines).filter((l) => !l.orphan);
  if (receipt.status === "complete") return `${verb} complete`;
  if (receipt.status === "partial") {
    const byEvent = new Map<string, string[]>();
    for (const l of lines) if (l.status === "waiting") byEvent.set(l.waitingFor ?? "external event", [...(byEvent.get(l.waitingFor ?? "external event") ?? []), l.id]);
    return `${verb} partial: ` + [...byEvent].map(([ev, ids]) => `waiting on ${ev} for lines ${ids.join(", ")}`).join("; ");
  }
  const first = lines.find((l) => ["failed", "rollback_failed", "destroy_failed"].includes(l.status));
  return `${verb} failed: ${first ? `${first.id}: ${first.error ?? first.status}` : "unknown error"}`;
}

export function renderApply(summary: ApplyResultSummary, opts: RenderOptions): string {
  const { receipt } = summary;
  const header = `sponson ${receipt.destroy ? "apply --destroy" : "apply"} · ${receipt.environment} · ${receipt.scope} · run ${receipt.runId}`;
  const lines = Object.values(receipt.lines);
  const body = lines.length ? table(lines.map(receiptRow), opts.color) : "(nothing to do)";
  const outputs = lines.flatMap((l) => Object.entries(l.outputs).map(([k, v]) => `  ${l.id}.${k} = ${String(v)}`));
  const outputSection = outputs.length ? `\noutputs\n${outputs.join("\n")}\n` : "";
  return `${header}\n\n${body}\n${outputSection}${driftSection(summary.drift)}${warningsSection(summary.warnings)}\n${finalLine(summary)}\n`;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function planJson(result: PlanResult, ok: boolean) {
  return {
    ok,
    command: "plan" as const,
    environment: result.environment,
    scope: result.scope,
    planHash: result.planHash,
    lines: result.lines,
    drift: result.drift,
    warnings: result.warnings,
  };
}

export function applyJson(summary: ApplyResultSummary, ok: boolean) {
  return { ok, command: "apply" as const, receipt: summary.receipt, drift: summary.drift, warnings: summary.warnings };
}

export function errorJson(error: { code: string; message: string; details?: Record<string, unknown> }) {
  return { ok: false, error: { code: error.code, message: error.message, ...(error.details ?? {}) } };
}
