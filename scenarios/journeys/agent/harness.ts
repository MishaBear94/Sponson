 
/**
 * A scripted "agent" operator for Sponson. It only knows what SKILL.md says and what the tools return:
 * it writes release.plan.yaml programmatically, drives `sponson` in-process with `--json`, and talks
 * to `sponson mcp` over stdio with the MCP SDK client, like Claude Code would.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { cliEnv, mcpTransport, runCli, SHA, workspace, type CliRun, type Workspace } from "../../support.js";

export { SHA };
export const repo = new URL("../../..", import.meta.url).pathname;

/** Vocabulary SKILL.md documents. Anything else in the JSON is undocumented. */
export const SKILL = {
  planStatuses: ["create", "update", "unchanged", "pending", "todo", "blocked", "error"],
  runStatuses: ["complete", "partial", "failed"],
  lineStatuses: ["applied", "unchanged", "waiting", "failed", "rolled_back", "rollback_failed", "skipped", "blocked", "destroyed", "destroy_failed"],
  valueStates: ["literal", "resolved", "pending", "secret"],
  /** SKILL.md (v2): `+ ~ = ? * - !`, one per plan status the human is shown. */
  symbols: { create: "+", update: "~", unchanged: "=", pending: "?", todo: "*", blocked: "-", error: "!" } as Record<string, string>,
  exitCodes: [0, 1, 2, 3],
};

/** Text Sponson prints for values it will not show. An agent must never find this where a value belongs. */
export const PLACEHOLDER = /^\((pending|secret)\b|^\(secret\)$|^<(pending|secret)/;

export class AgentWorld {
  env: NodeJS.ProcessEnv;
  ctx = { pr: 42 as number | null, branch: "feat/preview-db", sha: SHA };
  private constructor(
    readonly sim: SimHandle,
    private readonly ws: Workspace,
  ) {
    this.env = cliEnv(sim);
  }

  static async create(seed?: Partial<SimSeed>): Promise<AgentWorld> {
    return new AgentWorld(await startSim({ seed }), await workspace("agent"));
  }

  get cwd(): string {
    return this.ws.dir;
  }

  get receiptsDir() {
    return join(this.cwd, ".sponson/receipts");
  }

  ctxArgs(): string[] {
    const a = ["--branch", this.ctx.branch, "--sha", this.ctx.sha, "--receipts", "local", "--receipts-dir", this.receiptsDir];
    if (this.ctx.pr !== null) a.push("--pr", String(this.ctx.pr));
    return a;
  }

  /** The agent writes the plan as data, then serialises it: no hand-written YAML. */
  async writePlan(plan: unknown): Promise<void> {
    await writeFile(join(this.cwd, "release.plan.yaml"), typeof plan === "string" ? plan : stringify(plan));
  }

  cli(args: string[], opts: { ctx?: boolean } = {}): Promise<CliRun> {
    return runCli([...args, ...(opts.ctx === false ? [] : this.ctxArgs())], { env: this.env, cwd: this.cwd });
  }

  /** Start `sponson mcp` as its own process, as an agent host would. Each call is a fresh session with no memory. */
  async mcp(extraEnv: Record<string, string> = {}): Promise<McpAgent> {
    const { transport } = mcpTransport(this.ctxArgs(), { cwd: this.cwd, env: { ...this.env, ...extraEnv } });
    const client = new Client({ name: "scripted-agent", version: "0.0.0" });
    await client.connect(transport);
    return new McpAgent(client);
  }

  async close() {
    await this.sim.close();
    await this.ws.cleanup();
  }
}

export interface ToolCall {
  isError: boolean;
  text: string;
  /** The JSON document on the first line, or null when the tool returned none. */
  json: any;
}

export class McpAgent {
  constructor(readonly client: Client) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
    const r = await this.client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    let json: any = null;
    try {
      json = JSON.parse(text.split("\n")[0] ?? "");
    } catch {
      /* not JSON */
    }
    return { isError: r.isError === true, text, json };
  }

  plan(args: Record<string, unknown> = {}) {
    return this.call("sponson_plan", args);
  }
  apply(args: Record<string, unknown> = {}) {
    return this.call("sponson_apply", args);
  }
  receipt(args: Record<string, unknown> = {}) {
    return this.call("sponson_receipt", args);
  }
  close() {
    return this.client.close();
  }
}

/** What the agent shows the human after plan (SKILL.md rule 1): one line per change, `+ ~ = ? !`. */
export function diffForHuman(plan: { lines: Array<{ id: string; adapter: string; op: string; status: string }> }): string[] {
  return plan.lines.map((l) => {
    const sym = SKILL.symbols[l.status];
    if (!sym) throw new Error(`SKILL.md gives no symbol for plan status \`${l.status}\` (line ${l.id})`);
    return `${sym} ${l.id} ${l.adapter}.${l.op} ${l.status}`;
  });
}

/** Walk every leaf of a JSON document with its path. */
export function leaves(v: unknown, path: string[] = [], out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, String(i)], out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out);
  else out.push([path.join("."), v]);
  return out;
}

/** The plan most agents would write for "add a preview database to this feature". */
export function previewPlan(extra: Record<string, unknown>[] = []) {
  return {
    version: 1,
    environments: ["preview", "production"],
    receipts: "local",
    providers: { vercel: { project: "prj_demo" }, neon: { project: "proj_demo" } },
    changes: [
      { id: "db", adapter: "neon", op: "branch", parent: "main", environments: ["preview"] },
      {
        id: "env",
        adapter: "vercel",
        op: "env",
        target: "preview",
        values: { DATABASE_URL: { from: "db.connection_string" }, STRIPE_KEY: { secret: "env://STRIPE_KEY" } },
        environments: ["preview"],
      },
      ...extra,
    ],
  };
}

export const callbackLine = { id: "callback", adapter: "clerk", op: "redirect_allow", url: { from: "env.preview_url" }, environments: ["preview"] };
