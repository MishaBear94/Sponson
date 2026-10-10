import { SponsonError } from "./errors.js";
import type { Ctx } from "./types.js";

// The pure half of the run context. Core takes a finished `Ctx`; detecting one (CI variables, git, `gh`)
// belongs to the caller: `detectCtx` in the `sponson` CLI package.

/**
 * The lifecycle unit a run belongs to: `pr-<n>` inside a pull request, `main` on the default branch, else
 * `branch-<sanitised name>`. `defaultBranch` is the repository's default branch when known (GitHub event
 * payloads carry it); it maps to `main` too. Receipts, locks and the ledger are kept per scope.
 */
export function scopeFor(branch: string, pr: number | null, defaultBranch?: string): string {
  if (pr !== null) return `pr-${pr}`;
  if (branch === "main" || branch === "master" || (defaultBranch !== undefined && branch === defaultBranch)) return "main";
  return `branch-${branch.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Interpolation: `${ctx.pr.number}` inside string params.
// ---------------------------------------------------------------------------

const INTERP = /\$\{ctx\.([a-z_.]+)\}/g;

/**
 * Replace `${ctx.…}` in every string of `value` (deeply). The engine calls it on each line's params; `where`
 * names the line in errors. Throws CTX_NULL for an unknown variable, or a null one (`ctx.pr.number` outside a PR).
 */
export function interpolate(value: Record<string, unknown>, ctx: Ctx, where: string): Record<string, unknown>;
export function interpolate(value: unknown, ctx: Ctx, where: string): unknown;
export function interpolate(value: unknown, ctx: Ctx, where: string): unknown {
  if (typeof value === "string") {
    return value.replace(INTERP, (_m, path: string) => {
      const v = lookup(ctx, path);
      if (v === undefined) {
        throw new SponsonError("CTX_NULL", `${where}: unknown context variable \`ctx.${path}\`. Available: ctx.env, ctx.git.branch, ctx.git.sha, ctx.git.short_sha, ctx.pr.number, ctx.scope`, { where, variable: path });
      }
      if (v === null) {
        throw new SponsonError(
          "CTX_NULL",
          `${where}: \`ctx.${path}\` is null here (not running inside a pull request). Use \`\${ctx.scope}\` instead, or pass --pr <number>.`,
          { where, variable: path },
        );
      }
      return String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, ctx, `${where}[${i}]`));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, ctx, `${where}.${k}`);
    return out;
  }
  return value;
}

function lookup(ctx: Ctx, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
