 
/**
 * The agent talks only to `sponson mcp`. Covers: "what does production look like?" (read is fine, writing is
 * refused), a fresh session with no runs, a broken plan file, wrong argument types, and tool descriptions vs
 * SKILL.md. Correct behaviour per SKILL.md / tool descriptions, and per the mcp.test.ts contract: every tool
 * result is a JSON document on its first line, errors as `{ ok: false, error: { code, message } }`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentWorld, callbackLine, previewPlan, repo, SKILL, type McpAgent } from "./harness.js";

let w: AgentWorld;
let agent: McpAgent;

beforeAll(async () => {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = "fake_ts_mcp_operator";
  await w.writePlan(previewPlan([callbackLine]));
  agent = await w.mcp();
}, 60_000);
afterAll(async () => {
  await agent?.close();
  await w.close();
});

describe("fresh session, no runs yet", () => {
  it("sponson_receipt for a scope that was never applied is `{ ok: true, receipt: null }`", async () => {
    const r = await agent.receipt();
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ ok: true, command: "receipt", environment: "preview", scope: "pr-42", receipt: null });
    const other = await agent.receipt({ pr: 7 });
    expect(other.json).toMatchObject({ ok: true, scope: "pr-7", receipt: null });
  });

  it("sponson_receipt with a misspelt environment is ENV_UNKNOWN, not `receipt: null` (which reads as \"nothing deployed\")", async () => {
    const r = await agent.receipt({ env: "prod" });
    expect(r.json?.ok, r.text).toBe(false);
    expect(r.json?.error?.code).toBe("ENV_UNKNOWN");
  });
});

describe("what does production look like?", () => {
  it("plan for production is allowed, read-only, and says which lines exist there", async () => {
    const before = w.sim.state.writes.length;
    const r = await agent.plan({ env: "production" });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ ok: true, environment: "production" });
    expect(r.json.lines).toEqual([]); // every line is preview-only
    expect(w.sim.state.writes.length).toBe(before);
  });

  it.each([
    ["apply", {}],
    ["destroy", { destroy: true }],
    ["apply with empty approvedBy", { approvedBy: "" }],
    ["apply with whitespace approvedBy", { approvedBy: "   " }],
  ])("%s on production without a human approval is refused with ENV_NOT_APPROVED and writes nothing", async (_n, extra) => {
    const before = w.sim.state.writes.length;
    const r = await agent.apply({ env: "production", ...extra });
    expect(r.isError).toBe(true);
    expect(r.json?.error?.code, r.text).toBe("ENV_NOT_APPROVED");
    expect(w.sim.state.writes.length).toBe(before);
  });
});

describe("agent passes wrong argument types or names", () => {
  it.each([
    ["pr as a string", "sponson_plan", { pr: "42" }],
    ["destroy as a string", "sponson_apply", { destroy: "true" }],
    ["env as a list", "sponson_receipt", { env: ["preview"] }],
  ])("%s → isError with a JSON error carrying a code", async (_n, tool, args) => {
    const r = await agent.call(tool, args);
    expect(r.isError).toBe(true);
    expect(r.json, `not JSON: ${r.text}`).not.toBeNull();
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toMatch(/^[A-Z_]+$/);
  });

  it("an unknown argument (`approved_by`, `reconcile_drift`) is rejected, not silently dropped", async () => {
    // The agent believes it passed reconcile; the tool quietly ignored it and refused for a different reason.
    const r = await agent.apply({ reconcile_drift: true, plan: "release.plan.yaml" });
    expect(r.isError, `accepted with unknown arg, result: ${r.text.slice(0, 200)}`).toBe(true);
  });
});

describe("tool contract vs SKILL.md and the CLI", () => {
  it("sponson_plan's description lists every plan status SKILL.md and the JSON use (incl. `blocked`)", async () => {
    const { tools } = await agent.client.listTools();
    const d = tools.find((t) => t.name === "sponson_plan")!.description!;
    for (const s of SKILL.planStatuses) expect(d, `missing ${s}`).toContain(s);
  });

  it("sponson_apply can bound `wait` like `--wait-timeout` (otherwise wait:true blocks the agent for up to 10 minutes)", async () => {
    const { tools } = await agent.client.listTools();
    const props = Object.keys((tools.find((t) => t.name === "sponson_apply")!.inputSchema as any).properties);
    expect(props).toContain("wait");
    expect(props.some((p) => /timeout/i.test(p)), `sponson_apply args: ${props.join(", ")}`).toBe(true);
  });

  it("SKILL.md and tool descriptions name the same fields the JSON uses", async () => {
    const skill = await readFile(join(repo, "SKILL.md"), "utf8");
    // SKILL.md example 1 shows `waitingOn` in plan JSON and example 2 `waitingFor` in the receipt: both exist.
    expect(skill).toContain("waitingOn");
    expect(skill).toContain("waitingFor");
    const { tools } = await agent.client.listTools();
    const rd = tools.find((t) => t.name === "sponson_receipt")!.description!;
    expect(rd).toContain("{ receipt: null }");
  });
});

describe("fresh session with a broken plan file", () => {
  it("sponson_receipt still returns what the last apply did (the agent needs it to repair the plan)", async () => {
    const a = await agent.apply();
    expect(a.json.receipt.status).toBe("complete");
    const path = join(w.cwd, "release.plan.yaml");
    const good = await readFile(path, "utf8");
    try {
      await writeFile(path, good.replace("version: 1", "version: one"));
      const fresh = await w.mcp();
      try {
        const r = await fresh.receipt();
        expect(r.json?.ok, r.text).toBe(true);
        expect(r.json.receipt.runId).toBe(a.json.receipt.runId);
      } finally {
        await fresh.close();
      }
    } finally {
      await writeFile(path, good);
    }
  }, 30_000);
});
