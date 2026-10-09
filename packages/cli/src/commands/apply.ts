import { applyRun, destroyRun, type ApplyResultSummary, type Redactor } from "@sponson/core";
import { UsageError, buildRunContext, cleanApprover, toRunOptions, type GlobalOpts, type IO } from "../context.js";
import { withRedactorWarnings } from "../output.js";
import { applyJson, renderApply } from "../render.js";

export interface ApplyOpts extends GlobalOpts {
  destroy?: boolean;
  approvedBy?: string;
  reconcile?: boolean;
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
  const rc = await buildRunContext(opts, io, redactor);
  const run = toRunOptions(rc, io, {
    // Whitespace is not a name: an empty approver is no approver.
    approvedBy: cleanApprover(opts.approvedBy) ?? cleanApprover(io.env.SPONSON_APPROVED_BY),
    reconcile: opts.reconcile,
    wait: opts.wait,
    waitTimeoutMs,
  });
  const summary = opts.destroy ? await destroyRun(run) : await applyRun(run);
  summary.warnings = withRedactorWarnings([...rc.warnings, ...summary.warnings], redactor);
  return { summary, code: summary.receipt.status === "failed" ? 1 : 0 };
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
