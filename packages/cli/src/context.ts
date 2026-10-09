import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import {
  GitBranchReceiptStore,
  LocalReceiptStore,
  PLAN_FILENAME,
  type Redactor,
  SponsonError,
  detectCtx,
  loadPlan,
  type Ctx,
  type Plan,
  type AncestryCheck,
  type ReceiptStore,
  type Registry,
  type RunOptions,
} from "@sponson/core";

/** Streams and environment for one in-process invocation. Tests and the MCP server supply their own. */
export interface IO {
  /** Text for humans. Every chunk is redacted. */
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** Write one JSON envelope to stdout: redacted field by field, then serialized (see output.ts). */
  json(payload: unknown): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  createRegistry: () => Registry | Promise<Registry>;
  color: boolean;
}

export interface GlobalOpts {
  plan?: string;
  env?: string;
  pr?: string | number | null;
  branch?: string;
  sha?: string;
  json?: boolean;
  receipts?: "git-branch" | "local";
  receiptsDir?: string;
  receiptsRemote?: string;
}

/** Everything one CLI or MCP invocation resolved before calling the engine (not core's engine `RunContext`). */
export interface Invocation {
  plan: Plan;
  planPath: string;
  ctx: Ctx;
  store: ReceiptStore;
  registry: Registry;
  redactor: Redactor;
  warnings: string[];
}

/** Wrong invocation (not a plan or provider problem). Code USAGE, exit code 2. */
export class UsageError extends SponsonError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("USAGE", message, details);
    this.name = "UsageError";
  }
}

export function planPathFor(opts: GlobalOpts, io: IO): string {
  return resolve(io.cwd, opts.plan ?? PLAN_FILENAME);
}

/** Load the plan, detect the context, pick a receipt store and build the registry. */
export async function buildInvocation(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<Invocation> {
  const planPath = planPathFor(opts, io);
  const { plan, warnings: parseWarnings } = await loadPlan(planPath);
  const warnings = parseWarnings.map((w) => w.message);
  const ctx = await detectCtx(
    { env: opts.env, branch: opts.branch, sha: opts.sha, pr: parsePr(opts.pr) },
    io.env,
    io.cwd,
  );
  const store = await selectStore(opts, plan.receipts, io, (m) => warnings.push(m));
  const registry = await io.createRegistry();
  return { plan, planPath, ctx, store, registry, redactor, warnings };
}

export function toRunOptions(inv: Invocation, io: IO, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    plan: inv.plan,
    ctx: inv.ctx,
    registry: inv.registry,
    store: inv.store,
    env: io.env,
    redactor: inv.redactor,
    // Adapter logs go to stderr so `--json` stdout stays parseable.
    log: (m) => io.stderr.write(`${m}\n`),
    isAncestor: gitAncestry(io.cwd),
    ...extra,
  };
}

/** `git merge-base --is-ancestor`: exit 0 yes, 1 no, anything else (shallow clone, unknown sha) unknown. */
export function gitAncestry(cwd: string): AncestryCheck {
  return (older, newer) =>
    new Promise((resolve) => {
      execFile("git", ["merge-base", "--is-ancestor", older, newer], { cwd, timeout: 5000 }, (err) => {
        if (!err) return resolve(true);
        resolve((err as { code?: unknown }).code === 1 ? false : null);
      });
    });
}

/**
 * Who approved this run: `--approved-by` (or the MCP `approvedBy` argument), else `$SPONSON_APPROVED_BY`.
 * The CLI owns this fallback; the engine only sees the resolved name. Trimmed; blank counts as absent.
 */
export function resolveApprover(flag: unknown, env: NodeJS.ProcessEnv): string | undefined {
  return cleanApprover(flag) ?? cleanApprover(env.SPONSON_APPROVED_BY);
}

function cleanApprover(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t === "" ? undefined : t;
}

export function parsePr(raw: string | number | null | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--pr must be a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

export function localReceiptsRoot(opts: GlobalOpts, io: IO): string {
  return resolve(io.cwd, opts.receiptsDir ?? io.env.SPONSON_RECEIPTS_DIR ?? ".sponson/receipts");
}

/** `--receipts` wins over the plan's `receipts:` (`planKind`), which defaults to git-branch. */
export async function selectStore(opts: GlobalOpts, planKind: Plan["receipts"] | undefined, io: IO, warn: (m: string) => void): Promise<ReceiptStore> {
  const kind = opts.receipts ?? planKind ?? "git-branch";
  const localRoot = localReceiptsRoot(opts, io);
  if (kind === "git-branch") {
    const remote = opts.receiptsRemote ?? io.env.SPONSON_RECEIPTS_REMOTE ?? (await GitBranchReceiptStore.originOf(io.cwd));
    if (remote) return new GitBranchReceiptStore({ remote, fallbackDir: join(io.cwd, ".sponson/unpushed") });
    warn(`No git remote found for receipts; using the local store at ${localRoot}. Pass --receipts-remote <url>, or set \`receipts: local\` in the plan to silence this.`);
  }
  return new LocalReceiptStore(localRoot);
}

export { exitCodeFor } from "./output.js";
