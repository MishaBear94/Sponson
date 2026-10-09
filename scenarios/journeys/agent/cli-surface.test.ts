 
/**
 * The CLI surface an agent uses when it has no MCP: `init`, typos in flags, and the production audit trail.
 * README: "Every command takes `--json`": humans read the coloured diff, agents read `--json`, no exceptions.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentWorld, previewPlan } from "./harness.js";

let w: AgentWorld;
beforeEach(async () => {
  w = await AgentWorld.create({ vercel: { projects: { prj_demo: { envs: [{ key: "LEGACY_FLAG", value: "1", target: "preview", gitBranch: "feat/preview-db" }] } } } });
  w.env.STRIPE_KEY = "fake_ts_cli_surface";
});
afterEach(() => w.close());

describe("init for an agent", () => {
  it("`init --json` in an empty repo writes the starter and answers in JSON", async () => {
    const r = await w.cli(["init", "--json"]);
    expect(r.code).toBe(0);
    const plan = await readFile(join(w.cwd, "release.plan.yaml"), "utf8");
    expect(plan).toContain("from: db.connection_string");
    expect(r.json, `stdout: ${JSON.stringify(r.stdout)}`).not.toBeNull();
    expect(r.json).toMatchObject({ ok: true, command: "init" });
  });

  it("the starter plan `init` writes plans cleanly for the agent (no placeholders that fail later)", async () => {
    await w.cli(["init"]);
    // An agent would now fill in the providers it knows, as the starter's placeholders ask.
    const text = (await readFile(join(w.cwd, "release.plan.yaml"), "utf8")).replace('"prj_xxx"', '"prj_demo"').replace('"proj_xxx"', '"proj_demo"');
    await w.writePlan(text + "receipts: local\n");
    const r = await w.cli(["plan", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.lines.map((l: any) => [l.id, l.status])).toEqual([["db", "create"], ["env", "pending"]]);
  });

  it("`init --adopt <key> --json` with nothing matching answers with a JSON error code", async () => {
    await w.writePlan(previewPlan());
    const r = await w.cli(["init", "--adopt", "NOPE", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.json, `stdout: ${JSON.stringify(r.stdout)} stderr: ${JSON.stringify(r.stderr)}`).not.toBeNull();
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toMatch(/^[A-Z_]+$/);
  });

  it("adopting the unmanaged var reported by plan: plan → drift key → init --adopt → plan has no unmanaged drift", async () => {
    await w.writePlan(previewPlan());
    const plan = await w.cli(["plan", "--json"]);
    const unmanaged = plan.json.drift.filter((d: any) => d.kind === "unmanaged");
    expect(unmanaged.map((d: any) => d.resource.key)).toEqual(["env:preview:feat/preview-db:LEGACY_FLAG"]); // v2 key: env:<target>:<gitBranch|*>:<KEY>
    const init = await w.cli(["init", "--adopt", unmanaged[0].resource.key]);
    expect(init.code).toBe(0);
    const after = await w.cli(["plan", "--json"]);
    expect(after.json.drift.filter((d: any) => d.kind === "unmanaged")).toEqual([]);
    const adopted = after.json.lines.find((l: any) => l.id.startsWith("env-preview"));
    // v2: adopted values are `{ keep: true }` — kept as live, never copied into the plan or CI.
    expect(adopted.inputs["values.LEGACY_FLAG"]).toMatchObject({ state: "kept", value: null });
  });
});

describe("flag typos with --json", () => {
  it.each([
    ["misspelt option", ["apply", "--aproved-by", "alice", "--json"]],
    ["bad --receipts choice", ["plan", "--json", "--receipts", "s3"]],
    ["unknown command", ["status-json", "--json"]],
  ])("%s → JSON error on stdout with a code, exit 2", async (_n, args) => {
    await w.writePlan(previewPlan());
    const r = await w.cli(args, { ctx: false });
    expect(r.code).toBe(2);
    expect(r.json, `stdout: ${JSON.stringify(r.stdout)} stderr: ${JSON.stringify(r.stderr)}`).not.toBeNull();
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toMatch(/^[A-Z_]+$/);
  });
});

describe("production audit trail", () => {
  it("an approved production apply records who approved it in the receipt (README: a shared record of what a human approved)", async () => {
    await w.writePlan({
      version: 1,
      receipts: "local",
      providers: { vercel: { project: "prj_demo" } },
      changes: [{ id: "flag", adapter: "vercel", op: "env", target: "production", values: { FEATURE_X: "on" }, environments: ["production"] }],
    });
    const refused = await w.cli(["apply", "--env", "production", "--json"]);
    expect(refused.json.error.code).toBe("ENV_NOT_APPROVED");
    const r = await w.cli(["apply", "--env", "production", "--approved-by", "alice@example.com", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.receipt.status).toBe("complete");
    expect(JSON.stringify(r.json.receipt), "receipt has no trace of the approver").toContain("alice@example.com");
  });
});
