/**
 * Read-only actors (an agent calling plan, the PR comment job) running while other scopes or the same scope are
 * being applied. `plan` must stay read-only and must not tell the user to adopt resources that belong to a
 * neighbouring PR, nor misreport the in-flight work of a live apply.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { applyRun, LocalReceiptStore, planRun } from "@sponson/core";
import { cli, ctxArgs, engineOpts, neonBranches, simEnv, waitFor, workspace } from "./helpers.js";

let sim: SimHandle;
afterEach(async () => sim?.close());

describe("plan alongside other actors", () => {
  it("plan for PR 72 while PR 71 is being applied (and after): reports no PR-71 resource as `unmanaged`", async () => {
    // Expected (SKILL.md rule 5 + 产品定义): `unmanaged` means "exists, nobody manages it — adopt it with init".
    // PR 71's branch and callback are managed by Sponson under another scope's receipt; telling PR 72's agent to adopt
    // them would let `init` pull a neighbour's resources into this PR's plan.
    sim = await startSim();
    const cwd = await workspace();
    const root = join(cwd, ".sponson/receipts");
    const env = simEnv(sim);

    sim.state.applyChaos({ latency_ms: 60 });
    const a = applyRun(await engineOpts(cwd, env, 71, new LocalReceiptStore(root)));
    await waitFor(() => neonBranches(sim).includes("sponson/preview/pr-71"), 10_000, "PR 71's branch");
    const mid = await planRun(await engineOpts(cwd, env, 72, new LocalReceiptStore(root)));
    await a;
    sim.state.applyChaos({ latency_ms: 0 });
    const after = await cli(["plan", "--json", "--receipts", "local", "--receipts-dir", root, ...ctxArgs(72)], cwd, env);
    const neighbours = (d: Array<{ kind: string; resource: { key: string; label?: string } }>) =>
      d.filter((x) => x.kind === "unmanaged").map((x) => x.resource.label ?? x.resource.key);
    expect({ midApply: neighbours(mid.drift), afterApply: neighbours(after.json?.drift ?? []) }).toEqual({ midApply: [], afterApply: [] });
  });

  it("plan on the SAME scope while its apply is mid-way: no writes, no error, and it says an apply is in progress", async () => {
    // Expected (plain user expectation; SKILL.md tells agents exit 3 means "another apply holds the lock (wait, do not
    // force)"): a plan taken mid-apply shows half-applied lines as if they were final; the user/agent must be told
    // the scope is locked by a running apply so they do not act on a moving picture.
    sim = await startSim();
    const cwd = await workspace();
    const root = join(cwd, ".sponson/receipts");
    const env = simEnv(sim);
    sim.state.applyChaos({ latency_ms: 60 });
    const a = applyRun(await engineOpts(cwd, env, 73, new LocalReceiptStore(root)));
    await waitFor(() => neonBranches(sim).includes("sponson/preview/pr-73"), 10_000, "PR 73's branch");
    const before = sim.state.writes.length;
    const p = await cli(["plan", "--json", "--receipts", "local", "--receipts-dir", root, ...ctxArgs(73)], cwd, env);
    const planWrites = sim.state.writes.length - before;
    await a;
    expect(p.code, p.stdout + p.stderr).toBe(0);
    expect(planWrites).toBeLessThanOrEqual(2); // only the concurrent apply's own writes may land meanwhile
    // SKILL.md (v2) Output: plan carries `lock` while an apply runs on this scope; the warning wording is free text.
    expect(p.json?.lock, JSON.stringify(p.json?.warnings)).toBeTruthy();
    expect(JSON.stringify(p.json?.warnings ?? []) + p.stderr).toMatch(/lock|in progress|another apply|apply \S+ is running/i);
  });
});
