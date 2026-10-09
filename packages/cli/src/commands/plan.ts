import { planRun, type PlanResult, type Redactor } from "@sponson/core";
import { buildRunContext, toRunOptions, type GlobalOpts, type IO, type RunContext } from "../context.js";
import { planJson, renderPlan } from "../render.js";

export interface PlanOutcome {
  result: PlanResult;
  /** 0 unless a line is `error` or `blocked`. */
  code: number;
  events: Record<string, string>;
}

/** Shared by the CLI and the MCP server. */
export async function executePlan(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<PlanOutcome> {
  const rc = await buildRunContext(opts, io, redactor);
  const result = await planRun(toRunOptions(rc, io));
  result.warnings = [...rc.warnings, ...result.warnings];
  const code = result.lines.some((l) => l.status === "error" || l.status === "blocked") ? 1 : 0;
  return { result, code, events: externalEvents(rc) };
}

export async function planCommand(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<number> {
  const { result, code, events } = await executePlan(opts, io, redactor);
  if (opts.json) io.stdout.write(JSON.stringify(planJson(result, code === 0), null, 2) + "\n");
  else io.stdout.write(renderPlan(result, { color: io.color, events }));
  return code;
}

/** Which external event each line's outputs wait on, so `pending` rows can say "(deploy)". */
export function externalEvents(rc: RunContext): Record<string, string> {
  const events: Record<string, string> = {};
  for (const c of rc.plan.changes) {
    try {
      const ext = Object.values(rc.registry.op(c.adapter, c.op).outputs).find((o) => o.available === "external");
      if (ext) events[c.id] = ext.event ?? "external event";
    } catch {
      /* unknown adapter: the engine reports it on the line itself */
    }
  }
  return events;
}
