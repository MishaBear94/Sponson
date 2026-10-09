/**
 * Shared fixtures for the concurrency journeys: many actors (CI jobs, a developer, an agent) on one fake cloud and
 * one receipts store. Not a test file.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { onTestFinished } from "vitest";
import { createRegistry } from "@sponson/adapters";
import { detectCtx, loadPlan, Redactor, type ReceiptStore, type RunOptions } from "@sponson/core";
import type { SimHandle } from "@sponson/sim";
import { CLI_COMMAND, workspace } from "../../support.js";

export const exec = promisify(execFile);
export const REPO = new URL("../../../", import.meta.url).pathname;
const TSX = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const BIN = join(REPO, "packages/cli/src/bin.ts");

export const PLAN = `version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }
`;

/** A scratch directory (a TMPDIR, a store root, a workdir) removed when the current test finishes. */
export async function tmp(prefix: string, opts: { plan?: string } = {}): Promise<string> {
  const ws = await workspace(`cc-${prefix}`, opts);
  onTestFinished(ws.cleanup);
  return ws.dir;
}

export async function bareRemote(): Promise<string> {
  const dir = await tmp("remote");
  await exec("git", ["init", "--bare", "-q", "--initial-branch=main", dir]);
  return dir;
}

/** A checkout of the user's repo as one actor sees it: just the plan file. */
export function checkout(plan = PLAN): Promise<string> {
  return tmp("ws", { plan });
}

/** Each PR has its own head commit (and so its own preview deployment URL). */
export function shaFor(pr: number): string {
  return `${pr}`.padStart(8, "0").padEnd(40, "c");
}

export function ctxArgs(pr: number, sha = shaFor(pr)): string[] {
  return ["--pr", String(pr), "--branch", `feat/pr-${pr}`, "--sha", sha];
}

/** A finished CLI process: like support's CliRun, but a killed process has no exit code. */
export interface ProcessResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json: Record<string, any> | null;
}

function parse(stdout: string): Record<string, any> | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** A separate OS process running the real CLI (one CI runner, or a developer's terminal). */
export function spawnCli(argv: string[], cwd: string, env: NodeJS.ProcessEnv): { child: ChildProcess; done: Promise<ProcessResult> } {
  const child = spawn(process.execPath, ["--import", TSX, BIN, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const done = new Promise<ProcessResult>((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, json: parse(stdout) })));
  return { child, done };
}

export const MCP_COMMAND = { command: CLI_COMMAND.command, args: [...CLI_COMMAND.args, "mcp"] };

/** RunOptions for driving the engine directly (needed for lockTtlMs, which the CLI does not expose). */
export async function engineOpts(cwd: string, env: NodeJS.ProcessEnv, pr: number, store: ReceiptStore, extra: Partial<RunOptions> = {}): Promise<RunOptions> {
  const { plan } = await loadPlan(join(cwd, "release.plan.yaml"));
  const ctx = await detectCtx({ env: "preview", pr, branch: `feat/pr-${pr}`, sha: shaFor(pr) }, env, cwd);
  return { plan, ctx, registry: createRegistry(), store, env, redactor: new Redactor(), ...extra };
}

export function neonBranches(sim: SimHandle): string[] {
  return Object.values(sim.state.neon.projects).flatMap((p) => p.branches.map((b) => b.name));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Read a file from the receipts branch of a bare remote, or null. */
export async function remoteFile(remote: string, path: string, branch = "sponson/receipts"): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["--git-dir", remote, "show", `${branch}:${path}`]);
    return stdout;
  } catch {
    return null;
  }
}

/** A human's own clone of the receipts branch, for tampering. */
export async function humanClone(remote: string): Promise<string> {
  const dir = await tmp("human");
  await exec("git", ["clone", "-q", "--branch", "sponson/receipts", remote, dir]);
  return dir;
}

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "user.name=human", "-c", "user.email=h@localhost", ...args], { cwd: dir });
  return stdout;
}
