import { applyRun, destroyRun, exitCodeFor, type ApplyResultSummary, type Redactor } from "@sponson/core";
import { UsageError, gitUser, resolveApprover, toRunOptions, withInvocation, type GlobalOpts, type IO } from "../context.js";
import { withRedactorWarnings } from "../output.js";
import { applyJson, renderApply } from "../render.js";

export interface ApplyOpts extends GlobalOpts {
  destroy?: boolean;
  approvedBy?: string;
  reconcile?: boolean;
  /** Line ids, or a comma-separated string of them (MCP). */
  recreate?: string[] | string;
  /** Manual steps a person did (ADR 0021): line ids, or a comma-separated string of them (MCP). */
  confirm?: string[] | string;
  wait?: boolean;
  /** Seconds. */
  waitTimeout?: string | number;
}

export interface ApplyOutcome {
  summary: ApplyResultSummary;
  /**
   * 0 for complete and partial (waiting on a deploy is not a failure), 1 for failed, and MANUAL_STEP_PENDING's exit
   * code (2) when a manual step waits for a person: that is not done until someone does it.
   */
  code: number;
}

/** Shared by the CLI and the MCP server. */
export async function executeApply(opts: ApplyOpts, io: IO, redactor: Redactor): Promise<ApplyOutcome> {
  const waitTimeoutMs = parseTimeout(opts.waitTimeout);
  return withInvocation(opts, io, redactor, async (inv) => {
    const approvedBy = resolveApprover(opts.approvedBy, io.env);
    const confirm = recreateList(opts.confirm);
    const run = toRunOptions(inv, io, {
      approvedBy,
      reconcile: opts.reconcile,
      recreate: recreateList(opts.recreate),
      ...(confirm ? { confirm, confirmedBy: await confirmer(approvedBy, io.cwd) } : {}),
      wait: opts.wait,
      waitTimeoutMs,
    });
    const summary = opts.destroy ? await destroyRun(run) : await applyRun(run);
    summary.warnings = withRedactorWarnings([...inv.warnings, ...summary.warnings], redactor);
    const code = summary.receipt.status === "failed" ? 1 : summary.manual?.length ? exitCodeFor("MANUAL_STEP_PENDING") : 0;
    return { summary, code };
  });
}

export async function applyCommand(opts: ApplyOpts, io: IO, redactor: Redactor): Promise<number> {
  const { summary, code } = await executeApply(opts, io, redactor);
  if (opts.json) io.json(applyJson(summary, code));
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

/** Who confirms a manual step: the approver when one is given, else the git user. */
async function confirmer(approvedBy: string | undefined, cwd: string): Promise<string> {
  const who = approvedBy ?? (await gitUser(cwd));
  if (!who) throw new UsageError("--confirm records who did the step: pass --approved-by <who> (or set SPONSON_APPROVED_BY), or configure git user.name / user.email");
  return who;
}

/** Line ids from a repeatable flag, or from a comma-separated string (MCP). */
function recreateList(raw: string[] | string | undefined): string[] | undefined {
  const ids = (typeof raw === "string" ? raw.split(",") : (raw ?? [])).map((v) => v.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}
