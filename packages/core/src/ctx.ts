import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { SponsonError } from "./errors.js";
import type { Ctx } from "./types.js";

const exec = promisify(execFile);

export interface CtxOverrides {
  env?: string;
  branch?: string;
  sha?: string;
  pr?: number | null;
}

/**
 * Build the runtime context. Precedence: explicit overrides > SPONSON_CTX_* env > CI env > local git.
 * `env` defaults to `preview`; production is never inferred.
 */
export async function detectCtx(
  overrides: CtxOverrides = {},
  processEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<Ctx> {
  // CI systems export variables that do not apply to this event as empty strings (GitHub sets
  // GITHUB_HEAD_REF="" on a push). An empty value is "not set", never a value.
  const v = (name: string): string | undefined => nonEmpty(processEnv[name]);
  const env = nonEmpty(overrides.env) ?? v("SPONSON_CTX_ENV") ?? "preview";

  let branch = nonEmpty(overrides.branch) ?? v("SPONSON_CTX_BRANCH") ?? v("GITHUB_HEAD_REF") ?? v("GITHUB_REF_NAME");
  let sha = nonEmpty(overrides.sha) ?? v("SPONSON_CTX_SHA") ?? v("GITHUB_SHA");
  let pr: number | null | undefined = overrides.pr;

  // SPONSON_CTX_PR="" is the one deliberate empty value: "there is no pull request" (skips `gh` lookups).
  if (pr === undefined && processEnv.SPONSON_CTX_PR !== undefined) {
    const raw = processEnv.SPONSON_CTX_PR.trim();
    if (raw === "") pr = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new SponsonError("CTX_NULL", `SPONSON_CTX_PR must be a positive integer or empty (got ${JSON.stringify(raw)})`, { variable: "SPONSON_CTX_PR" });
      pr = n;
    }
  }
  const payload = await eventPayload(processEnv);
  if (pr === undefined) pr = prFromGithub(processEnv, payload);

  if (!branch || !sha) {
    const git = await gitInfo(cwd);
    branch ??= git.branch;
    sha ??= git.sha;
  }
  if (pr === undefined) pr = await prFromGhCli(cwd);

  const short_sha = sha.slice(0, 7);
  return {
    env,
    git: { branch, sha, short_sha },
    pr: { number: pr ?? null },
    scope: scopeFor(branch, pr ?? null, defaultBranchOf(payload)),
  };
}

function nonEmpty(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}

/** `defaultBranch`: the repository's default branch when known (GitHub event payloads carry it); it maps to `main` too. */
export function scopeFor(branch: string, pr: number | null, defaultBranch?: string): string {
  if (pr !== null) return `pr-${pr}`;
  if (branch === "main" || branch === "master" || (defaultBranch !== undefined && branch === defaultBranch)) return "main";
  return `branch-${branch.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

/** The fields of a GitHub event payload context detection reads. */
interface EventPayload {
  number?: unknown;
  pull_request?: { number?: unknown } | null;
  repository?: { default_branch?: unknown } | null;
}

async function eventPayload(env: NodeJS.ProcessEnv): Promise<EventPayload | null> {
  const path = nonEmpty(env.GITHUB_EVENT_PATH);
  if (!path) return null;
  try {
    const payload = JSON.parse(await readFile(path, "utf8"));
    return payload && typeof payload === "object" ? (payload as EventPayload) : null;
  } catch {
    return null; // not every event has a payload we understand
  }
}

function defaultBranchOf(payload: EventPayload | null): string | undefined {
  const b = payload?.repository?.default_branch;
  return typeof b === "string" && b !== "" ? b : undefined;
}

function prFromGithub(env: NodeJS.ProcessEnv, payload: EventPayload | null): number | null | undefined {
  const ref = nonEmpty(env.GITHUB_REF) ?? "";
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  if (m) return Number(m[1]);
  const n = payload?.pull_request?.number ?? payload?.number;
  if (typeof n === "number") return n;
  // push and deployment_status events carry no PR: inside Actions that means "no PR", not "ask gh".
  if (nonEmpty(env.GITHUB_ACTIONS)) return null;
  return undefined;
}

async function gitInfo(cwd: string): Promise<{ branch: string; sha: string }> {
  try {
    const [{ stdout: branch }, { stdout: sha }] = await Promise.all([
      exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
      exec("git", ["rev-parse", "HEAD"], { cwd }),
    ]);
    return { branch: branch.trim(), sha: sha.trim() };
  } catch {
    throw new SponsonError("CTX_NULL", "Not in a git repository and no branch/sha given. Pass --branch and --sha, or set SPONSON_CTX_BRANCH / SPONSON_CTX_SHA.");
  }
}

async function prFromGhCli(cwd: string): Promise<number | null> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd, timeout: 5000 });
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interpolation: `${ctx.pr.number}` inside string params.
// ---------------------------------------------------------------------------

const INTERP = /\$\{ctx\.([a-z_.]+)\}/g;

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
