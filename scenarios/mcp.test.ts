/**
 * Agent-facing smoke test: drive `sponson mcp` over stdio exactly as an agent would,
 * against the fake cloud. Checks the three tools exist, that their descriptions carry
 * the rules SKILL.md relies on, and that a plan → apply → receipt round trip works
 * with the JSON shapes an agent reads (null for pending/secret values, never text).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";

const repo = new URL("..", import.meta.url).pathname;
const PLAN = `
version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
      STRIPE_KEY: { secret: "env://STRIPE_KEY" }
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }
`;
const SECRET = "sk_test_mcp_secret_value";

let sim: SimHandle;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  sim = await startSim();
  const cwd = await mkdtemp(join(tmpdir(), "sponson-mcp-"));
  await writeFile(join(cwd, "release.plan.yaml"), PLAN);
  transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", join(repo, "packages/cli/src/bin.ts"), "mcp", "--receipts", "local", "--receipts-dir", join(cwd, "r"), "--pr", "42", "--branch", "feat/x", "--sha", "0123456789abcdef0123456789abcdef01234567"],
    cwd,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      VERCEL_TOKEN: "t",
      NEON_API_KEY: "t",
      CLERK_SECRET_KEY: "t",
      VERCEL_API_URL: `${sim.url}/vercel`,
      NEON_API_URL: `${sim.url}/neon`,
      CLERK_API_URL: `${sim.url}/clerk`,
      STRIPE_KEY: SECRET,
    },
    stderr: "pipe",
  });
  client = new Client({ name: "scenario-agent", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await sim?.close();
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
}

/** Tools return one text item: a JSON document on the first line, then a human summary. */
function json(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const first = text(result).split("\n")[0] ?? "";
  if (!first.startsWith("{")) throw new Error(`no JSON on the first line of ${text(result)}`);
  return JSON.parse(first);
}

describe("sponson mcp", () => {
  it("exposes three tools whose descriptions carry the rules", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["sponson_apply", "sponson_plan", "sponson_receipt"]);
    const all = tools.map((t) => t.description ?? "").join("\n");
    expect(all).toMatch(/read-only/i);
    expect(all).toMatch(/partial/);
    expect(all).toMatch(/do not retry|don't retry|never retry/i);
    expect(all).toMatch(/secret/i);
  });

  it("plan returns JSON with null for pending and secret values, and writes nothing", async () => {
    const r = await client.callTool({ name: "sponson_plan", arguments: {} });
    const out = text(r);
    expect(out).not.toContain(SECRET);
    const plan = json(r) as { lines: Array<{ id: string; status: string; inputs: Record<string, unknown> }> };
    const env = plan.lines.find((l) => l.id === "env")!;
    expect(env.status).toBe("pending");
    expect(env.inputs["values.DATABASE_URL"]).toMatchObject({ state: "pending", value: null, ref: "db.connection_string" });
    expect(env.inputs["values.STRIPE_KEY"]).toMatchObject({ state: "secret", value: null });
    expect(sim.state.writes).toHaveLength(0);
  });

  it("refuses production without approval before touching anything", async () => {
    const r = await client.callTool({ name: "sponson_apply", arguments: { env: "production" } });
    expect(text(r)).toContain("ENV_NOT_APPROVED");
    expect(sim.state.writes).toHaveLength(0);
  });

  it("apply then receipt round-trips, with secrets redacted", async () => {
    const a = await client.callTool({ name: "sponson_apply", arguments: {} });
    const out = text(a);
    expect(out).not.toContain(SECRET);
    const applied = json(a) as { receipt: { status: string; runId: string; lines: Record<string, unknown> } };
    expect(applied.receipt.status).toBe("complete");
    expect(Object.keys(applied.receipt.lines)).toEqual(["db", "env", "callback"]);

    const rc = await client.callTool({ name: "sponson_receipt", arguments: {} });
    const got = json(rc) as { receipt?: { runId: string }; runId?: string };
    expect(got.receipt?.runId ?? got.runId).toBe(applied.receipt.runId);
    expect(text(rc)).not.toContain(SECRET);
  });
});
