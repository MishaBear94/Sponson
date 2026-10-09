/**
 * Several actors apply the SAME scope at once. 验收策略 B: "第二次获取 scope 锁失败，等待或退出，不并行写".
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { applyRun, LocalReceiptStore } from "@sponson/core";
import { bareRemote, cli, ctxArgs, engineOpts, neonBranches, remoteFile, simEnv, spawnCli, tmp, workspace } from "./helpers.js";

let sim: SimHandle;
afterEach(async () => sim?.close());

describe("same scope, many actors", () => {
  it("three CI runners (separate processes, separate clones) race on PR 7 with the git-branch store: one applies, two exit 3, nothing is duplicated", async () => {
    sim = await startSim();
    sim.state.applyChaos({ latency_ms: 40 });
    const remote = await bareRemote();
    const runners = await Promise.all([0, 1, 2].map(async () => ({ cwd: await workspace(), tmp: await tmp("runner") })));
    const results = await Promise.all(
      runners.map((r) => spawnCli(["apply", "--json", "--receipts", "git-branch", "--receipts-remote", remote, ...ctxArgs(7)], r.cwd, simEnv(sim, { TMPDIR: r.tmp })).done),
    );
    const codes = results.map((r) => r.code).sort();
    expect(codes, results.map((r) => r.stdout + r.stderr).join("\n----\n")).toEqual([0, 3, 3]);
    for (const r of results.filter((x) => x.code === 3)) expect(r.json?.error?.code).toBe("LOCK_HELD");
    expect(neonBranches(sim).filter((n) => n === "sponson/preview/pr-7")).toHaveLength(1);
    expect(sim.state.clerk.redirect_urls).toHaveLength(1);
    const latest = JSON.parse((await remoteFile(remote, "preview/pr-7/latest.json"))!);
    expect(latest.status).toBe("complete");
    expect(latest.lines.db.createdBy).toBe("sponson");
    expect(await remoteFile(remote, "preview/pr-7/lock.json")).toBeNull();
  });

  it("a developer and two CI jobs call run() in-process on one local store: exactly one wins", async () => {
    sim = await startSim();
    sim.state.applyChaos({ latency_ms: 20 });
    const cwd = await workspace();
    const dir = join(cwd, ".sponson/receipts");
    const argv = ["apply", "--json", "--receipts", "local", "--receipts-dir", dir, ...ctxArgs(8)];
    const results = await Promise.all([0, 1, 2].map(() => cli(argv, cwd, simEnv(sim))));
    expect(results.map((r) => r.code).sort()).toEqual([0, 3, 3]);
    expect(neonBranches(sim).filter((n) => n === "sponson/preview/pr-8")).toHaveLength(1);
  });

  it("several runners find the same expired lock (crashed holder) at once: only one may take it over (local store)", async () => {
    // Expected (验收策略 B, 锁持有者崩溃): an expired lock "可被抢占" — by ONE successor, with the others refused.
    // Runners arrive a few event-loop turns apart, as separate jobs do; the expired lock is what a crashed run leaves.
    sim = await startSim();
    sim.state.applyChaos({ latency_ms: 30 });
    const cwd = await workspace();
    const root = await tmp("local-store");
    const plant = async (pr: number) => {
      await mkdir(join(root, "preview", `pr-${pr}`), { recursive: true });
      await writeFile(join(root, "preview", `pr-${pr}`, "lock.json"), JSON.stringify({ holder: "crashed", acquiredAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString() }));
    };
    const stagger = async (i: number) => {
      for (let k = 0; k < i; k++) await new Promise((r) => setImmediate(r));
    };
    const holders: number[] = [];
    // End to end: five engine runs.
    for (let round = 0; round < 3; round++) {
      const pr = 20 + round;
      await plant(pr);
      const runs = await Promise.allSettled([0, 1, 2, 3, 4].map(async (i) => { const o = await engineOpts(cwd, simEnv(sim), pr, new LocalReceiptStore(root)); await stagger(i); return applyRun(o); }));
      holders.push(runs.filter((r) => r.status === "fulfilled").length);
    }
    // The store alone, hammered: eight contenders per round.
    for (let round = 0; round < 10; round++) {
      const pr = 30 + round;
      await plant(pr);
      const got = await Promise.allSettled([0, 1, 2, 3, 4, 5, 6, 7].map(async (i) => { await stagger(i); return new LocalReceiptStore(root).acquireLock("preview", `pr-${pr}`, `runner-${i}`, 60_000); }));
      holders.push(got.filter((r) => r.status === "fulfilled").length);
    }
    expect(holders, "number of runners that each believed they held the lock, per round").toEqual(holders.map(() => 1));
  });
});
