/**
 * The lock TTL is shorter than the run (slow provider, big plan, a 15-minute TTL vs a 20-minute deploy wait),
 * and the original holder is alive and still working when a second actor arrives.
 *
 * Expected (验收策略 B "不并行写"; 决策-执行模型 §3 scope 锁): a live holder must not be overlapped. Either the
 * holder keeps its lock alive while it works, or — once preempted — it must not go on writing as if it still
 * held it (a fenced write that fails / is reported). In every case the final receipt must account for every
 * resource Sponson created, so that destroy leaves nothing behind.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { applyRun, destroyRun, GitBranchReceiptStore, LocalReceiptStore, type ReceiptStore } from "@sponson/core";
import { bareRemote, engineOpts, neonBranches, simEnv, sleep, tmp, waitFor, workspace } from "./helpers.js";

let sim: SimHandle;
afterEach(async () => sim?.close());

const stores: Array<[string, () => Promise<() => Promise<ReceiptStore>>]> = [
  ["local", async () => { const root = await tmp("ttl-local"); return async () => new LocalReceiptStore(root); }],
  ["git-branch", async () => { const remote = await bareRemote(); return async () => new GitBranchReceiptStore({ remote, workdir: await tmp("ttl-wd") }); }],
];

describe.each(stores)("lock expiry while the holder is alive (%s store)", (_name, makeFactory) => {
  it("a second actor does not run concurrently with a slow but live holder, and destroy afterwards leaves nothing", async () => {
    sim = await startSim();
    sim.state.applyChaos({ latency_ms: 120 });
    const store = await makeFactory();
    const cwd = await workspace();
    const env = simEnv(sim);
    const TTL = 500;

    const events: string[] = [];
    let aDone = false;
    const a = applyRun(await engineOpts(cwd, env, 31, await store(), { lockTtlMs: TTL, onLineDone: (id) => void events.push(`A:${id}`) }))
      .then((r) => { events.push(`A:end:${r.receipt.status}`); return r; })
      .catch((e: Error) => { events.push(`A:error:${(e as { code?: string }).code ?? e.message}`); return null; })
      .finally(() => (aDone = true));

    // Wait until A's lock has expired on paper while A is still mid-run.
    await sleep(TTL + 150);
    expect(aDone, "A should still be running when B arrives (test premise)").toBe(false);
    const b = await applyRun(await engineOpts(cwd, env, 31, await store(), { lockTtlMs: 60_000, onLineDone: (id) => void events.push(`B:${id}`) }))
      .then((r) => { events.push(`B:end:${r.receipt.status}`); return r; })
      .catch((e: Error) => { events.push(`B:error:${(e as { code?: string }).code ?? e.message}`); return null; });
    await a;
    await waitFor(() => aDone);

    const aOk = events.some((e) => e.startsWith("A:end:complete"));
    const bOk = events.some((e) => e.startsWith("B:end:complete"));
    // Two runs that both believe they own pr-31 and both report success = parallel writes to one scope.
    expect.soft({ bothSucceeded: aOk && bOk, b: b?.warnings ?? null, events }, "two live applies on one scope").toMatchObject({ bothSucceeded: false });

    sim.state.applyChaos({ latency_ms: 0 });
    await destroyRun(await engineOpts(cwd, env, 31, await store()));
    expect.soft(neonBranches(sim).filter((n) => n.includes("pr-31")), "orphaned after destroy").toEqual([]);
    expect(sim.state.clerk.redirect_urls.map((r) => r.url), "orphaned after destroy").toEqual([]);
  });
});
