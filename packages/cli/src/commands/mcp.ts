import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Redactor, SponsonError, isSponsonError } from "@sponson/core";
import { z } from "zod";
import { buildRunContext, type GlobalOpts, type IO } from "../context.js";
import { applyJson, errorJson, finalLine, planJson, planSummary } from "../render.js";
import { executeApply } from "./apply.js";
import { executePlan } from "./plan.js";

const scopeShape = {
  env: z.string().optional().describe("Environment name. Defaults to `preview`. Production is never inferred."),
  pr: z.number().int().positive().optional().describe("Pull request number, when known."),
  branch: z.string().optional().describe("Git branch. Defaults to the checked-out branch."),
  sha: z.string().optional().describe("Git commit sha. Defaults to HEAD."),
};
const planShape = { ...scopeShape, plan: z.string().optional().describe("Path to release.plan.yaml. Defaults to the one in the working directory.") };

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * `sponson mcp`: the three commands as MCP tools over stdio.
 * stdout is the transport, so every log line goes to stderr.
 */
export async function mcpCommand(base: GlobalOpts, io: IO): Promise<number> {
  const server = new McpServer({ name: "sponson", version: "0.1.0" });
  const quiet: IO = { ...io, stdout: io.stderr };

  const text = (redactor: Redactor, payload: unknown, summary: string): ToolResult => ({
    content: [{ type: "text", text: redactor.redact(`${JSON.stringify(payload)}\n${summary}`) }],
  });
  const failure = (redactor: Redactor, e: unknown): ToolResult => {
    const err = isSponsonError(e) ? e : new SponsonError("APPLY_FAILED", (e as Error)?.message ?? String(e));
    return { content: [{ type: "text", text: redactor.redact(JSON.stringify(errorJson(err))) }], isError: true };
  };

  server.registerTool(
    "sponson_plan",
    {
      title: "Plan a release",
      description:
        "Read-only. Reads live provider state, diffs it against release.plan.yaml for the given environment and prints every line's status (create / update / unchanged / pending / error) plus drift. Nothing is changed. Call this first, show the human the diff, and stop before calling sponson_apply.",
      inputSchema: planShape,
    },
    async (args) => {
      const redactor = new Redactor();
      try {
        const { result, code } = await executePlan({ ...base, ...args, json: true }, quiet, redactor);
        return text(redactor, planJson(result, code === 0), `plan ${result.environment}/${result.scope}: ${planSummary(result.lines)}`);
      } catch (e) {
        return failure(redactor, e);
      }
    },
  );

  server.registerTool(
    "sponson_apply",
    {
      title: "Apply a release plan",
      description:
        "Applies release.plan.yaml and returns the receipt. Only call after the human has seen the sponson_plan diff. If the result status is `partial`, lines are waiting on an external event (usually a deploy): do NOT retry; wait for the deployment and re-run sponson_plan later, or let the deployment_status workflow finish it. `env: production` is refused without approvedBy; never supply approvedBy on your own, it must come from a human or an approval workflow. Never write secret values into the plan; use `{ secret: \"env://NAME\" }` references. `destroy: true` tears down everything this scope created.",
      inputSchema: {
        ...planShape,
        destroy: z.boolean().optional().describe("Destroy every resource this scope created (reverse order). Adopted resources are never touched."),
        approvedBy: z.string().optional().describe("Who approved a production apply. Required for env=production. Must come from a human."),
        reconcile: z.boolean().optional().describe("Overwrite values that were changed outside Sponson since the last apply."),
        wait: z.boolean().optional().describe("Poll for external events (deploys) instead of returning `partial`."),
      },
    },
    async (args) => {
      const redactor = new Redactor();
      try {
        const { summary, code } = await executeApply({ ...base, ...args, json: true }, quiet, redactor);
        return text(redactor, applyJson(summary, code === 0), finalLine(summary));
      } catch (e) {
        return failure(redactor, e);
      }
    },
  );

  server.registerTool(
    "sponson_receipt",
    {
      title: "Read the latest receipt",
      description:
        "Read-only. Returns the latest receipt for this environment and scope (what the last apply actually did): overall `status` (complete / partial / failed), and per line `lines[id].status` and `lines[id].outputs`. Returns `{ receipt: null }` when nothing has been applied. Read this instead of inferring success from your last tool call.",
      inputSchema: scopeShape,
    },
    async (args) => {
      const redactor = new Redactor();
      try {
        const rc = await buildRunContext({ ...base, ...args }, quiet, redactor);
        const receipt = await rc.store.read(rc.ctx.env, rc.ctx.scope);
        return text(redactor, { ok: true, command: "receipt", environment: rc.ctx.env, scope: rc.ctx.scope, receipt }, receipt ? `receipt ${receipt.runId}: ${receipt.status}` : "no receipt for this scope");
      } catch (e) {
        return failure(redactor, e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  io.stderr.write("sponson mcp: listening on stdio\n");
  // Keep the process alive until the client closes the transport.
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  return 0;
}
