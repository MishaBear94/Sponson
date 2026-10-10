import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { SponsonError, scopeFor, type Ctx } from "@sponson/core";

const exec = promisify(execFile);

/** Values given explicitly (CLI flags, MCP arguments). They win over everything detected. */
export interface CtxOverrides {
  env?: string;
  branch?: string;
  sha?: string;
  /** `null` means "there is no pull request" and skips every PR lookup. */
  pr?: number | null;
}

/**
 * What one source knows about the run. `undefined` means "this source cannot tell"; `pr: null` is an answer
 * ("no pull request"), not a gap.
 */
export interface CtxFacts {
  env?: string;
  branch?: string;
  sha?: string;
  pr?: number | null;
  /** The repository's default branch, when the host knows it; it maps to scope `main` like `main` itself. */
  defaultBranch?: string;
}

/**
 * One place the run context can come from: a CI host, the environment, the local checkout.
 * Sources are consulted in order and the first one to answer a field wins, so a later source only fills gaps.
 * `known` is what earlier sources found; a source may skip an expensive lookup (spawning `git`, `gh`) for
 * a field that is already known. To support another CI host, add a source before `localGitSource`.
 */
export interface CtxSource {
  readonly name: string;
  detect(known: Readonly<CtxFacts>, env: NodeJS.ProcessEnv, cwd: string): Promise<CtxFacts>;
}

/**
 * Build the run context the way the CLI does. Precedence: `overrides` > `SPONSON_CTX_*` > CI host > local git.
 * `env` defaults to `preview`; production is never inferred.
 *
 * @example
 * ```ts
 * const ctx = await detectCtx({ env: "preview" }); // in a GitHub Actions job or a local checkout
 * await applyRun({ plan, ctx, registry, store });
 * ```
 */
export async function detectCtx(
  overrides: CtxOverrides = {},
  processEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  sources: readonly CtxSource[] = DEFAULT_CTX_SOURCES,
): Promise<Ctx> {
  let facts: CtxFacts = { env: nonEmpty(overrides.env), branch: nonEmpty(overrides.branch), sha: nonEmpty(overrides.sha), pr: overrides.pr };
  for (const source of sources) facts = fillGaps(facts, await source.detect(facts, processEnv, cwd));
  const { branch, sha, pr = null } = facts;
  if (branch === undefined || sha === undefined) throw notInRepository();
  return {
    env: facts.env ?? "preview",
    git: { branch, sha, short_sha: sha.slice(0, 7) },
    pr: { number: pr },
    scope: scopeFor(branch, pr, facts.defaultBranch),
  };
}

/** `??` would not do for `pr`: `null` is an answer ("no pull request") that a later source must not override. */
function fillGaps(known: CtxFacts, found: CtxFacts): CtxFacts {
  return {
    env: known.env ?? found.env,
    branch: known.branch ?? found.branch,
    sha: known.sha ?? found.sha,
    pr: known.pr === undefined ? found.pr : known.pr,
    defaultBranch: known.defaultBranch ?? found.defaultBranch,
  };
}

/** `SPONSON_CTX_ENV`, `_BRANCH`, `_SHA`, `_PR`: the host-neutral way to tell Sponson about the run. */
export const sponsonEnvSource: CtxSource = {
  name: "SPONSON_CTX_*",
  async detect(known, env) {
    return {
      env: nonEmpty(env.SPONSON_CTX_ENV),
      branch: nonEmpty(env.SPONSON_CTX_BRANCH),
      sha: nonEmpty(env.SPONSON_CTX_SHA),
      // Not even validated when --pr was given: the flag is the answer.
      pr: known.pr === undefined ? prFromSponsonEnv(env.SPONSON_CTX_PR) : undefined,
    };
  },
};

/** SPONSON_CTX_PR="" is the one deliberate empty value: "there is no pull request" (skips `gh` lookups). */
function prFromSponsonEnv(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) {
    throw new SponsonError("CTX_NULL", `SPONSON_CTX_PR must be a positive integer or empty (got ${JSON.stringify(trimmed)})`, { variable: "SPONSON_CTX_PR" });
  }
  return n;
}

/** GitHub Actions: `GITHUB_*` variables and the event payload at `GITHUB_EVENT_PATH`. */
export const githubActionsSource: CtxSource = {
  name: "github-actions",
  async detect(_known, env) {
    const payload = await eventPayload(env);
    return {
      branch: nonEmpty(env.GITHUB_HEAD_REF) ?? nonEmpty(env.GITHUB_REF_NAME),
      sha: nonEmpty(env.GITHUB_SHA),
      pr: prFromGithub(env, payload),
      defaultBranch: defaultBranchOf(payload),
    };
  },
};

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
    const payload: unknown = JSON.parse(await readFile(path, "utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null; // not every event has a payload we understand
  }
}

function defaultBranchOf(payload: EventPayload | null): string | undefined {
  const b = payload?.repository?.default_branch;
  return typeof b === "string" && b !== "" ? b : undefined;
}

function prFromGithub(env: NodeJS.ProcessEnv, payload: EventPayload | null): number | null | undefined {
  const m = /^refs\/pull\/(\d+)\//.exec(nonEmpty(env.GITHUB_REF) ?? "");
  if (m) return Number(m[1]);
  const n = payload?.pull_request?.number ?? payload?.number;
  if (typeof n === "number") return n;
  // push and deployment_status events carry no PR: inside Actions that means "no PR", not "ask gh".
  if (nonEmpty(env.GITHUB_ACTIONS)) return null;
  return undefined;
}

/** The local checkout: `git rev-parse` for branch and sha, `gh pr view` for the pull request. Last resort. */
export const localGitSource: CtxSource = {
  name: "local-git",
  async detect(known, _env, cwd) {
    const git = known.branch === undefined || known.sha === undefined ? await gitInfo(cwd) : {};
    const pr = known.pr === undefined ? await prFromGhCli(cwd) : undefined;
    return { ...git, pr };
  },
};

async function gitInfo(cwd: string): Promise<{ branch: string; sha: string }> {
  try {
    const [{ stdout: branch }, { stdout: sha }] = await Promise.all([
      exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
      exec("git", ["rev-parse", "HEAD"], { cwd }),
    ]);
    return { branch: branch.trim(), sha: sha.trim() };
  } catch {
    throw notInRepository();
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

function notInRepository(): SponsonError {
  return new SponsonError("CTX_NULL", "Not in a git repository and no branch/sha given. Pass --branch and --sha, or set SPONSON_CTX_BRANCH / SPONSON_CTX_SHA.");
}

/**
 * Trimmed, with blank meaning absent. CI systems export variables that do not apply to this event as empty
 * strings (GitHub sets GITHUB_HEAD_REF="" on a push): an empty value is "not set", never a value.
 */
export function nonEmpty(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t === "" ? undefined : t;
}

/** Explicit `SPONSON_CTX_*` first, then GitHub Actions, then the local checkout. */
export const DEFAULT_CTX_SOURCES: readonly CtxSource[] = [sponsonEnvSource, githubActionsSource, localGitSource];
