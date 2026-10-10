/**
 * An agent meets a manual step (ADR 0021) through `sponson mcp`: a Google OAuth redirect URI only a person can add.
 * Per SKILL.md and the tool descriptions, the agent finds the step as `todo` in plan, gets `ok: false` with
 * MANUAL_STEP_PENDING and the instructions from apply, shows them to the human, and confirms only when the human
 * says they did it. The descriptions must say so.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentWorld, diffForHuman, previewPlan, repo, type McpAgent } from "./harness.js";

const manualLine = {
  id: "google-redirect",
  adapter: "manual",
  op: "step",
  title: "Allow ${ctx.scope}'s callback on the Google OAuth client",
  vars: { db: { from: "db.branch_id" } },
  instructions: "In the Google Cloud console, add https://${ctx.scope}.preview.example.app/api/auth/callback/google (database {db}) to the client's redirect URIs.",
  undo: "Remove https://${ctx.scope}.preview.example.app/api/auth/callback/google from the client's redirect URIs.",
  environments: ["preview"],
};

let w: AgentWorld;
let agent: McpAgent;

beforeAll(async () => {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = "fake_ts_manual_steps";
  await w.writePlan(previewPlan([manualLine]));
  agent = await w.mcp();
}, 60_000);
afterAll(async () => {
  await agent?.close();
  await w.close();
});

describe("an agent and a manual step", () => {
  it("the tool descriptions and SKILL.md tell the agent to show the step to the human and never confirm it itself", async () => {
    const { tools } = await agent.client.listTools();
    const apply = tools.find((t) => t.name === "sponson_apply")!;
    expect(apply.description).toMatch(/MANUAL_STEP_PENDING/);
    expect(apply.description).toMatch(/never confirm a step on your own/);
    expect(JSON.stringify(apply.inputSchema)).toMatch(/confirm.*Never on your own/);
    expect(tools.find((t) => t.name === "sponson_plan")!.description).toMatch(/todo/);
    const skill = await readFile(join(repo, "SKILL.md"), "utf8");
    expect(skill).toMatch(/MANUAL_STEP_PENDING/);
    expect(skill).toMatch(/never confirm on your own/);
  });

  it("plan shows the step as `todo` once its input exists, with the instructions filled in", async () => {
    let plan = await agent.plan();
    expect(plan.json.lines.find((l: { id: string }) => l.id === "google-redirect").status).toBe("pending");
    const r = await agent.apply();
    expect(r.json).toMatchObject({ ok: false, error: { code: "MANUAL_STEP_PENDING", lines: ["google-redirect"] }, receipt: { status: "partial" } });
    expect(r.json.error.hint).toMatch(/--confirm <line>/);
    expect(r.json.manual).toEqual([expect.objectContaining({ line: "google-redirect", action: "do", title: "Allow pr-42's callback on the Google OAuth client" })]);
    expect(r.json.manual[0].instructions).toMatch(/^In the Google Cloud console, add https:\/\/pr-42\.preview\.example\.app\/api\/auth\/callback\/google \(database br-/);
    expect(r.json.receipt.lines.db.status).toBe("applied");
    expect(r.json.receipt.lines["google-redirect"]).toMatchObject({ status: "waiting", waitingFor: "confirmation", errorCode: "MANUAL_STEP_PENDING" });

    plan = await agent.plan();
    expect(plan.json.lines.find((l: { id: string }) => l.id === "google-redirect")).toMatchObject({ status: "todo", manual: { action: "do" } });
    expect(diffForHuman(plan.json)).toContain("* google-redirect manual.step todo");
  });

  it("confirms only what the human says they did, recording who; a non-manual line cannot be confirmed", async () => {
    const wrong = await agent.apply({ confirm: "env", approvedBy: "alice" });
    expect(wrong.json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    const r = await agent.apply({ confirm: "google-redirect", approvedBy: "alice" });
    expect(r.json, r.text).toMatchObject({ ok: true, receipt: { status: "complete" } });
    expect(r.json.receipt.ledger.find((e: { line: string }) => e.line === "google-redirect").manual).toMatchObject({ how: "confirmed", by: "alice" });
    expect(r.json.error).toBeUndefined();
    expect(r.json.manual).toBeUndefined();
  });

  it("destroy returns the undo for the human and waits; confirming it finishes the teardown", async () => {
    const d = await agent.apply({ destroy: true });
    expect(d.json).toMatchObject({ ok: false, error: { code: "MANUAL_STEP_PENDING" }, manual: [{ line: "google-redirect", action: "undo" }] });
    expect(d.json.manual[0].instructions).toMatch(/^Remove https:\/\/pr-42\.preview\.example\.app/);
    const done = await agent.apply({ destroy: true, confirm: "google-redirect", approvedBy: "alice" });
    expect(done.json).toMatchObject({ ok: true, receipt: { status: "complete", ledger: [] } });
  });
});
