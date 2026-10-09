 
/**
 * Task: "add a preview database to this feature".
 * The agent writes release.plan.yaml from scratch and makes the mistakes LLMs make. After each `plan --json`
 * it may only use the error JSON to decide what to fix. Correct behaviour (SKILL.md: agents read `--json`, no
 * exceptions; errors.ts "every user-facing failure is a SponsonError with a stable code"):
 * every rejection is JSON on stdout with `ok: false`, a documented `error.code`, a pointer to the offending
 * line, and the right exit code; and a plan that exits 0 does not fail on apply for a reason plan could see.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentWorld, previewPlan } from "./harness.js";

const DOCUMENTED_CODES = [
  "PLAN_PARSE", "PLAN_INVALID", "REF_UNKNOWN", "REF_CYCLE", "REF_FILTERED", "CTX_NULL", "ENV_UNKNOWN", "ENV_NOT_APPROVED",
  "SECRET_LITERAL", "SECRET_UNRESOLVED", "ADAPTER_UNKNOWN", "OP_UNKNOWN", "DRIFT_CHANGED", "LOCK_HELD", "RECEIPT_CORRUPT",
  "RECEIPT_VERSION", "STORE_PERMISSION", "APPLY_FAILED", "WAIT_TIMEOUT", "USAGE",
];

let w: AgentWorld;
beforeAll(async () => {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = "fake_ts_author_secret";
});
afterAll(() => w.close());

type Mutate = (p: any) => void;
const variants: Array<[string, Mutate, string, RegExp]> = [
  ["forgot `version`", (p) => delete p.version, "PLAN_INVALID", /version/],
  ["environments as a string", (p) => (p.changes[0].environments = "preview"), "PLAN_INVALID", /environments/],
  ["uppercase id", (p) => (p.changes[0].id = "DB"), "PLAN_INVALID", /lowercase|id/],
  ["duplicate id", (p) => (p.changes[1].id = "db"), "PLAN_INVALID", /db/],
  ["unknown adapter", (p) => (p.changes[0].adapter = "postgres"), "ADAPTER_UNKNOWN", /neon/],
  ["unknown op", (p) => (p.changes[0].op = "database"), "OP_UNKNOWN", /branch/],
  ["secret as a literal", (p) => (p.changes[1].values.STRIPE_KEY = "fake_lv_123"), "SECRET_LITERAL", /env:\/\/STRIPE_KEY/],
  ["pasted display text", (p) => (p.changes[1].values.DATABASE_URL = "(pending ← db.connection_string)"), "PLAN_INVALID", /from/],
  ["reference to a missing line", (p) => (p.changes[1].values.DATABASE_URL = { from: "database.connection_string" }), "REF_UNKNOWN", /database/],
  ["reference without output", (p) => (p.changes[1].values.DATABASE_URL = { from: "db" }), "REF_UNKNOWN", /db\./],
  ["secret ref without scheme", (p) => (p.changes[1].values.STRIPE_KEY = { secret: "STRIPE_KEY" }), "PLAN_INVALID", /env:\/\//],
  ["undeclared environment", (p) => (p.changes[0].environments = ["staging"]), "PLAN_INVALID", /staging/],
  ["unknown ctx variable", (p) => (p.changes[0].name = "db-${ctx.pr_number}"), "CTX_NULL", /ctx\.scope|Available/],
];

describe("agent authors a plan from scratch and recovers using only error JSON", () => {
  it.each(variants)("%s → JSON error with a documented code, exit 2, and a hint the agent can act on", async (_name, mutate, code, hint) => {
    const p = previewPlan();
    mutate(p);
    await w.writePlan(p);
    const r = await w.cli(["plan", "--json"]);
    expect(r.json, `stdout must be JSON, got: ${r.stdout || r.stderr}`).not.toBeNull();
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe(code);
    expect(DOCUMENTED_CODES).toContain(r.json.error.code);
    expect(r.json.error.message).toMatch(hint);
    expect(r.code).toBe(2);
    // Nothing touched the cloud while the agent was fumbling (these run before any apply).
    expect(w.sim.state.writes).toHaveLength(0);
  });

  it("a typo in an output name (`db.conn_string`) is caught by plan, not by apply after the human approved", async () => {
    // neon.branch declares its outputs statically (branch_id, connection_string, host), so plan can know.
    const p = previewPlan();
    p.changes[1]!.values = { DATABASE_URL: { from: "db.conn_string" } } as never;
    await w.writePlan(p);
    const plan = await w.cli(["plan", "--json"]);
    const env = plan.json?.lines?.find((l: any) => l.id === "env");
    // v2 (SKILL.md error table): a wrong output name is its own code, REF_OUTPUT_UNKNOWN, and the
    // message lists the valid output names.
    const OUT_CODES = ["REF_UNKNOWN", "REF_OUTPUT_UNKNOWN"];
    const caught =
      plan.code !== 0 && (OUT_CODES.includes(plan.json?.error?.code) || OUT_CODES.includes(env?.errorCode));
    if (caught && plan.json?.error) expect(plan.json.error.message).toMatch(/connection_string/);
    if (!caught) {
      // Show what the human would have approved and what apply then does.
      const apply = await w.cli(["apply", "--json"]);
      await w.cli(["apply", "--destroy", "--json"]);
      expect.fail(
        `plan exit ${plan.code}, env status \`${env?.status}\` (waitingOn ${env?.waitingOn}); after approval apply exit ${apply.code}, ` +
          `status ${apply.json?.receipt?.status}, env: ${apply.json?.receipt?.lines?.env?.status} "${apply.json?.receipt?.lines?.env?.error}" errorCode=${apply.json?.receipt?.lines?.env?.errorCode}`,
      );
    }
  });

  it("an adapter-level param error (`target: preveiw`) carries an errorCode on the plan line, like every other error", async () => {
    const p = previewPlan();
    p.changes[1]!.target = "preveiw";
    await w.writePlan(p);
    const r = await w.cli(["plan", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    const env = r.json.lines.find((l: any) => l.id === "env");
    expect(env.status).toBe("error");
    expect(env.error).toMatch(/preview/);
    expect(env.errorCode, `plan line error "${env.error}" has no errorCode`).toEqual(expect.any(String));
  });

  it("after the fixes the plan is clean and matches SKILL.md example 1", async () => {
    await w.writePlan(previewPlan());
    const before = w.sim.state.writes.length;
    const r = await w.cli(["plan", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.lines.map((l: any) => [l.id, l.status, l.waitingOn])).toEqual([
      ["db", "create", undefined],
      ["env", "pending", "db"],
    ]);
    expect(w.sim.state.writes.length).toBe(before);
  });
});
