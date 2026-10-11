/**
 * Two pull requests add their preview URL to one list on one shared provider object at the same moment, through the
 * real adapters against the sim: Supabase's `uri_allow_list` (`supabase.auth_redirect`) and an allow-list on a parent
 * object of a generic REST API (`http.list_item`). The sim answers every request after a delay, so both runs read the
 * list before either writes it back. Each op names the parent object (`lockOn`, ADR 0019), so the engine serialises
 * the two writes: no entry is lost, each run writes the list exactly once (no lost-write repair rounds), every ledger
 * entry records the object it lives in, and no lock is left behind. Then one pull request closes while the other
 * re-applies and a third opens, again at the same moment.
 */
import { describe, expect, it } from "vitest";
import { applyRun, destroyRun, LocalReceiptStore, parsePlan, type Ctx, type RunOptions } from "@sponson/core";
import { createRegistry } from "@sponson/adapters";
import { simEnv, startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { tmp } from "./helpers.js";

const ctxFor = (pr: number): Ctx => ({ env: "preview", git: { branch: `feat/${pr}`, sha: `${pr}`.padStart(40, "b"), short_sha: "bbbbbbb" }, pr: { number: pr }, scope: `pr-${pr}` });
const url = (pr: number) => `https://pr-${pr}.preview.example.com/auth/callback`;

interface Case {
  name: string;
  plan: (pr: number) => string;
  seed: Partial<SimSeed>;
  /** The list as the sim holds it now. */
  list: (sim: SimHandle) => string[];
  /** The request that writes the list. */
  write: RegExp;
  parent: string;
}

const REF = "demoprojectrefabcdef";

const cases: Case[] = [
  {
    name: "supabase.auth_redirect",
    plan: (pr) => `version: 1
providers:
  supabase: { project: ${REF} }
changes:
  - id: callback
    adapter: supabase
    op: auth_redirect
    url: ${url(pr)}
`,
    seed: { supabase: { projects: { [REF]: { uri_allow_list: "https://app.example.com/**" } } } } as unknown as Partial<SimSeed>,
    list: (sim) => (sim.state.supabase.projects[REF]!.auth.uri_allow_list ?? "").split(",").filter(Boolean),
    write: new RegExp(`^/supabase/projects/${REF}/config/auth$`),
    parent: `supabase:${REF}:auth-uri-allow-list`,
  },
  {
    name: "http.list_item",
    plan: (pr) => `version: 1
providers:
  http:
    app:
      base_url: https://api.example.test/v1
      base_url_env: REST_API_URL
      auth: { bearer_env: REST_API_TOKEN }
changes:
  - id: callback
    adapter: http
    op: list_item
    api: app
    parent: { path: "/apps/{app}" }
    vars: { app: demo }
    list_path: /callbacks
    item: ${url(pr)}
`,
    seed: { rest: { objects: { "/apps/demo": { name: "demo", callbacks: ["https://app.example.com/**"] } } } } as unknown as Partial<SimSeed>,
    list: (sim) => sim.state.rest.objects["/apps/demo"]!.callbacks as string[],
    write: /^\/rest\/apps\/demo$/,
    parent: "http:https://api.example.test/v1/apps/demo",
  },
];

describe.each(cases)("two pull requests writing one shared list ($name)", (c) => {
  it("concurrent applies and destroys never lose an entry, and each run writes the list once", async () => {
    const sim = await startSim({ seed: c.seed });
    const root = await tmp("shared-lists");
    const opts = (pr: number): RunOptions => ({
      plan: parsePlan(c.plan(pr)).plan,
      ctx: ctxFor(pr),
      registry: createRegistry(),
      store: new LocalReceiptStore(root),
      env: simEnv(sim),
      wait: true,
      pollIntervalMs: 10,
      waitTimeoutMs: 60_000,
    });
    const writes = () => sim.state.writes.filter((w) => w.method === "PATCH" && c.write.test(w.path) && !w.failed).length;
    try {
      // Every request takes 60 ms: both runs read the list before either writes it back, unless serialised.
      sim.state.applyChaos({ latency_ms: 60 });
      const applied = await Promise.all([101, 102].map((pr) => applyRun(opts(pr))));
      for (const r of applied) {
        expect(r.receipt.status, JSON.stringify(r.receipt.lines)).toBe("complete");
        expect(r.receipt.ledger.map((e) => e.parent)).toEqual([c.parent]);
      }
      expect(c.list(sim).sort()).toEqual(["https://app.example.com/**", url(101), url(102)].sort());
      expect(writes(), "a lost write would have been repaired by another round").toBe(2);

      // One closes while the other re-applies (unchanged: no lock, no write) and a third opens.
      const mixed = await Promise.all([destroyRun(opts(101)), applyRun(opts(102)), applyRun(opts(103))]);
      for (const r of mixed) expect(r.receipt.status, JSON.stringify(r.receipt.lines)).toBe("complete");
      expect(mixed[1]!.receipt.lines.callback!.status).toBe("unchanged");
      expect(c.list(sim).sort()).toEqual(["https://app.example.com/**", url(102), url(103)].sort());
      expect(writes()).toBe(4);
      expect(await new LocalReceiptStore(root).readParentLock(c.parent)).toBeNull();
    } finally {
      await sim.close();
    }
  }, 60_000);
});
