 
/**
 * Task: "open a preview environment with a Clerk callback", then, in a NEW session with no memory,
 * "the deploy finished, continue". The agent follows SKILL.md literally through `sponson mcp`:
 * plan → show diff → (human yes) → apply → partial → do not retry → later: receipt + plan → apply → complete.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentWorld, callbackLine, diffForHuman, previewPlan, SKILL, type McpAgent } from "./harness.js";

const SECRET = "fake_ts_deploy_journey_secret";
let w: AgentWorld;
let session1: McpAgent;
let session2: McpAgent | undefined;

beforeAll(async () => {
  w = await AgentWorld.create();
  w.env.STRIPE_KEY = SECRET;
  await w.sim.state.applyChaos({ deploy: "never" });
  await w.writePlan(previewPlan([callbackLine]));
  session1 = await w.mcp();
}, 60_000);
afterAll(async () => {
  await session1?.close();
  await session2?.close();
  await w.close();
});

describe("partial → complete, reconstructed from the receipt by a fresh session", () => {
  it("session 1: plan, show the human, apply, read the receipt, stop on partial", async () => {
    const plan = await session1.plan();
    expect(plan.isError).toBe(false);
    expect(plan.json.ok).toBe(true);
    // The agent can render the SKILL.md diff from statuses alone.
    expect(diffForHuman(plan.json)).toEqual(["+ db neon.branch create", "? env vercel.env pending", "? callback clerk.redirect_allow pending"]);
    expect(w.sim.state.writes).toHaveLength(0);

    // Human: "yes".
    const apply = await session1.apply();
    expect(apply.isError).toBe(false);
    expect(apply.json.ok).toBe(true); // SKILL rule 2: partial is not failure
    expect(apply.json.receipt.status).toBe("partial");
    expect(apply.json.receipt.lines.callback).toMatchObject({ status: "waiting", waitingFor: "deploy" });
    expect(apply.text).not.toContain(SECRET);

    // Rule 6: read the receipt, not memory.
    const rc = await session1.receipt();
    expect(rc.json.receipt.runId).toBe(apply.json.receipt.runId);
    expect(rc.json.receipt.status).toBe("partial");

    // Rule 2: do not retry. If an over-eager agent does, nothing is written.
    const writes = w.sim.state.writes.length;
    const again = await session1.apply();
    expect(again.json.receipt.status).toBe("partial");
    expect(w.sim.state.writes.length).toBe(writes);
  });

  it("session 1: the pending callback in plan JSON says what it waits for (the human-readable plan says `(deploy)`)", async () => {
    // To tell the human "registered once the preview deploys" (SKILL example 2) the agent needs the event,
    // which the text renderer has (render.ts planRow) but planJson drops.
    const plan = await session1.plan();
    const cb = plan.json.lines.find((l: any) => l.id === "callback");
    expect(cb.status).toBe("pending");
    const said = JSON.stringify(cb);
    expect(said, `callback plan line has no machine-readable event: ${said}`).toMatch(/"(waitingFor|event)":"deploy"/);
  });

  it("session 2 (no memory): reconstructs state from receipt + plan, finishes after the deploy", async () => {
    await session1.close();
    session2 = await w.mcp();

    const rc = await session2.receipt();
    expect(rc.json.ok).toBe(true);
    expect(rc.json.receipt.status).toBe("partial");
    const waiting = Object.values(rc.json.receipt.lines as Record<string, any>).filter((l) => l.status === "waiting");
    expect(waiting.map((l) => [l.id, l.waitingFor])).toEqual([["callback", "deploy"]]);
    for (const l of Object.values(rc.json.receipt.lines as Record<string, any>)) expect(SKILL.lineStatuses).toContain(l.status);

    // Still waiting: plan agrees with the receipt.
    let plan = await session2.plan();
    expect(plan.json.lines.find((l: any) => l.id === "callback").status).toBe("pending");

    // The deploy lands.
    await w.sim.state.applyChaos({ deploy: "ok" });
    plan = await session2.plan();
    const cb = plan.json.lines.find((l: any) => l.id === "callback");
    expect(cb.status).toBe("create");
    expect(cb.inputs.url).toMatchObject({ state: "resolved", ref: "env.preview_url" });
    expect(cb.inputs.url.value).toMatch(/vercel\.app/);
    expect(diffForHuman(plan.json)).toEqual(["= db neon.branch unchanged", "= env vercel.env unchanged", "+ callback clerk.redirect_allow create"]);

    // Human: "yes".
    const apply = await session2.apply();
    expect(apply.json.receipt.status).toBe("complete");
    expect(apply.json.receipt.lines.callback.status).toBe("applied");
    const after = await session2.receipt();
    expect(after.json.receipt.runId).toBe(apply.json.receipt.runId);
    expect(after.json.receipt.status).toBe("complete");
    expect(after.text).not.toContain(SECRET);
    expect(w.sim.state.clerk.redirect_urls.map((r) => r.url)).toEqual([cb.inputs.url.value]);
  });

  it("session 2: the receipt holds the preview URL (SKILL rule 6: `lines[id].outputs` holds non-sensitive outputs, e.g. `preview_url`)", async () => {
    // "Continue with the code change" needs the URL. The agent must get it from the receipt, not from a plan input it happened to see.
    const rc = await session2!.receipt();
    const withUrl = Object.values(rc.json.receipt.lines as Record<string, any>).filter((l) => typeof l.outputs?.preview_url === "string");
    expect(withUrl.map((l) => l.id), `outputs in receipt: ${JSON.stringify(Object.fromEntries(Object.entries(rc.json.receipt.lines as Record<string, any>).map(([k, l]) => [k, l.outputs])))}`).toEqual(["env"]);
  });

  it("session 2: \"clean up this PR\" → destroy, then the receipt shows what was removed and the cloud is empty", async () => {
    const d = await session2!.apply({ destroy: true });
    expect(d.isError).toBe(false);
    expect(d.json.receipt).toMatchObject({ destroy: true, status: "complete" });
    expect(Object.fromEntries(Object.entries(d.json.receipt.lines as Record<string, any>).map(([k, l]) => [k, l.status]))).toEqual({ callback: "destroyed", env: "destroyed", db: "destroyed" });
    const rc = await session2!.receipt();
    expect(rc.json.receipt.runId).toBe(d.json.receipt.runId);
    expect(w.sim.state.clerk.redirect_urls).toEqual([]);
    expect(w.sim.state.vercel.projects.prj_demo!.envs).toEqual([]);
    expect(w.sim.state.neon.projects.proj_demo!.branches.map((b) => b.name)).toEqual(["main"]);
    const plan = await session2!.plan();
    expect(plan.json.lines.map((l: any) => l.status)).toEqual(["create", "pending", "pending"]);
  });
});
