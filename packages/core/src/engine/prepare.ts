import { interpolate } from "../ctx.js";
import { SponsonError } from "../errors.js";
import { orderChanges, outputRefs } from "../graph.js";
import { changesFor } from "../plan.js";
import { secretRefs } from "../resolve.js";
import type { Change, OpSpec } from "../types.js";
import type { RunOptions } from "./types.js";

/** Everything about a run that follows from the plan and context alone, before touching any provider. */
export interface Prepared {
  ordered: Change[];
  ops: Map<string, OpSpec>;
  /** Interpolated params with op defaults applied; references still unresolved. */
  params: Map<string, Record<string, unknown>>;
  /** Every `secret:` reference used by the active lines. */
  secretRefs: string[];
  /** Applying may write to production: `--env production`, or a line targets production explicitly. */
  requiresApproval: boolean;
  /** Lines that write to production while the run's environment is not production (for messages). */
  productionLines: string[];
}

export function prepare(opts: RunOptions): Prepared {
  const { plan, ctx, registry } = opts;
  if (!plan.environments.includes(ctx.env)) {
    throw new SponsonError("ENV_UNKNOWN", `Unknown environment \`${ctx.env}\`. Declared: ${plan.environments.join(", ")}`, {
      environment: ctx.env,
      known: plan.environments,
    });
  }
  const ordered = orderChanges(changesFor(plan, ctx.env), plan.changes);
  const ops = new Map<string, OpSpec>();
  const params = new Map<string, Record<string, unknown>>();
  const refs = new Set<string>();
  const productionLines: string[] = [];

  for (const c of ordered) ops.set(c.id, registry.op(c.adapter, c.op));

  for (const c of ordered) {
    const op = ops.get(c.id)!;
    // Output names are static: a typo must fail at plan time, not after half an apply.
    for (const ref of outputRefs(c)) {
      const target = ordered.find((x) => x.id === ref.line)!;
      const known = Object.keys(ops.get(target.id)!.outputs);
      if (!known.includes(ref.output)) {
        throw new SponsonError(
          "REF_OUTPUT_UNKNOWN",
          `Line \`${c.id}\` reads \`${ref.line}.${ref.output}\`, but ${target.adapter}.${target.op} has no output \`${ref.output}\`. Known: ${known.join(", ") || "(none)"}`,
          { id: c.id, ref: `${ref.line}.${ref.output}`, known },
        );
      }
    }
    let p = interpolate(c.params, ctx, `line \`${c.id}\``);
    if (op.defaults) p = op.defaults(p, ctx);
    params.set(c.id, p);
    for (const r of secretRefs(p)) refs.add(r);
    if (ctx.env !== "production" && op.writesEnvironment?.(p, ctx) === "production") productionLines.push(c.id);
  }

  return {
    ordered,
    ops,
    params,
    secretRefs: [...refs],
    requiresApproval: ctx.env === "production" || productionLines.length > 0,
    productionLines,
  };
}

/**
 * Approval is a non-empty name; whitespace is not a person. Only `opts.approvedBy` counts: where it comes from
 * (a flag, an environment variable, an approval workflow) is the caller's business.
 */
export function requireApproval(opts: RunOptions, prepared: Prepared): string | undefined {
  if (!prepared.requiresApproval) return undefined;
  const approvedBy = (opts.approvedBy ?? "").trim();
  if (!approvedBy) {
    const n = prepared.productionLines.length;
    const why =
      opts.ctx.env === "production"
        ? "This run applies to production"
        : `Line${n > 1 ? "s" : ""} ${prepared.productionLines.map((l) => `\`${l}\``).join(", ")} write${n > 1 ? "" : "s"} to production although the environment is ${opts.ctx.env}`;
    throw new SponsonError("ENV_NOT_APPROVED", `${why}: approval is required (approvedBy).`, {
      environment: opts.ctx.env,
      productionLines: prepared.productionLines,
    });
  }
  return approvedBy;
}
