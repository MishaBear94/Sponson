/**
 * A CI runner is SIGKILLed mid-apply (runner preempted, job cancelled, OOM). Another actor takes over later.
 * Design: a crashed process does not release its lock, the lock expires instead; all resources of a scope live and
 * die together; destroy removes everything with `created_by: sponson`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { bareRemote, branchOf, checkout, ctxArgs, git, humanClone, neonBranches, remoteFile, spawnCli, tmp, waitFor } from "./helpers.js";
import { cliEnv } from "../../support.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let sim: SimHandle;
afterEach(async () => sim?.close());

/**
 * The receipts store's push budget for these runs; every wait below is derived from it, so only the product can give
 * up first. Runner 1 makes two store writes (lock, checkpoint receipt) before it creates the Neon branch.
 */
const STORE_BUDGET_MS = 60_000;
/** One run of the CLI: process start plus a handful of store operations, each bounded by the budget. */
const RUN_MS = 4 * STORE_BUDGET_MS;

/** What a human would do after the 15-minute TTL: nothing. We fast-forward time by rewriting the lock as expired. */
async function expireLock(remote: string, scope: string) {
  const branch = branchOf(`preview/${scope}`);
  const dir = await humanClone(remote, branch);
  await writeFile(join(dir, "preview", scope, "lock.json"), JSON.stringify({ holder: "killed-runner", acquiredAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString() }) + "\n");
  await git(dir, ["commit", "-qam", "time passes"]);
  await git(dir, ["push", "-q", "origin", branch]);
}

describe("crash mid-apply, then another actor", () => {
  it("SIGKILL after the Neon branch is created: the next run is refused while the lock is live, takes over once it expires, and a later destroy removes the branch the killed run created", async () => {
    sim = await startSim();
    const remote = await bareRemote();
    const scope = "pr-11";
    const args = ["--json", "--receipts", "git-branch", "--receipts-remote", remote, ...ctxArgs(11)];
    const env = (runner: string) => tmp(runner).then((dir) => cliEnv(sim, { TMPDIR: dir, SPONSON_STORE_BUDGET_MS: String(STORE_BUDGET_MS) }));

    // Runner 1: slow cloud so we can kill it between "branch created" and "receipt written".
    sim.state.applyChaos({ latency_ms: 150 });
    const a = spawnCli(["apply", ...args], await checkout(), await env("runner-a"));
    await waitFor(() => neonBranches(sim).includes("sponson/preview/pr-11"), 2 * STORE_BUDGET_MS + 30_000, "runner 1 to create the branch");
    a.child.kill("SIGKILL");
    const killed = await a.done;
    expect(killed.signal).toBe("SIGKILL");
    sim.state.applyChaos({ latency_ms: 0 });
    // v2 (write-ahead intent): a checkpoint receipt is written before every create, so the killed run left
    // a `failed` receipt whose ledger already records the intent to create the branch. What matters is that the next run
    // claims it and destroy removes it (asserted below).
    const checkpoint = JSON.parse((await remoteFile(remote, `preview/${scope}/latest.json`))!);
    expect(checkpoint.status).toBe("failed");
    expect(checkpoint.lines.db).toMatchObject({ status: "failed", errorCode: "INTERRUPTED" });
    expect(checkpoint.ledger).toEqual(expect.arrayContaining([expect.objectContaining({ key: "branch:sponson/preview/pr-11", line: "db" })]));
    expect(await remoteFile(remote, `preview/${scope}/lock.json`)).not.toBeNull(); // lock left behind

    // Runner 2 (re-run of the job) while the lock is still live: refused with exit 3.
    const b = await spawnCli(["apply", ...args], await checkout(), await env("runner-b")).done;
    expect(b.code, b.stdout + b.stderr).toBe(3);

    // After expiry, runner 3 takes over and finishes the scope.
    await expireLock(remote, scope);
    const c = await spawnCli(["apply", ...args], await checkout(), await env("runner-c")).done;
    expect(c.code, c.stdout + c.stderr).toBe(0);
    expect(c.json?.receipt?.status).toBe("complete");
    expect(JSON.stringify(c.json?.warnings)).toMatch(/expired lock/);

    // PR closes: destroy must remove everything Sponson created for this scope, including the branch the killed run made.
    const d = await spawnCli(["apply", "--destroy", ...args], await checkout(), await env("runner-d")).done;
    expect(d.code, d.stdout + d.stderr).toBe(0);
    const leftovers = {
      neon: neonBranches(sim).filter((n) => n.includes(scope)),
      vercel: Object.values(sim.state.vercel.projects).flatMap((p) => p.envs).filter((e) => e.gitBranch === "feat/pr-11").map((e) => e.key),
      clerk: sim.state.clerk.redirect_urls.map((r) => r.url),
      dbLine: d.json?.receipt?.lines?.db,
    };
    expect(leftovers, "orphaned after destroy").toMatchObject({ neon: [], vercel: [], clerk: [] });
  }, 2 * STORE_BUDGET_MS + 30_000 + 3 * RUN_MS); // the wait for runner 1, then runners 2-4; only the product's own budget may give up first
});
