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
  const env = overrides.env ?? processEnv.SPONSON_CTX_ENV ?? "preview";

  let branch = overrides.branch ?? processEnv.SPONSON_CTX_BRANCH ?? processEnv.GITHUB_HEAD_REF ?? processEnv.GITHUB_REF_NAME;
  let sha = overrides.sha ?? processEnv.SPONSON_CTX_SHA ?? processEnv.GITHUB_SHA;
  let pr: number | null | undefined = overrides.pr;

  if (pr === undefined && processEnv.SPONSON_CTX_PR !== undefined) {
    pr = processEnv.SPONSON_CTX_PR === "" ? null : Number(processEnv.SPONSON_CTX_PR);
  }
  if (pr === undefined) pr = await prFromGithub(processEnv);

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
    scope: scopeFor(branch, pr ?? null),
  };
}

export function scopeFor(branch: string, pr: number | null): string {
  if (pr !== null) return `pr-${pr}`;
  if (branch === "main" || branch === "master") return "main";
  return `branch-${branch.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

async function prFromGithub(env: NodeJS.ProcessEnv): Promise<number | null | undefined> {
  const ref = env.GITHUB_REF ?? "";
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  if (m) return Number(m[1]);
  if (env.GITHUB_EVENT_PATH) {
    try {
      const payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
      const n = payload?.pull_request?.number ?? payload?.number;
      if (typeof n === "number") return n;
      // deployment_status events carry no PR; fall back to branch-based scope lookup later.
      if (env.GITHUB_ACTIONS) return null;
    } catch {
      /* ignore: not every event has a payload we understand */
    }
  }
  if (env.GITHUB_ACTIONS) return null;
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
