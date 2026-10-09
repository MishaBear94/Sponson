 
/**
 * Task: "someone changed DATABASE_URL in the Vercel console, fix it".
 * SKILL.md rule 5: `changed` drift blocks that line until a human passes --reconcile. Rule 1: exit 1 from plan
 * means a line is error/blocked. The agent shows the plan, asks the human, and only then reconciles.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { AgentWorld, previewPlan } from "./harness.js";

const CONSOLE = "postgres://someone:edited@console.example/db";
let w: AgentWorld;
let pr = 100;

async function appliedWorld() {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = "fake_ts_drift";
  w.ctx.pr = ++pr;
  await w.writePlan(previewPlan());
  const a = await w.cli(["apply", "--json"]);
  expect(a.json.receipt.status).toBe("complete");
  await w.sim.state.applyChaos({ drift: { "vercel.env.preview.DATABASE_URL": CONSOLE } });
}
const liveDbUrl = () => w.sim.state.vercel.projects.prj_demo!.envs.find((e) => e.key === "DATABASE_URL")?.value;

beforeEach(appliedWorld);
afterEach(() => w.close());

describe("console drift → reconcile, driven by an agent", () => {
  it("happy path: plan reports the drift on `env`, apply refuses with DRIFT_CHANGED, human says reconcile, plan is clean", async () => {
    const plan = await w.cli(["plan", "--json"]);
    expect(plan.json.drift).toEqual([expect.objectContaining({ kind: "changed", line: "env", resource: expect.objectContaining({ key: "env:preview:feat/preview-db:DATABASE_URL" }) })]);
    expect(plan.stdout).not.toContain("edited@console");

    const refused = await w.cli(["apply", "--json"]);
    expect(refused.code).toBe(1);
    // v2: a refusal is line status `blocked` (SKILL.md Output / rule 5; types.ts LineStatus), run `failed`.
    expect(refused.json.receipt.status).toBe("failed");
    expect(refused.json.receipt.lines.env).toMatchObject({ status: "blocked", errorCode: "DRIFT_CHANGED" });
    expect(liveDbUrl()).toBe(CONSOLE);

    // Human: "yes, put it back".
    const fixed = await w.cli(["apply", "--reconcile", "--json"]);
    expect(fixed.code).toBe(0);
    expect(fixed.json.receipt.lines.env).toMatchObject({ status: "applied", notes: expect.objectContaining({ reconciled: true }) });
    expect(liveDbUrl()).not.toBe(CONSOLE);
    const clean = await w.cli(["plan", "--json"]);
    expect(clean.json.drift).toEqual([]);
    expect(clean.json.lines.find((l: any) => l.id === "env").status).toBe("unchanged");
  });

  it("plan predicts the refusal: the drifted line is `blocked` (or carries DRIFT_CHANGED) and plan exits 1, per SKILL.md rules 1 and 5", async () => {
    // Otherwise the agent shows "~ env update", the human approves an update, and apply fails.
    const plan = await w.cli(["plan", "--json"]);
    const env = plan.json.lines.find((l: any) => l.id === "env");
    expect({ status: env.status, errorCode: env.errorCode, ok: plan.json.ok, exit: plan.code }).toMatchObject({ status: "blocked", ok: false, exit: 1 });
  });

  it("an agent that simply retries apply after DRIFT_CHANGED still gets refused (no --reconcile, no overwrite)", async () => {
    const first = await w.cli(["apply", "--json"]);
    expect(first.json.receipt.lines.env.errorCode).toBe("DRIFT_CHANGED");
    const retry = await w.cli(["apply", "--json"]);
    expect(liveDbUrl(), `retry status ${retry.json.receipt.status}, env ${retry.json.receipt.lines.env.status}: the console value was overwritten without --reconcile`).toBe(CONSOLE);
    expect(retry.json.receipt.lines.env.errorCode).toBe("DRIFT_CHANGED");
  });

  it("after a refused apply, plan still reports the drift (the receipt did not forget what Sponson owns)", async () => {
    await w.cli(["apply", "--json"]);
    const plan = await w.cli(["plan", "--json"]);
    expect(plan.json.drift.map((d: any) => [d.kind, d.line])).toEqual([["changed", "env"]]);
  });

  it("\"clean up this PR\" after a refused apply still removes the env vars Sponson created", async () => {
    await w.cli(["apply", "--json"]);
    const d = await w.cli(["apply", "--destroy", "--json"]);
    expect(d.code).toBe(0);
    const left = w.sim.state.vercel.projects.prj_demo!.envs.map((e) => e.key);
    expect(left, `destroy receipt: ${JSON.stringify(Object.values(d.json.receipt.lines).map((l: any) => [l.id, l.status, l.error]))}`).toEqual([]);
    expect(w.sim.state.neon.projects.proj_demo!.branches.map((b) => b.name)).toEqual(["main"]);
  });
});
