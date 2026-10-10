/**
 * Mixed actors on one scope: apply vs destroy (PR closed while a late push re-runs apply), and a human
 * deleting / rewinding the receipts branch while a run is in flight.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { applyRun, destroyRun, GitBranchReceiptStore, LocalReceiptStore, type Receipt } from "@sponson/core";
import { bareRemote, branchOf, checkout, engineOpts, exec, git, humanClone, neonBranches, remoteFile, tmp, waitFor } from "./helpers.js";
import { cliEnv } from "../../support.js";

let sim: SimHandle;
afterEach(async () => sim?.close());

function scopeResources(sim: SimHandle, pr: number) {
  return {
    neon: neonBranches(sim).filter((n) => n === `sponson/preview/pr-${pr}`).length,
    vercel: Object.values(sim.state.vercel.projects).flatMap((p) => p.envs).filter((e) => e.gitBranch === `feat/pr-${pr}`).length,
    clerk: sim.state.clerk.redirect_urls.filter((r) => r.url.includes(`${pr}`.padStart(8, "0"))).length,
  };
}

describe("apply vs destroy on one scope", () => {
  it("PR closed (destroy --wait) while a late push re-runs apply --wait: they serialize, and the cloud matches whichever receipt is last", async () => {
    sim = await startSim();
    const cwd = await checkout();
    const env = cliEnv(sim);
    const root = await tmp("ad-local");
    const results: string[] = [];
    for (let round = 0; round < 3; round++) {
      const pr = 81 + round;
      const store = () => new LocalReceiptStore(root);
      await applyRun(await engineOpts(cwd, env, pr, store()));
      sim.state.applyChaos({ latency_ms: 25 });
      const opts = { wait: true, pollIntervalMs: 20, waitTimeoutMs: 20_000 };
      const order: string[] = [];
      const doApply = async () => { const r = await applyRun(await engineOpts(cwd, env, pr, store(), opts)); order.push("apply"); return r; };
      const doDestroy = async () => { const r = await destroyRun(await engineOpts(cwd, env, pr, store(), opts)); order.push("destroy"); return r; };
      await Promise.all(round % 2 ? [doDestroy(), doApply()] : [doApply(), doDestroy()]);
      sim.state.applyChaos({ latency_ms: 0 });
      const latest = (await store().read("preview", `pr-${pr}`)) as Receipt;
      const res = scopeResources(sim, pr);
      const consistent = latest.destroy ? res.neon + res.vercel + res.clerk === 0 : res.neon === 1 && res.vercel === 1 && res.clerk === 1 && latest.status === "complete";
      results.push(`${order.join(">")}: ${consistent ? "consistent" : `INCONSISTENT ${JSON.stringify({ destroy: !!latest.destroy, res })}`}`);
    }
    expect(results.every((r) => r.endsWith(": consistent")), results.join("\n")).toBe(true);
  });
});

describe("a human tampers with the receipts branch mid-run", () => {
  it("branch deleted while PR 91's apply holds the lock, and a re-run job starts: no two applies overlap, and destroy afterwards leaves nothing", async () => {
    // README/receipts README: "Deleting it is safe: Sponson will treat every resource as unmanaged". Mid-run, the
    // deletion also deletes the live holder's lock. Expected: the scope stays single-writer (the holder notices its
    // lock vanished, or the newcomer is refused), and the end state is fully accounted for.
    sim = await startSim();
    const remote = await bareRemote();
    const cwd = await checkout();
    const env = cliEnv(sim);
    sim.state.applyChaos({ latency_ms: 80 });
    const events: string[] = [];
    const a = applyRun(await engineOpts(cwd, env, 91, new GitBranchReceiptStore({ remote, workdir: await tmp("wd-a"), fallbackDir: await tmp("wd-a-unpushed") })))
      .then((r) => events.push(`A:${r.receipt.status}`), (e: Error & { code?: string }) => events.push(`A:error:${e.code ?? e.message.slice(0, 80)}`));
    await waitFor(async () => (await remoteFile(remote, "preview/pr-91/lock.json")) !== null, 10_000, "A's lock");
    await exec("git", ["--git-dir", remote, "update-ref", "-d", `refs/heads/${branchOf("preview/pr-91")}`]);
    const b = await applyRun(await engineOpts(cwd, env, 91, new GitBranchReceiptStore({ remote, workdir: await tmp("wd-b"), fallbackDir: await tmp("wd-b-unpushed") })))
      .then((r) => `B:${r.receipt.status}`, (e: Error & { code?: string }) => `B:error:${e.code ?? e.message.slice(0, 80)}`);
    await a;
    events.push(b);
    expect.soft(events.filter((e) => e.endsWith(":complete")).length, `both applies ran on pr-91: ${events.join(", ")}`).toBeLessThanOrEqual(1);

    sim.state.applyChaos({ latency_ms: 0 });
    await destroyRun(await engineOpts(cwd, env, 91, new GitBranchReceiptStore({ remote, workdir: await tmp("wd-c"), fallbackDir: await tmp("wd-c-unpushed") })));
    expect(scopeResources(sim, 91), "left behind after destroy").toEqual({ neon: 0, vercel: 0, clerk: 0 });
  });

  it("branch force-rewound to an older commit mid-run (no second actor): the run still lands its receipt and releases cleanly", async () => {
    sim = await startSim();
    const remote = await bareRemote();
    const cwd = await checkout();
    const env = cliEnv(sim);
    // History: PR 92's earlier receipt exists (on its own branch), then PR 93's apply starts.
    await applyRun(await engineOpts(cwd, env, 92, new GitBranchReceiptStore({ remote, workdir: await tmp("wd-0"), fallbackDir: await tmp("wd-0-unpushed") })));
    sim.state.applyChaos({ latency_ms: 60 });
    const a = applyRun(await engineOpts(cwd, env, 93, new GitBranchReceiptStore({ remote, workdir: await tmp("wd-a"), fallbackDir: await tmp("wd-a-unpushed") })));
    await waitFor(async () => (await remoteFile(remote, "preview/pr-93/lock.json")) !== null, 10_000, "A's lock");
    // Rewound to the branch's first commit, from before A took its lock.
    const branch = branchOf("preview/pr-93");
    const human = await humanClone(remote, branch);
    const [old] = (await git(human, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n");
    await git(human, ["reset", "-q", "--hard", old!]);
    await git(human, ["push", "-q", "--force", "origin", branch]);
    const r = await a;
    expect(r.receipt.status).toBe("complete");
    expect(JSON.parse((await remoteFile(remote, "preview/pr-93/latest.json"))!).runId).toBe(r.receipt.runId);
    expect(await remoteFile(remote, "preview/pr-92/latest.json")).not.toBeNull();
    expect(await remoteFile(remote, "preview/pr-93/lock.json")).toBeNull();
  });
});
