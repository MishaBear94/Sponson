import { applyRun, destroyRun, type ApplyResultSummary, type Redactor } from "@sponson/core";
import { UsageError, resolveApprover, toRunOptions, withInvocation, type GlobalOpts, type IO } from "../context.js";
import { withRedactorWarnings } from "../output.js";
import { applyJson, renderApply } from "../render.js";

export interface ApplyOpts extends GlobalOpts {
  destroy?: boolean;
  approvedBy?: string;
  reconcile?: boolean;
  /** Line ids, or a comma-separated string of them (MCP). */
  recreate?: string[] | string;
  wait?: boolean;
  /** Seconds. */
  waitTimeout?: string | number;
}

export interface ApplyOutcome {
  summary: ApplyResultSummary;
  /** 0 for complete and partial (waiting on a deploy is not a failure), 1 for failed. */
  code: number;
}

/** Shared by the CLI and the MCP server. */
export async function executeApply(opts: ApplyOpts, io: IO, redactor: Redactor): Promise<ApplyOutcome> {
  const waitTimeoutMs = parseTimeout(opts.waitTimeout);
  return withInvocation(opts, io, redactor, async (inv) => {
    const run = toRunOptions(inv, io, {
      approvedBy: resolveApprover(opts.approvedBy, io.env),
      reconcile: opts.reconcile,
      recreate: recreateList(opts.recreate),
      wait: opts.wait,
      waitTimeoutMs,
    });
    const summary = opts.destroy ? await destroyRun(run) : await applyRun(run);
    summary.warnings = withRedactorWarnings([...inv.warnings, ...summary.warnings], redactor);
    return { summary, code: summary.receipt.status === "failed" ? 1 : 0 };
  });
}

export async function applyCommand(opts: ApplyOpts, io: IO, redactor: Redactor): Promise<number> {
  const { summary, code } = await executeApply(opts, io, redactor);
  if (opts.json) io.json(applyJson(summary, code === 0));
  else io.stdout.write(renderApply(summary, { color: io.color }));
  return code;
}

function parseTimeout(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (typeof raw === "string" && raw.trim() === "") throw new UsageError("--wait-timeout must be a positive number of seconds (got \"\")");
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--wait-timeout must be a positive number of seconds (got ${JSON.stringify(raw)})`);
  return n * 1000;
}

function recreateList(raw: string[] | string | undefined): string[] | undefined {
  const ids = (typeof raw === "string" ? raw.split(",") : (raw ?? [])).map((v) => v.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}
