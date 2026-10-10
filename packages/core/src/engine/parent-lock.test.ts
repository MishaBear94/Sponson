import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, destroyRun, planRun, type RunOptions } from "./index.js";
import { parsePlan } from "../plan.js";
import { Redactor } from "../redact.js";
import { LocalReceiptStore } from "../receipts/local.js";
import { Registry } from "../registry.js";
import { FakeCloud, fakeSecretSource } from "../testing/fake.js";
import type { Ctx, ReceiptStore } from "../types.js";

// ADR 0019: a line whose resources live in a shared parent object writes it holding that object's lease.

const ctxFor = (pr: number, env = "preview"): Ctx => ({ env, git: { branch: `feat/${pr}`, sha: "abc1234def", short_sha: "abc1234" }, pr: { number: pr }, scope: `pr-${pr}` });
const PARENT = "fake:list:callbacks";

const plan = (value: string, list = "callbacks") => `
version: 1
environments: [preview, staging]
changes:
  - id: callback
    adapter: fake
    op: member
    list: ${list}
    value: ${value}
`;

let cloud: FakeCloud;
let store: LocalReceiptStore;
let registry: Registry;

function opts(source: string, pr = 1, extra: Partial<RunOptions> = {}): RunOptions {
  return { plan: parsePlan(source).plan, ctx: ctxFor(pr), registry, store, env: {}, pollIntervalMs: 10, ...extra };
}

beforeEach(async () => {
  cloud = new FakeCloud();
  registry = new Registry().addAdapter(cloud.adapter()).addSecretSource(fakeSecretSource({ TOKEN: "hunter2-secret" }));
  store = new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-parent-")));
});

describe("parent-object locks", () => {
  it("records the parent in the ledger and releases its lock after the line", async () => {
    const { receipt } = await applyRun(opts(plan("https://pr-1.example.test")));
    expect(receipt.status).toBe("complete");
    expect(cloud.lists.get("callbacks")).toEqual(["https://pr-1.example.test"]);
    expect(receipt.ledger[0]).toMatchObject({ line: "callback", parent: PARENT, createdBy: "sponson" });
    expect(await store.readParentLock(PARENT)).toBeNull();
  });

  it("a held parent lock refuses the line with LOCK_HELD and writes nothing; with wait it proceeds once released", async () => {
    await store.acquireParentLock(PARENT, "other-run", 60_000);
    const { receipt } = await applyRun(opts(plan("a")));
    expect(receipt.lines.callback).toMatchObject({ status: "failed", errorCode: "LOCK_HELD" });
    expect(receipt.lines.callback!.error).toContain(`parent object ${PARENT}`);
    expect(cloud.writes).toEqual([]);

    setTimeout(() => void store.releaseParentLock(PARENT, "other-run"), 100);
    const waited = await applyRun(opts(plan("a"), 1, { wait: true }));
    expect(waited.receipt.status).toBe("complete");
    expect(cloud.lists.get("callbacks")).toEqual(["a"]);
  });

  it("locks across environments too: the lock is per object, not per scope", async () => {
    await applyRun(opts(plan("a"), 1, { ctx: ctxFor(1, "staging") }));
    await store.acquireParentLock(PARENT, "staging-run", 60_000);
    const { receipt } = await applyRun(opts(plan("b"), 2));
    expect(receipt.lines.callback!.errorCode).toBe("LOCK_HELD");
  });

  it("an unchanged line takes no lock", async () => {
    await applyRun(opts(plan("a")));
    await store.acquireParentLock(PARENT, "other-run", 60_000);
    const { receipt } = await applyRun(opts(plan("a")));
    expect(receipt.lines.callback!.status).toBe("unchanged");
  });

  it("releases the lock when the write fails, and rollback takes it to undo a create", async () => {
    cloud.failNext("create", "a");
    await applyRun(opts(plan("a")));
    expect(await store.readParentLock(PARENT)).toBeNull();

    const two = `${plan("a")}  - id: after
    adapter: fake
    op: item
    name: after
    value: x
`;
    cloud.failNext("apply", "after");
    const { receipt } = await applyRun(opts(two));
    expect(receipt.lines.callback!.status).toBe("rolled_back");
    expect(cloud.lists.get("callbacks")).toEqual([]);
    expect(await store.readParentLock(PARENT)).toBeNull();
  });

  it("destroy locks the parent recorded in the ledger, even for a line the plan no longer has", async () => {
    await applyRun(opts(plan("a")));
    const other = plan("x", "unrelated").replace("id: callback", "id: elsewhere");
    await store.acquireParentLock(PARENT, "other-run", 60_000);
    const blocked = await destroyRun(opts(other));
    expect(blocked.receipt.lines.callback).toMatchObject({ status: "destroy_failed", errorCode: "LOCK_HELD" });
    expect(cloud.lists.get("callbacks")).toEqual(["a"]);

    await store.releaseParentLock(PARENT, "other-run");
    const done = await destroyRun(opts(other));
    expect(done.receipt.status).toBe("complete");
    expect(cloud.lists.get("callbacks")).toEqual([]);
  });

  it("a lock that cannot be released is reported, never silently left behind", async () => {
    const failing: ReceiptStore = Object.assign(Object.create(store) as LocalReceiptStore, {
      releaseParentLock: async () => {
        throw new Error("remote unavailable");
      },
    });
    const { receipt, warnings } = await applyRun({ ...opts(plan("a")), store: failing });
    expect(receipt.status).toBe("complete");
    expect(warnings.join("\n")).toMatch(/Could not release the lock for parent object fake:list:callbacks .*remote unavailable/);
  }, 10_000);

  it("a store without parent-lock methods gets them from its scope lock under the reserved environment", async () => {
    const plain: ReceiptStore = {
      kind: "plain",
      read: (e, s) => store.read(e, s),
      write: (r, o) => store.write(r, o),
      list: (e) => store.list(e),
      acquireLock: (e, s, h, t) => store.acquireLock(e, s, h, t),
      renewLock: (e, s, h, t) => store.renewLock(e, s, h, t),
      readLock: (e, s) => store.readLock(e, s),
      releaseLock: (e, s, h) => store.releaseLock(e, s, h),
    };
    await store.acquireParentLock(PARENT, "other-run", 60_000); // the same lock, through the store's own method
    const { receipt } = await applyRun({ ...opts(plan("a")), store: plain });
    expect(receipt.lines.callback!.errorCode).toBe("LOCK_HELD");
  });

  it("refuses an identity that carries a secret: it would be written to receipts", async () => {
    const redactor = new Redactor();
    const source = plan("a").replace("list: callbacks", 'list: { secret: "fake://TOKEN" }');
    const { receipt } = await applyRun({ ...opts(source), redactor });
    expect(receipt.lines.callback).toMatchObject({ status: "failed", errorCode: "INTERNAL" });
    expect(JSON.stringify(receipt)).not.toContain("hunter2-secret");
    expect(cloud.writes).toEqual([]);
  });

  it("plan takes no lock and writes nothing", async () => {
    await store.acquireParentLock(PARENT, "other-run", 60_000);
    const r = await planRun(opts(plan("a")));
    expect(r.lines[0]!.status).toBe("create");
    expect(cloud.writes).toEqual([]);
  });
});
