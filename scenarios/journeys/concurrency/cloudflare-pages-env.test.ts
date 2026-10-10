/**
 * Several pull requests write their own keys into one Cloudflare Pages project's preview `env_vars` map at the same
 * time. Each apply is read-modify-write of that map on one project object (read, PATCH the line's keys, re-read and
 * check that no other key vanished), so `cloudflare.pages_env` names the map with `lockOn` and the engine serialises
 * the writers across scopes (ADR 0019). No key is lost, no run mistakes another scope's concurrent destroy for a lost
 * key, and no parent lock is left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "@sponson/adapters";
import { applyRun, destroyRun, LocalReceiptStore, parsePlan, type Ctx, type RunOptions } from "@sponson/core";
import { simEnv, startSim, type SimHandle } from "@sponson/sim";
import { tmp } from "./helpers.js";

const PARENT = "cloudflare:acc_demo:pages:demo:preview:env";
const keyOf = (pr: number) => `PR_${pr}_FLAG`;

const planFor = (pr: number) => `version: 1
providers:
  cloudflare: { account: acc_demo, project: demo }
changes:
  - id: pages
    adapter: cloudflare
    op: pages_env
    vars:
      ${keyOf(pr)}: "on"
    environments: [preview]
`;

const ctxFor = (pr: number): Ctx => ({ env: "preview", git: { branch: `feat/${pr}`, sha: `${pr}`.padStart(40, "c"), short_sha: "ccccccc" }, pr: { number: pr }, scope: `pr-${pr}` });

describe("pull requests writing one Pages preview env_vars map at once", () => {
  let sim: SimHandle;
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    sim = await startSim({ seed: { cloudflare: { accounts: { acc_demo: { demo: { preview: { HUMAN: "set in the dashboard" } } } } } } });
    // Every request waits a little: read, pause, write back, re-read — wide enough for unserialised writers to overlap.
    await fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify({ latency_ms: 15 }), headers: { "content-type": "application/json" } });
    env = { ...simEnv(sim), SPONSON_HTTP_RETRY_BASE_MS: "5" };
  });
  afterAll(async () => {
    await sim?.close();
  });

  const opts = (pr: number): RunOptions => ({
    plan: parsePlan(planFor(pr)).plan,
    ctx: ctxFor(pr),
    registry: createRegistry(),
    store: new LocalReceiptStore(root),
    env,
    wait: true,
    pollIntervalMs: 15,
    waitTimeoutMs: 60_000,
  });
  const preview = () => sim.state.cloudflare.accounts.acc_demo!.projects.demo!.deployment_configs.preview.env_vars;
  const keys = () => Object.keys(preview()).sort();

  it("concurrent applies and destroys never lose a key, and every run completes", async () => {
    root = await tmp("cloudflare-parent");
    const prs = [101, 102, 103, 104, 105, 106];
    const applied = await Promise.all(prs.map((pr) => applyRun(opts(pr))));
    applied.forEach((r, i) => {
      expect(r.receipt.status, JSON.stringify(r.receipt.lines)).toBe("complete");
      expect(r.receipt.ledger.find((e) => e.key === `env:preview:${keyOf(prs[i]!)}`)?.parent).toBe(PARENT);
    });
    expect(keys()).toEqual(["HUMAN", ...prs.map(keyOf)].sort());

    // Half close while the other half re-apply unchanged and two new pull requests open.
    const closing = prs.slice(0, 3);
    const staying = prs.slice(3);
    const opening = [201, 202];
    const mixed = await Promise.all([...closing.map((pr) => destroyRun(opts(pr))), ...staying.map((pr) => applyRun(opts(pr))), ...opening.map((pr) => applyRun(opts(pr)))]);
    for (const r of mixed) expect(r.receipt.status, JSON.stringify(r.receipt.lines)).toBe("complete");
    expect(keys()).toEqual(["HUMAN", ...staying.map(keyOf), ...opening.map(keyOf)].sort());
    expect(preview().HUMAN).toEqual({ type: "plain_text", value: "set in the dashboard" });

    expect(await new LocalReceiptStore(root).readParentLock!(PARENT)).toBeNull();
  }, 120_000);
});
