 
/**
 * Task: "rotate the Stripe key". The plan already says `STRIPE_KEY: { secret: "env://STRIPE_KEY" }`;
 * the new value arrives in the environment. The agent must not touch the plan file (SKILL.md rule 3),
 * must see the rotation in plan, and must never see either value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentWorld, previewPlan } from "./harness.js";

const OLD = "fake_ts_OLD_rotation_value_123";
const NEW = "fake_ts_NEW_rotation_value_456";
let w: AgentWorld;
const outputs: string[] = [];
const live = () => w.sim.state.vercel.projects.prj_demo!.envs.find((e) => e.key === "STRIPE_KEY")?.value;
async function cli(args: string[]) {
  const r = await w.cli(args);
  outputs.push(r.stdout + r.stderr);
  return r;
}

beforeAll(async () => {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = OLD;
  await w.writePlan(previewPlan());
  expect((await cli(["apply", "--json"])).json.receipt.status).toBe("complete");
});
afterAll(() => w.close());

describe("rotate the Stripe key", () => {
  it("before rotation the secret line is `unchanged` (fingerprint matches)", async () => {
    const plan = await cli(["plan", "--json"]);
    const env = plan.json.lines.find((l: any) => l.id === "env");
    expect(env.status).toBe("unchanged");
    expect(env.inputs["values.STRIPE_KEY"]).toEqual({ state: "secret", value: null, ref: "env://STRIPE_KEY", sensitive: true });
  });

  it("after rotation plan shows `update` on that key only, apply writes the new value, the next plan is clean", async () => {
    w.env.STRIPE_KEY = NEW;
    const plan = await cli(["plan", "--json"]);
    const env = plan.json.lines.find((l: any) => l.id === "env");
    expect(env.status).toBe("update");
    expect(env.diffs.filter((d: any) => d.kind !== "unchanged").map((d: any) => d.key)).toEqual(["env:preview:feat/preview-db:STRIPE_KEY"]); // v2 key: env:<target>:<gitBranch|*>:<KEY>
    expect(plan.json.drift).toEqual([]);

    const apply = await cli(["apply", "--json"]);
    expect(apply.code).toBe(0);
    expect(apply.json.receipt.lines.env.status).toBe("applied");
    expect(apply.json.warnings.join("\n")).toMatch(/env:\/\/STRIPE_KEY changed/);
    expect(live()).toBe(NEW);

    const after = await cli(["plan", "--json"]);
    expect(after.json.lines.find((l: any) => l.id === "env").status).toBe("unchanged");
    expect(after.json.drift).toEqual([]);
  });

  it("the rotated-away and the new value never appear in any output or receipt", async () => {
    const rc = JSON.stringify((await cli(["apply", "--json"])).json);
    for (const o of [...outputs, rc]) {
      expect(o).not.toContain(OLD);
      expect(o).not.toContain(NEW);
    }
  });

  it("a forgotten secret (env var unset) fails apply with the documented SECRET_UNRESOLVED code, not prose only", async () => {
    w.ctx.pr = 77;
    delete w.env.STRIPE_KEY;
    const plan = await cli(["plan", "--json"]);
    const apply = await cli(["apply", "--json"]);
    const env = apply.json.receipt.lines.env;
    // v2: refusals are line status `blocked`, run `failed`, and plan predicts them (SKILL.md Output + rule 1;
    // plan resolves secrets too).
    expect(apply.json.receipt.status).toBe("failed");
    expect(env.status).toBe("blocked");
    expect(env.error).toMatch(/STRIPE_KEY/);
    expect({ planExit: plan.code, errorCode: env.errorCode }).toMatchObject({ planExit: 1, errorCode: "SECRET_UNRESOLVED" });
  });
});
