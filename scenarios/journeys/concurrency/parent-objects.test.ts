/**
 * Several pull requests read-modify-write one list on one shared provider object (an Auth0 application's callback
 * URLs, Supabase's `uri_allow_list`) at the same time. Scope locks cannot serialise them: every scope has its own.
 * The parent-object lock (ADR 0019) does, through the same receipts store, so no item is ever lost, in either store.
 * The control case turns the lock off and shows the lost update the lock prevents.
 */
import { describe, expect, it } from "vitest";
import { applyRun, destroyRun, GitBranchReceiptStore, LocalReceiptStore, parsePlan, Registry, type Ctx, type ReceiptStore, type RunOptions } from "@sponson/core";
// The fixtures are published as `@sponson/core/testing`; the root alias maps only the package root, so import the source.
import { FakeCloud } from "../../../packages/core/src/testing/fake.js";
import { bareRemote, tmp } from "./helpers.js";

const planFor = (pr: number) => `version: 1
changes:
  - id: callback
    adapter: fake
    op: member
    list: auth0-app-callbacks
    value: https://pr-${pr}.preview.example.test/callback
`;

const ctxFor = (pr: number): Ctx => ({ env: "preview", git: { branch: `feat/${pr}`, sha: `${pr}`.padStart(40, "a"), short_sha: "aaaaaaa" }, pr: { number: pr }, scope: `pr-${pr}` });

function runOpts(cloud: FakeCloud, store: ReceiptStore, pr: number): RunOptions {
  return {
    plan: parsePlan(planFor(pr)).plan,
    ctx: ctxFor(pr),
    registry: new Registry().addAdapter(cloud.adapter()),
    store,
    env: {},
    wait: true,
    pollIntervalMs: 15,
    waitTimeoutMs: 60_000,
  };
}

const urls = (prs: number[]) => prs.map((pr) => `https://pr-${pr}.preview.example.test/callback`).sort();

type Stores = [string, () => Promise<() => ReceiptStore>, number];
const stores: Stores[] = [
  ["local", async () => { const root = await tmp("parent-local"); return () => new LocalReceiptStore(root); }, 6],
  ["git-branch", async () => {
    const remote = await bareRemote();
    const kept = await tmp("parent-kept");
    return () => new GitBranchReceiptStore({ remote, budgetMs: 120_000, fallbackDir: kept });
  }, 3],
];

describe.each(stores)("pull requests writing one shared list (%s store)", (_name, backend, n) => {
  it("concurrent applies and destroys never lose an item", async () => {
    const cloud = new FakeCloud();
    cloud.listLatencyMs = 40; // read, pause, write back: wide enough that unserialised writers collide
    const actor = await backend();
    const prs = Array.from({ length: n }, (_, i) => 101 + i);
    const open = async (pr: number) => {
      const store = actor();
      try {
        return await applyRun(runOpts(cloud, store, pr));
      } finally {
        await store.close?.();
      }
    };
    const close = async (pr: number) => {
      const store = actor();
      try {
        return await destroyRun(runOpts(cloud, store, pr));
      } finally {
        await store.close?.();
      }
    };

    const applied = await Promise.all(prs.map(open));
    for (const r of applied) expect(r.receipt.status).toBe("complete");
    expect([...(cloud.lists.get("auth0-app-callbacks") ?? [])].sort()).toEqual(urls(prs));

    // Half the pull requests close while the other half re-apply (unchanged) and two new ones open.
    const closing = prs.slice(0, Math.ceil(n / 2));
    const staying = prs.slice(closing.length);
    const opening = [201, 202];
    const mixed = await Promise.all([...closing.map(close), ...staying.map(open), ...opening.map(open)]);
    for (const r of mixed) expect(r.receipt.status).toBe("complete");
    expect([...(cloud.lists.get("auth0-app-callbacks") ?? [])].sort()).toEqual(urls([...staying, ...opening]));

    // No parent lock is left behind.
    const store = actor();
    expect(await store.readParentLock!("fake:list:auth0-app-callbacks")).toBeNull();
    await store.close?.();
  }, 180_000);
});

describe("the control case", () => {
  it("without the parent lock, the same concurrent applies lose items (the bug ADR 0019 fixes)", async () => {
    const cloud = new FakeCloud();
    cloud.lockLists = false;
    cloud.listLatencyMs = 300;
    const root = await tmp("parent-control");
    const prs = [301, 302, 303, 304];
    const results = await Promise.all(prs.map((pr) => applyRun(runOpts(cloud, new LocalReceiptStore(root), pr))));
    // Every run believes it succeeded...
    for (const r of results) expect(r.receipt.status).toBe("complete");
    // ...but the last writer's list overwrote the others'.
    expect((cloud.lists.get("auth0-app-callbacks") ?? []).length).toBeLessThan(prs.length);
  }, 60_000);
});
