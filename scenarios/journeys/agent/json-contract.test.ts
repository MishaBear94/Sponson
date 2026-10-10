 
/**
 * The JSON an agent parses, checked across every command and outcome it can meet:
 * - every status that appears is one SKILL.md documents, and every documented status is reachable;
 * - `ok` agrees with the exit code (and the exit code with SKILL.md's table);
 * - pending/secret values are `null`, never placeholder text (not an empty string, not a placeholder);
 * - every failed line carries a stable `errorCode`, so an agent can branch on it directly;
 * - shapes are stable across plan / apply / destroy / error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentWorld, callbackLine, leaves, PLACEHOLDER, previewPlan, SHA, SKILL } from "./harness.js";
import type { CliRun } from "../../support.js";

const SECRET = "fake_ts_contract_value_9f8e";
let w: AgentWorld;
const seen = { plan: new Set<string>(), line: new Set<string>(), run: new Set<string>(), value: new Set<string>() };
const all: Array<{ what: string; r: CliRun }> = [];

async function cli(what: string, args: string[], pr: number) {
  w.ctx.pr = pr;
  // One PR = one git branch. v2 Vercel keys carry the gitBranch (env:<target>:<gitBranch|*>:<KEY>) and a scope may not
  // touch a var another scope's ledger owns, so PRs sharing a branch would collide with OWNED_BY_OTHER_SCOPE.
  w.ctx.branch = `feat/pr-${pr}`;
  const r = await w.cli(args);
  all.push({ what, r });
  const j = r.json;
  for (const l of j?.lines ?? []) {
    seen.plan.add(l.status);
    for (const v of Object.values(l.inputs ?? {}) as any[]) seen.value.add(v.state);
  }
  if (j?.receipt) {
    seen.run.add(j.receipt.status);
    for (const l of Object.values(j.receipt.lines) as any[]) seen.line.add(l.status);
  }
  return r;
}

beforeAll(async () => {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = SECRET;
  const st = w.sim.state;

  // 1. happy path with literal, from, secret: create, pending, applied, complete, unchanged, destroyed
  await w.writePlan(previewPlan([{ id: "flag", adapter: "vercel", op: "env", target: "preview", values: { FEATURE_X: "on" }, environments: ["preview"] }]));
  await cli("plan fresh", ["plan", "--json"], 1);
  await cli("apply happy", ["apply", "--json"], 1);
  await cli("plan after apply", ["plan", "--json"], 1);
  await cli("apply again", ["apply", "--json"], 1);
  // v2: changed drift no longer plans as `update` (it is `blocked`), so reach `update` with a real edit.
  await w.writePlan(previewPlan([{ id: "flag", adapter: "vercel", op: "env", target: "preview", values: { FEATURE_X: "off" }, environments: ["preview"] }]));
  await cli("plan update", ["plan", "--json"], 1);
  await cli("destroy", ["apply", "--destroy", "--json"], 1);
  await cli("destroy again", ["apply", "--destroy", "--json"], 1);

  // 2. failure on line 2: failed + rolled_back + skipped
  await w.writePlan(previewPlan([callbackLine]));
  await st.applyChaos({ fail_on: "POST /vercel/*", fail_next: 1, status: 500 });
  await cli("apply fails on env", ["apply", "--json"], 2);

  // 3. rollback itself fails: rollback_failed
  await st.applyChaos({ fail_on: ["POST /vercel/*", "DELETE /neon/*"], fail_next: 2, status: 500 });
  await cli("apply rollback fails", ["apply", "--json"], 3);

  // 4. deploy never: waiting + partial
  // The sim deploys once per sha, so this push is a new commit.
  await st.applyChaos({ deploy: "never", fail_next: 0 });
  w.ctx.sha = "1111111111111111111111111111111111111111";
  await cli("apply partial", ["apply", "--json"], 4);
  w.ctx.sha = SHA;
  await st.applyChaos({ deploy: "ok" });

  // 5. destroy fails: destroy_failed
  await cli("apply for destroy-fail", ["apply", "--json"], 5);
  // v2: a single 5xx on DELETE is retried, so use a terminal 400 to make the destroy really fail.
  await st.applyChaos({ fail_on: "DELETE /neon/*", fail_next: 1, status: 400 });
  await cli("destroy fails", ["apply", "--destroy", "--json"], 5);
  await st.applyChaos({ fail_next: 0 });

  // 6. plan: error + blocked
  await w.writePlan(previewPlan([{ id: "late", adapter: "vercel", op: "env", target: "nope", values: { A: "b" }, environments: ["preview"] }, { id: "after", adapter: "clerk", op: "redirect_allow", url: { from: "late.preview_url" }, environments: ["preview"] }]));
  await cli("plan error+blocked", ["plan", "--json"], 6);

  // 7. drift: blocked in plan and apply
  await w.writePlan(previewPlan());
  await cli("apply for drift", ["apply", "--json"], 7);
  await st.applyChaos({ drift: { "vercel.env.preview.DATABASE_URL": "postgres://console-edit" } });
  await cli("plan drift", ["plan", "--json"], 7);
  // v2: the refused apply reports the line as `blocked` (SKILL.md Output, types.ts LineStatus).
  await cli("apply drift refused", ["apply", "--json"], 7);

  // 9. a manual step nobody has done (ADR 0021): `todo` in plan; `waiting`, `partial` and exit 2 in apply
  await w.writePlan(previewPlan([{ id: "by-hand", adapter: "manual", op: "step", title: "Register the callback", instructions: "In the console, add it.", environments: ["preview"] }]));
  await cli("plan manual", ["plan", "--json"], 9);
  const manual = await cli("apply manual", ["apply", "--json"], 9);
  if (manual.code !== 2 || manual.json?.error?.code !== "MANUAL_STEP_PENDING") throw new Error(`apply manual: ${manual.stdout}`);

  // 8. top-level errors
  await cli("apply production", ["apply", "--env", "production", "--json"], 8);
  await cli("plan unknown env", ["plan", "--env", "stagging", "--json"], 8);
  const bad = await w.cli(["plan", "--json", "--pr", "abc", "--branch", "x", "--sha", w.ctx.sha, "--receipts", "local", "--receipts-dir", w.receiptsDir], { ctx: false });
  all.push({ what: "plan bad pr", r: bad });
}, 60_000);
afterAll(() => w.close());

describe("JSON contract seen by an agent", () => {
  it("every status and value state that appears is documented in SKILL.md", () => {
    for (const s of seen.plan) expect(SKILL.planStatuses).toContain(s);
    for (const s of seen.line) expect(SKILL.lineStatuses).toContain(s);
    for (const s of seen.run) expect(SKILL.runStatuses).toContain(s);
    for (const s of seen.value) expect(SKILL.valueStates).toContain(s);
  });

  it("every documented status is reachable", () => {
    expect([...seen.plan].sort()).toEqual([...SKILL.planStatuses].sort());
    expect([...seen.line].sort()).toEqual([...SKILL.lineStatuses].sort());
    expect([...seen.run].sort()).toEqual([...SKILL.runStatuses].sort());
    expect([...seen.value].sort()).toEqual([...SKILL.valueStates].sort());
  });

  it("stdout is always one JSON document, and `ok` agrees with the exit code", () => {
    for (const { what, r } of all) {
      expect(r.json, `${what}: stdout not JSON: ${r.stdout}${r.stderr}`).not.toBeNull();
      expect(SKILL.exitCodes, what).toContain(r.code);
      expect(r.json.ok, `${what}: ok=${r.json.ok} exit=${r.code}`).toBe(r.code === 0);
      if (r.json.receipt) expect(r.code === 1, `${what}: receipt ${r.json.receipt.status} exit ${r.code}`).toBe(r.json.receipt.status === "failed");
      if (r.json.ok === false && !r.json.receipt && !r.json.lines) {
        expect(r.json.error.code, what).toMatch(/^[A-Z_]+$/);
        expect(r.json.error.message, what).toEqual(expect.any(String));
      }
    }
  });

  it("exit codes match SKILL.md's table for top-level errors", () => {
    const by = Object.fromEntries(all.map(({ what, r }) => [what, r]));
    expect([by["apply production"]!.code, by["apply production"]!.json.error.code]).toEqual([2, "ENV_NOT_APPROVED"]);
    expect([by["plan unknown env"]!.code, by["plan unknown env"]!.json.error.code]).toEqual([2, "ENV_UNKNOWN"]);
    expect(by["plan unknown env"]!.json.error.known).toEqual(["preview", "production"]);
    expect(by["plan bad pr"]!.code).toBe(2);
  });

  it("the secret value never appears anywhere", () => {
    for (const { what, r } of all) expect(r.stdout + r.stderr, what).not.toContain(SECRET);
  });

  it("inputs: pending and secret values are null; sensitive resolved values are null", () => {
    for (const { r } of all)
      for (const l of r.json?.lines ?? [])
        for (const [k, v] of Object.entries(l.inputs) as Array<[string, any]>) {
          if (v.state === "pending" || v.state === "secret" || v.sensitive) expect(v.value, `${l.id}.${k}`).toBeNull();
          if (v.state === "literal") expect(v.value).not.toBeNull();
        }
  });

  it("plan line `outputs`: a sensitive output is null (or absent), never the text `(secret)`", () => {
    const offenders: string[] = [];
    for (const { what, r } of all)
      for (const l of r.json?.lines ?? []) for (const [k, v] of Object.entries(l.outputs ?? {})) if (typeof v === "string" && PLACEHOLDER.test(v)) offenders.push(`${what}: ${l.id}.outputs.${k} = ${JSON.stringify(v)}`);
    expect(offenders).toEqual([]);
  });

  it("plan line `outputs` keep their types (receipt has `branch_id` etc.; numbers/booleans are not stringified)", () => {
    // Shape stability: the same output must have the same JSON type in plan and receipt.
    const plan = all.find((x) => x.what === "plan after apply")!.r.json;
    const receipt = all.find((x) => x.what === "apply happy")!.r.json.receipt;
    for (const l of plan.lines) for (const [k, v] of Object.entries(receipt.lines[l.id].outputs)) expect(typeof l.outputs[k], `${l.id}.${k}`).toBe(typeof v);
  });

  it("diffs: no JSON field carries `(pending ← …)` display text that SKILL.md tells the agent never to copy", () => {
    const offenders: string[] = [];
    for (const { what, r } of all)
      for (const l of r.json?.lines ?? []) for (const [path, v] of leaves(l.diffs)) if (typeof v === "string" && PLACEHOLDER.test(v)) offenders.push(`${what}: ${l.id}.diffs.${path} = ${JSON.stringify(v)}`);
    expect(offenders.slice(0, 6)).toEqual([]);
  });

  it("every failed / rollback_failed / destroy_failed receipt line and every `error` plan line has an errorCode", () => {
    const missing: string[] = [];
    for (const { what, r } of all) {
      for (const l of r.json?.lines ?? []) if (l.status === "error" && !l.errorCode) missing.push(`${what}: plan ${l.id} "${l.error}"`);
      for (const l of Object.values(r.json?.receipt?.lines ?? {}) as any[])
        if (["failed", "rollback_failed", "destroy_failed"].includes(l.status) && !l.errorCode) missing.push(`${what}: ${l.id} ${l.status} "${l.error}"`);
    }
    expect(missing).toEqual([]);
  });

  it("apply and destroy receipts have the same shape", () => {
    const a = all.find((x) => x.what === "apply happy")!.r.json;
    const d = all.find((x) => x.what === "destroy")!.r.json;
    expect(Object.keys(d).sort()).toEqual(Object.keys(a).sort());
    expect(Object.keys(d.receipt).filter((k) => k !== "destroy").sort()).toEqual(Object.keys(a.receipt).sort());
    expect(Object.keys(d.receipt.plan).sort(), "receipt.plan keys").toEqual(Object.keys(a.receipt.plan).sort());
    expect(d.command).toBe("apply");
    expect(d.receipt.destroy).toBe(true);
    expect(Object.values(d.receipt.lines).map((l: any) => l.status)).toEqual(expect.arrayContaining(["destroyed"]));
  });

  it("destroying twice is a no-op the agent can recognise", () => {
    const d2 = all.find((x) => x.what === "destroy again")!.r;
    expect(d2.code).toBe(0);
    expect(d2.json.receipt.status).toBe("complete");
    expect(d2.json.receipt.lines).toEqual({});
    expect(d2.json.warnings.join("\n")).toMatch(/Nothing to destroy/);
  });
});
