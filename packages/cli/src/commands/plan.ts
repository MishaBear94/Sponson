import { planRun, type PlanResult, type Redactor } from "@sponson/core";
import { buildRunContext, toRunOptions, type GlobalOpts, type IO } from "../context.js";
import { withRedactorWarnings } from "../output.js";
import { planJson, renderPlan } from "../render.js";

export interface PlanOutcome {
  result: PlanResult;
  /** 0 unless a line is `error` or `blocked`. */
  code: number;
}

/** Shared by the CLI and the MCP server. */
export async function executePlan(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<PlanOutcome> {
  const rc = await buildRunContext(opts, io, redactor);
  const result = await planRun(toRunOptions(rc, io));
  result.warnings = withRedactorWarnings([...rc.warnings, ...result.warnings], redactor);
  const code = result.lines.some((l) => l.status === "error" || l.status === "blocked") ? 1 : 0;
  return { result, code };
}

export async function planCommand(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<number> {
  const { result, code } = await executePlan(opts, io, redactor);
  if (opts.json) io.json(planJson(result, code === 0));
  else io.stdout.write(renderPlan(result, { color: io.color }));
  return code;
}
