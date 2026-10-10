/**
 * Several pull requests write their own branch value of the same Netlify variable at the same time. The variable is
 * a parent object they share: the first writer creates it (POST), the others add a value to it (PATCH), and the last
 * one to leave deletes it. Without a lock two creates collide, and a destroy that found the variable empty can
 * delete it just after another scope added its value. `netlify.env`'s `lockOn` (ADR 0019) serialises them, so no
 * value is ever lost and the variable goes only with its last value.
 */
import { describe, expect, it } from "vitest";
import { createRegistry, netlifyAdapter } from "@sponson/adapters";
import { applyRun, destroyRun, LocalReceiptStore, parsePlan, type Ctx, type RunOptions } from "@sponson/core";
import { simEnv, startSim, type SimHandle } from "@sponson/sim";
import { tmp } from "./helpers.js";

const SITE = "site_demo";
const LOCK = `netlify:${SITE}:env`;

const planFor = (pr: number) => `version: 1
providers:
  netlify: { site: ${SITE} }
changes:
  - id: env
    adapter: netlify
    op: env
    values:
      SHARED_FLAG: pr-${pr}
      ONLY_${pr}: "yes"
`;

const ctxFor = (pr: number): Ctx => ({ env: "preview", git: { branch: `feat/${pr}`, sha: `${pr}`.padStart(40, "b"), short_sha: "bbbbbbb" }, pr: { number: pr }, scope: `pr-${pr}` });

function runOpts(sim: SimHandle, root: string, pr: number): RunOptions {
  return {
    plan: parsePlan(planFor(pr)).plan,
    ctx: ctxFor(pr),
    registry: createRegistry(),
    store: new LocalReceiptStore(root),
    env: { ...simEnv(sim), SPONSON_HTTP_RETRY_BASE_MS: "5" },
    wait: true,
    pollIntervalMs: 15,
    waitTimeoutMs: 60_000,
  };
}

/** SHARED_FLAG's branch values, as `<branch>=<value>`, sorted; null when the variable does not exist. */
function shared(sim: SimHandle): string[] | null {
  const v = sim.state.netlify.sites[SITE]!.envs.find((e) => e.key === "SHARED_FLAG");
  return v ? v.values.map((x) => `${x.context_parameter}=${x.value}`).sort() : null;
}
const expected = (prs: number[]) => prs.map((pr) => `feat/${pr}=pr-${pr}`).sort();

describe("pull requests writing values of one Netlify variable at once", () => {
  it("names the site's variable collection, and nothing secret, as the parent object", () => {
    expect(netlifyAdapter.ops.env!.lockOn!({ context: "branch", branch: "feat/x", values: { A: "secret-value" } }, { site: SITE })).toBe(LOCK);
    expect(netlifyAdapter.ops.env!.lockOn!({ values: {} }, {})).toBeNull();
  });

  it("concurrent creates, applies and destroys never lose a value, and the variable goes with its last one", async () => {
    const sim = await startSim({ seed: { netlify: { sites: { [SITE]: { name: "demo-site", account: "acme" } } } } });
    try {
      // Every request waits, so unserialised writers would interleave between their read and their write.
      sim.state.chaos.latency_ms = 25;
      const root = await tmp("netlify-parent");
      const open = (pr: number) => applyRun(runOpts(sim, root, pr));
      const close = (pr: number) => destroyRun(runOpts(sim, root, pr));

      // All four find SHARED_FLAG missing: one creates it, the others add their value to it.
      const prs = [101, 102, 103, 104];
      for (const r of await Promise.all(prs.map(open))) expect(r.receipt.status).toBe("complete");
      expect(shared(sim)).toEqual(expected(prs));

      // Two close (each checks whether the variable is now empty) while two others open and add values.
      const mixed = await Promise.all([close(101), close(102), open(105), open(106)]);
      for (const r of mixed) expect(r.receipt.status).toBe("complete");
      expect(shared(sim)).toEqual(expected([103, 104, 105, 106]));
      expect(sim.state.netlify.sites[SITE]!.envs.map((e) => e.key).sort()).toEqual(["ONLY_103", "ONLY_104", "ONLY_105", "ONLY_106", "SHARED_FLAG"]);

      // The last ones out remove the variable, and every lock is released.
      for (const r of await Promise.all([103, 104, 105, 106].map(close))) expect(r.receipt.status).toBe("complete");
      expect(shared(sim)).toBeNull();
      expect(sim.state.netlify.sites[SITE]!.envs).toEqual([]);
      expect(await new LocalReceiptStore(root).readParentLock!(LOCK)).toBeNull();
    } finally {
      await sim.close();
    }
  }, 120_000);

  it("the control case: without the lock, the same concurrent creates collide", async () => {
    const sim = await startSim({ seed: { netlify: { sites: { [SITE]: { name: "demo-site", account: "acme" } } } } });
    try {
      sim.state.chaos.latency_ms = 25;
      const root = await tmp("netlify-parent-control");
      const { lockOn: _lock, ...unlocked } = netlifyAdapter.ops.env!;
      const registry = createRegistry().addAdapter({ ...netlifyAdapter, ops: { env: unlocked } });
      const prs = [301, 302, 303, 304];
      const results = await Promise.all(prs.map((pr) => applyRun({ ...runOpts(sim, root, pr), registry })));
      // Each POSTs SHARED_FLAG with its own new variable; all but one are refused, and the fallback cannot PATCH a
      // variable that does not exist, so those lines fail (or, with other timings, a value goes missing).
      const lost = results.some((r) => r.receipt.status !== "complete") || JSON.stringify(shared(sim)) !== JSON.stringify(expected(prs));
      expect(lost).toBe(true);
    } finally {
      await sim.close();
    }
  }, 60_000);
});
