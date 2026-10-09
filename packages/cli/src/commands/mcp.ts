import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Redactor, SponsonError, detectCtx, isSponsonError, loadPlan, type Plan, type Receipt } from "@sponson/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { UsageError, parsePr, planPathFor, selectStore, type GlobalOpts, type IO } from "../context.js";
import { errorEnvelope, serialize, withRedactorWarnings } from "../output.js";
import { applyJson, finalLine, planJson, planSummary } from "../render.js";
import { executeApply } from "./apply.js";
import { executePlan } from "./plan.js";

// ---------------------------------------------------------------------------
// Arguments. The SDK validates arguments against the zod schema before the handler runs and answers a
// mismatch with a protocol error that is not our envelope. So the schema accepts anything for every field
// (and keeps unknown fields), and the handler validates strictly, answering USAGE in the envelope.
// ---------------------------------------------------------------------------

type ArgType = "string" | "boolean" | "positive integer" | "positive number";
interface ArgSpec {
  type: ArgType;
  description: string;
}

const SCOPE_ARGS: Record<string, ArgSpec> = {
  env: { type: "string", description: "Environment name. Defaults to `preview`. Production is never inferred." },
  pr: { type: "positive integer", description: "Pull request number, when known (a JSON number, not a string)." },
  branch: { type: "string", description: "Git branch. Defaults to the checked-out branch." },
  sha: { type: "string", description: "Git commit sha. Defaults to HEAD." },
  plan: { type: "string", description: "Path to release.plan.yaml. Defaults to the one in the working directory." },
};

const APPLY_ARGS: Record<string, ArgSpec> = {
  ...SCOPE_ARGS,
  destroy: { type: "boolean", description: "Destroy every resource this scope created (reverse order). Adopted resources are never touched." },
  approvedBy: { type: "string", description: "Who approved a production apply. Required when a line writes to production. Must come from a human; blank counts as absent." },
  reconcile: { type: "boolean", description: "Overwrite values that were changed outside Sponson since the last apply." },
  wait: { type: "boolean", description: "Poll for external events (deploys) instead of returning `partial`." },
  waitTimeout: { type: "positive number", description: "Seconds to wait when `wait` is true. Default 120." },
};

const MCP_WAIT_TIMEOUT_SECONDS = 120;

function inputSchema(spec: Record<string, ArgSpec>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, a] of Object.entries(spec)) shape[k] = z.unknown().optional().describe(`(${a.type}) ${a.description}`);
  return z.object(shape).passthrough();
}

function typeOk(v: unknown, t: ArgType): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "positive integer":
      return typeof v === "number" && Number.isInteger(v) && v > 0;
    case "positive number":
      return typeof v === "number" && Number.isFinite(v) && v > 0;
  }
}

/** Strict validation of tool arguments; every problem is a USAGE error naming the valid arguments. */
export function validateArgs(tool: string, args: unknown, spec: Record<string, ArgSpec>): Record<string, unknown> {
  const valid = Object.keys(spec);
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new UsageError(`${tool}: arguments must be an object`, { valid });
  const entries = Object.entries(args as Record<string, unknown>);
  const unknown = entries.map(([k]) => k).filter((k) => !(k in spec));
  if (unknown.length > 0) {
    throw new UsageError(`${tool}: unknown argument${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => `\`${k}\``).join(", ")}. Valid arguments: ${valid.join(", ")}`, { unknown, valid });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    const t = spec[k]!.type;
    if (!typeOk(v, t)) {
      const got = Array.isArray(v) ? "array" : typeof v;
      throw new UsageError(`${tool}: argument \`${k}\` must be a ${t} (got ${JSON.stringify(v)}, a ${got})`, { argument: k, expected: t, got });
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

const PLAN_DESCRIPTION =
  "Read-only. Reads live provider state, diffs it against release.plan.yaml for the given environment and returns every line's `status`: " +
  "create | update | unchanged | pending (waits on another line, `waitingOn`, or an event, `waitingFor`) | blocked (apply would refuse it; `errorCode` says why, e.g. DRIFT_CHANGED) | error (`errorCode`, `error`). " +
  "Also returns `drift`, `requiresApproval` and `lock` (an apply is running on this scope; the plan may change). Pending, secret and sensitive values are null, never text. " +
  "Nothing is changed. Call this first, show the human the diff, and stop before calling sponson_apply.";

const APPLY_DESCRIPTION =
  "Applies release.plan.yaml and returns the receipt. Only call after the human has seen the sponson_plan diff. " +
  "`receipt.status` is complete | partial | failed (and `receipt.stale: true` when a newer commit was already applied). " +
  "`receipt.lines[id].status` is applied | unchanged | waiting | failed | rolled_back | rollback_failed | skipped | blocked | destroyed | destroy_failed, with `errorCode` on failures. " +
  "If the status is `partial`, lines are waiting on an external event (usually a deploy): do NOT retry; wait for the deployment and re-run sponson_plan later, or let the deployment_status workflow finish it. " +
  "Writing to production is refused (ENV_NOT_APPROVED) without approvedBy; never supply approvedBy on your own, it must come from a human or an approval workflow. " +
  'Never write secret values into the plan; use `{ secret: "env://NAME" }` references. `destroy: true` tears down everything this scope created. ' +
  `\`wait: true\` polls for deploys for up to \`waitTimeout\` seconds (default ${MCP_WAIT_TIMEOUT_SECONDS}).`;

const RECEIPT_DESCRIPTION =
  "Read-only. Returns the latest receipt for this environment and scope (what the last apply actually did): overall `status` (complete | partial | failed), " +
  "per line `lines[id].status` (applied | unchanged | waiting | failed | rolled_back | rollback_failed | skipped | blocked | destroyed | destroy_failed) and `lines[id].outputs`, " +
  "and `ledger` (every resource Sponson manages here, with non-sensitive outputs such as `preview_url`). Returns `{ receipt: null }` when nothing has been applied. " +
  "Works even when the plan file is broken. Read this instead of inferring success from your last tool call.";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * `sponson mcp`: the three commands as MCP tools over stdio.
 * stdout is the transport, so every log line goes to stderr.
 * Every result's first line is one JSON envelope, the same the CLI prints with --json.
 */
export async function mcpCommand(base: GlobalOpts, io: IO): Promise<number> {
  const server = buildMcpServer(base, io);
  await server.connect(new StdioServerTransport());
  io.stderr.write("sponson mcp: listening on stdio\n");
  // Keep the process alive until the client closes the transport.
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  return 0;
}

/** The server with its three tools, not yet connected (tests connect it to an in-memory transport). */
export function buildMcpServer(base: GlobalOpts, io: IO): McpServer {
  const server = new McpServer({ name: "sponson", version: "0.2.0" });
  const tool = (
    name: string,
    command: string,
    title: string,
    description: string,
    spec: Record<string, ArgSpec>,
    handler: (args: Record<string, unknown>, redactor: Redactor, quiet: IO) => Promise<{ payload: unknown; summary: string }>,
  ) =>
    server.registerTool(name, { title, description, inputSchema: inputSchema(spec) }, async (raw: unknown): Promise<ToolResult> => {
      // One redactor per call: the engine registers into it; the result and every log line pass through it.
      // stdout is the MCP transport, so all text goes to stderr.
      const redactor = new Redactor();
      const log = { write: (s: string) => io.stderr.write(redactor.redact(s)) };
      const quiet: IO = { ...io, stdout: log, stderr: log, json: () => {} };
      try {
        const args = validateArgs(name, raw, spec);
        const { payload, summary } = await handler(args, redactor, quiet);
        return { content: [{ type: "text", text: `${serialize(payload, redactor, false)}\n${redactor.redact(summary)}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: serialize(errorEnvelope(command, e), redactor, false) }], isError: true };
      }
    });

  tool("sponson_plan", "plan", "Plan a release", PLAN_DESCRIPTION, SCOPE_ARGS, async (args, redactor, quiet) => {
    const { result, code } = await executePlan({ ...base, ...args, json: true }, quiet, redactor);
    return { payload: planJson(result, code === 0), summary: `plan ${result.environment}/${result.scope}: ${planSummary(result.lines)}` };
  });

  tool("sponson_apply", "apply", "Apply a release plan", APPLY_DESCRIPTION, APPLY_ARGS, async (args, redactor, quiet) => {
    const { summary, code } = await executeApply({ ...base, waitTimeout: MCP_WAIT_TIMEOUT_SECONDS, ...args, json: true }, quiet, redactor);
    return { payload: applyJson(summary, code === 0), summary: finalLine(summary) };
  });

  tool("sponson_receipt", "receipt", "Read the latest receipt", RECEIPT_DESCRIPTION, SCOPE_ARGS, async (args, redactor, quiet) => {
    const payload = await readReceipt({ ...base, ...args }, quiet, redactor);
    return { payload, summary: payload.receipt ? `receipt ${payload.receipt.runId}: ${payload.receipt.status}` : "no receipt for this scope" };
  });

  return server;
}

export interface ReceiptPayload {
  ok: true;
  command: "receipt";
  environment: string;
  scope: string;
  receipt: Receipt | null;
  warnings: string[];
}

/**
 * The receipt does not need a valid plan: an agent reads it precisely when the plan is broken.
 * Store settings come from the plan when it parses (else from the raw YAML, else defaults); the
 * environment is checked against the plan's environments when the plan parses.
 */
export async function readReceipt(opts: GlobalOpts, io: IO, redactor: Redactor): Promise<ReceiptPayload> {
  const warnings: string[] = [];
  const planPath = planPathFor(opts, io);
  let environments: string[] | null = null;
  let kind: Plan["receipts"] | undefined;
  try {
    const { plan } = await loadPlan(planPath);
    environments = plan.environments;
    kind = plan.receipts;
  } catch (e) {
    if (!isSponsonError(e)) throw e;
    kind = await looseReceiptsKind(planPath);
    warnings.push(
      `The plan is not usable (${e.code}): ${e.message.split("\n")[0]} Reading the receipt with ${kind ? `\`receipts: ${kind}\` from the file` : "the default receipt store"}; the environment name was not checked against the plan.`,
    );
  }
  const ctx = await detectCtx({ env: opts.env, branch: opts.branch, sha: opts.sha, pr: parsePr(opts.pr) }, io.env, io.cwd);
  if (environments && !environments.includes(ctx.env)) {
    throw new SponsonError("ENV_UNKNOWN", `Unknown environment \`${ctx.env}\`. Declared: ${environments.join(", ")}`, { environment: ctx.env, known: environments });
  }
  const store = await selectStore(opts, kind, io, (m) => warnings.push(m));
  const receipt = await store.read(ctx.env, ctx.scope);
  return { ok: true, command: "receipt", environment: ctx.env, scope: ctx.scope, receipt, warnings: withRedactorWarnings(warnings, redactor) };
}

async function looseReceiptsKind(path: string): Promise<Plan["receipts"] | undefined> {
  try {
    const raw = parseYaml(await readFile(path, "utf8")) as { receipts?: unknown } | null;
    return raw?.receipts === "local" || raw?.receipts === "git-branch" ? raw.receipts : undefined;
  } catch {
    return undefined;
  }
}
