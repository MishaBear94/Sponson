import { resolve } from "node:path";
import {
  GitBranchReceiptStore,
  LocalReceiptStore,
  PLAN_FILENAME,
  type Redactor,
  type SponsonError,
  detectCtx,
  loadPlan,
  type Ctx,
  type Plan,
  type ReceiptStore,
  type Registry,
  type RunOptions,
} from "@sponson/core";

/** Streams and environment for one in-process invocation. Tests and the MCP server supply their own. */
export interface IO {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
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

export interface RunContext {
  plan: Plan;
  planPath: string;
  ctx: Ctx;
  store: ReceiptStore;
  registry: Registry;
  redactor: Redactor;
  warnings: string[];
}

/** Wrong invocation (not a plan or provider problem). Exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export function planPathFor(opts: GlobalOpts, io: IO): string {
  return resolve(io.cwd, opts.plan ?? PLAN_FILENAME);
}

/** Load the plan, detect the context, pick a receipt store and build the registry. */
export async function buildRunContext(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<RunContext> {
  const planPath = planPathFor(opts, io);
  const { plan, warnings: parseWarnings } = await loadPlan(planPath);
  const warnings = parseWarnings.map((w) => w.message);
  const ctx = await detectCtx(
    { env: opts.env, branch: opts.branch, sha: opts.sha, pr: parsePr(opts.pr) },
    io.env,
    io.cwd,
  );
  const store = await selectStore(opts, plan, io, (m) => warnings.push(m));
  const registry = await io.createRegistry();
  return { plan, planPath, ctx, store, registry, redactor, warnings };
}

export function toRunOptions(rc: RunContext, io: IO, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    plan: rc.plan,
    ctx: rc.ctx,
    registry: rc.registry,
    store: rc.store,
    env: io.env,
    redactor: rc.redactor,
    // Adapter logs go to stderr so `--json` stdout stays parseable.
    log: (m) => io.stderr.write(`${m}\n`),
    ...extra,
  };
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

async function selectStore(opts: GlobalOpts, plan: Plan, io: IO, warn: (m: string) => void): Promise<ReceiptStore> {
  const kind = opts.receipts ?? plan.receipts;
  const localRoot = localReceiptsRoot(opts, io);
  if (kind === "git-branch") {
    const remote = opts.receiptsRemote ?? io.env.SPONSON_RECEIPTS_REMOTE ?? (await GitBranchReceiptStore.originOf(io.cwd));
    if (remote) return new GitBranchReceiptStore({ remote });
    warn(`No git remote found for receipts; using the local store at ${localRoot}. Pass --receipts-remote <url>, or set \`receipts: local\` in the plan to silence this.`);
  }
  return new LocalReceiptStore(localRoot);
}

/** Exit codes: 2 = the invocation or the plan is wrong, 3 = another apply holds the lock, 1 = anything else. */
export function exitCodeFor(e: SponsonError): number {
  if (e.code === "LOCK_HELD") return 3;
  if (/^(PLAN_|REF_|ENV_)/.test(e.code) || ["CTX_NULL", "SECRET_LITERAL", "ADAPTER_UNKNOWN", "OP_UNKNOWN"].includes(e.code)) return 2;
  return 1;
}
