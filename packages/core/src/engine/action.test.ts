/**
 * One-off actions (ADR 0022) in the engine: sent when the trigger has not run in this scope, recorded only after it
 * was sent, never rolled back, undone (or forgotten) on destroy.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, destroyRun, planRun, type RunOptions } from "./index.js";
import { parsePlan } from "../plan.js";
import { LocalReceiptStore } from "../receipts/local.js";
import { Registry } from "../registry.js";
import { markerKind } from "../resolve.js";
import { FakeCloud } from "../testing/fake.js";
import type { Ctx, LiveState, OpSpec, ResourceAdapter } from "../types.js";

const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc1234def", short_sha: "abc1234" }, pr: { number: 42 }, scope: "pr-42" };

/** What the action op saw: every run (its params and the `live` the engine passed) and every undo. */
const world = { runs: [] as Array<{ params: Record<string, unknown>; live: LiveState | null }>, undone: [] as string[], fail: false };
const pingOp: OpSpec = {
  outputs: { receipt: { available: "immediate" } },
  action(p) {
    const trigger = p.trigger as Record<string, unknown>;
    return Object.values(trigger).some((v) => markerKind(v) !== null) ? null : { trigger, label: `ping ${String(p.target)}` };
  },
  async read() {
    throw new Error("never called for an action");
  },
  diff: () => [],
  async apply(_actx, params, live) {
    world.runs.push({ params, live });
    if (world.fail) throw new Error("the endpoint answered 500");
    return { resources: [{ key: "ignored", id: params.undo ? `UNDO ${String(params.undo)}` : "FORGET", hash: "" }], outputs: { receipt: `r${world.runs.length}` }, created: [] };
  },
  async destroy(_actx, resources) {
    for (const r of resources) if (r.id.startsWith("UNDO ")) world.undone.push(r.id.slice(5));
  },
};
const ping: ResourceAdapter = { name: "ping", ops: { send: pingOp } };

const plan = (trigger = "{ sha: v1, id: { from: a.id } }", extra = "    undo: unping\n") => `
version: 1
changes:
  - id: a
    adapter: fake
    op: item
    name: alpha
    value: one
  - id: p
    adapter: ping
    op: send
    target: https://app.example/api
    trigger: ${trigger}
${extra}  - id: b
    adapter: fake
    op: item
    name: beta
    value: { from: p.receipt }
`;

let cloud: FakeCloud;
let store: LocalReceiptStore;

function opts(source = plan(), extra: Partial<RunOptions> = {}): RunOptions {
  return { plan: parsePlan(source).plan, ctx, registry: new Registry().addAdapter(cloud.adapter()).addAdapter(ping), store, env: {}, ...extra };
}

const statuses = (lines: Array<{ id: string; status: string }>) => Object.fromEntries(lines.map((l) => [l.id, l.status]));

beforeEach(async () => {
  cloud = new FakeCloud();
  world.runs = [];
  world.undone = [];
  world.fail = false;
  store = new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-action-")));
});

describe("actions", () => {
  it("run once per trigger: pending until its trigger is known, then run, then unchanged with its recorded outputs", async () => {
    expect(statuses((await planRun(opts())).lines)).toEqual({ a: "create", p: "pending", b: "pending" });

    const first = await applyRun(opts());
    expect(first.receipt.status).toBe("complete");
    expect(first.receipt.lines.p).toMatchObject({ status: "applied", outputs: { receipt: "r1" }, notes: { action: { ranAt: expect.any(String) } } });
    expect(cloud.items.get("beta")!.value).toBe("r1");
    expect(world.runs).toHaveLength(1);
    // The engine hands the op the ledger key and the raw trigger hash (for an idempotency key), never an intent.
    expect(world.runs[0]!.live!.resources[0]).toMatchObject({ key: "action:p", id: "", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const entry = first.receipt.ledger.find((e) => e.line === "p")!;
    expect(entry).toMatchObject({ key: "action:p", id: "UNDO unping", createdBy: "sponson", action: { at: expect.any(String) }, outputs: { receipt: "r1" } });

    const planned = await planRun(opts());
    expect(statuses(planned.lines)).toEqual({ a: "unchanged", p: "unchanged", b: "unchanged" });
    expect(planned.drift).toEqual([]);
    const again = await applyRun(opts());
    expect(statuses(Object.values(again.receipt.lines))).toEqual({ a: "unchanged", p: "unchanged", b: "unchanged" });
    expect(world.runs).toHaveLength(1);
  });

  it("runs again when the trigger changes, with the same key and a new hash, and dependents get the new outputs", async () => {
    await applyRun(opts());
    const changed = plan("{ sha: v2, id: { from: a.id } }");
    const planned = await planRun(opts(changed));
    expect(planned.lines.find((l) => l.id === "p")).toMatchObject({ status: "run", diffs: [{ key: "action:p", kind: "run", before: { state: "literal" }, after: { state: "literal", value: expect.stringContaining('"sha":"v2"') } }] });
    const r = await applyRun(opts(changed));
    expect(world.runs).toHaveLength(2);
    expect(world.runs[1]!.live!.resources[0]!.id).toBe("UNDO unping");
    expect(world.runs[1]!.live!.resources[0]!.hash).not.toBe(world.runs[0]!.live!.resources[0]!.hash);
    expect(r.receipt.lines.p!.status).toBe("applied");
    expect(cloud.items.get("beta")!.value).toBe("r2");
    expect(r.receipt.ledger.filter((e) => e.line === "p")).toHaveLength(1);
  });

  it("recreate runs an unchanged action again", async () => {
    await applyRun(opts());
    expect((await planRun(opts(plan(), { recreate: ["p"] }))).lines.find((l) => l.id === "p")!.status).toBe("run");
    await applyRun(opts(plan(), { recreate: ["p"] }));
    expect(world.runs).toHaveLength(2);
    expect(world.undone).toEqual([]);
  });

  it("is recorded only once sent: a failed run records nothing and is sent again next time (at least once)", async () => {
    world.fail = true;
    const r = await applyRun(opts());
    expect(r.receipt.status).toBe("failed");
    expect(r.receipt.lines.p!.status).toBe("failed");
    expect(r.receipt.ledger.some((e) => e.line === "p")).toBe(false);
    // `a` was created by this run and rolled back; nothing of the action was.
    expect(cloud.items.has("alpha")).toBe(false);
    world.fail = false;
    expect((await applyRun(opts())).receipt.status).toBe("complete");
    expect(world.runs).toHaveLength(2);
  });

  it("is never rolled back when a later line fails", async () => {
    cloud.failNext("create", "beta");
    const r = await applyRun(opts());
    expect(r.receipt.lines.a!.status).toBe("rolled_back");
    expect(r.receipt.status).toBe("failed");
    expect(r.receipt.lines.p!.status).toBe("applied");
    expect(r.receipt.ledger.find((e) => e.line === "p")).toMatchObject({ key: "action:p", createdBy: "sponson" });
    expect(world.undone).toEqual([]);
    // `a` was rolled back, so the next apply creates it with a new id: a new trigger, which runs again.
    expect((await applyRun(opts())).receipt.status).toBe("complete");
    expect(world.runs).toHaveLength(2);
    expect(world.runs[1]!.live!.resources[0]!.id).toBe("UNDO unping");
  });

  it("destroy sends the undo, or only forgets an action without one, even once the line is gone from the plan", async () => {
    await applyRun(opts());
    const without = plan().replace(/  - id: p[\s\S]*?undo: unping\n/, "").replace("{ from: p.receipt }", "fixed");
    await applyRun(opts(without));
    const d = await destroyRun(opts(without));
    expect(d.receipt.status).toBe("complete");
    expect(d.receipt.lines.p!.status).toBe("destroyed");
    expect(world.undone).toEqual(["unping"]);
    expect(d.receipt.ledger).toEqual([]);

    const noUndo = plan(undefined, "");
    await applyRun(opts(noUndo));
    const d2 = await destroyRun(opts(noUndo));
    expect(d2.receipt.ledger).toEqual([]);
    expect(world.undone).toEqual(["unping"]);
  });
});
