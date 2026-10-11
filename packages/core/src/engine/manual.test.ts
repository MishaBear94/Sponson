/**
 * Manual steps (ADR 0021) in the engine: a step a person does is a todo until confirmed (or seen by its verify
 * request), never rolled back, and undone on destroy only once confirmed.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, destroyRun, planRun, type RunOptions } from "./index.js";
import { sha256 } from "../hash.js";
import { parsePlan } from "../plan.js";
import { LocalReceiptStore } from "../receipts/local.js";
import { Registry } from "../registry.js";
import { markerKind } from "../resolve.js";
import { FakeCloud } from "../testing/fake.js";
import type { Ctx, OpSpec, ResourceAdapter } from "../types.js";

const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc1234def", short_sha: "abc1234" }, pr: { number: 42 }, scope: "pr-42" };

/** A minimal manual op: `title`, `text`, optional `undo`; observable when `seen` is set, done while `world.seen`. */
const world = { seen: false };
const stepOp: OpSpec = {
  outputs: {},
  manual(p) {
    if (markerKind(p.text) !== null) return null;
    const text = String(p.text);
    return { key: `step:${String(p.title)}`, title: String(p.title), instructions: text, ...(p.undo ? { undo: String(p.undo) } : {}), hash: sha256(text), observable: p.seen === true };
  },
  async read(_a, p) {
    return p.seen === true && world.seen ? { resources: [{ key: `step:${String(p.title)}`, id: "manual", hash: sha256(String(p.text)) }], outputs: {} } : null;
  },
  diff: () => [],
  async apply() {
    throw new Error("never called");
  },
  async destroy() {
    throw new Error("never called");
  },
};
const manual: ResourceAdapter = { name: "hand", ops: { step: stepOp } };

const PLAN = `
version: 1
changes:
  - id: a
    adapter: fake
    op: item
    name: alpha
    value: one
  - id: s
    adapter: hand
    op: step
    title: Register the callback
    text: { from: a.id }
    undo: Unregister it
  - id: b
    adapter: fake
    op: item
    name: beta
    value: two
    depends_on: [s]
  - id: c
    adapter: fake
    op: item
    name: gamma
    value: three
`;

let cloud: FakeCloud;
let store: LocalReceiptStore;

function opts(source = PLAN, extra: Partial<RunOptions> = {}): RunOptions {
  return { plan: parsePlan(source).plan, ctx, registry: new Registry().addAdapter(cloud.adapter()).addAdapter(manual), store, env: {}, ...extra };
}

beforeEach(async () => {
  cloud = new FakeCloud();
  world.seen = false;
  store = new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-manual-")));
});

describe("manual steps", () => {
  it("wait for a person: the step and its dependents wait, everything else is applied, nothing is rolled back", async () => {
    const plan = await planRun(opts());
    expect(Object.fromEntries(plan.lines.map((l) => [l.id, l.status]))).toEqual({ a: "create", s: "pending", b: "create", c: "create" });

    const r = await applyRun(opts());
    expect(r.receipt.status).toBe("partial");
    expect(r.receipt.lines.s).toMatchObject({ status: "waiting", waitingFor: "confirmation", errorCode: "MANUAL_STEP_PENDING" });
    expect(r.receipt.lines.b).toMatchObject({ status: "waiting", waitingFor: "confirmation" });
    expect(r.receipt.lines.c!.status).toBe("applied");
    expect(r.manual).toEqual([{ line: "s", title: "Register the callback", action: "do", instructions: cloud.items.get("alpha")!.id, observable: false }]);
    expect(cloud.items.has("alpha") && cloud.items.has("gamma") && !cloud.items.has("beta")).toBe(true);
    expect(r.receipt.ledger.some((e) => e.manual)).toBe(false);

    const again = await planRun(opts());
    expect(again.lines.find((l) => l.id === "s")).toMatchObject({ status: "todo", manual: { line: "s", action: "do", title: "Register the callback" } });
  });

  it("confirmed by a person: recorded with who and when, then unchanged; a confirmation with nothing to confirm is a warning", async () => {
    await applyRun(opts());
    const now = () => new Date("2026-10-11T10:00:00Z");
    const r = await applyRun(opts(PLAN, { confirm: ["s"], confirmedBy: " alice ", now }));
    expect(r.receipt.status).toBe("complete");
    expect(r.manual).toBeUndefined();
    expect(r.receipt.lines.s).toMatchObject({ status: "applied", notes: { manual: { confirmedBy: "alice", confirmedAt: "2026-10-11T10:00:00.000Z" } } });
    expect(r.receipt.ledger.find((e) => e.line === "s")).toMatchObject({ createdBy: "sponson", manual: { title: "Register the callback", undo: "Unregister it", how: "confirmed", by: "alice", at: "2026-10-11T10:00:00.000Z" } });
    expect(r.receipt.lines.b!.status).toBe("applied");

    const later = await applyRun(opts(PLAN, { confirm: ["s"], confirmedBy: "bob" }));
    expect(later.receipt.lines.s!.status).toBe("unchanged");
    expect(later.receipt.ledger.find((e) => e.line === "s")!.manual!.by).toBe("alice");
    expect(later.warnings.join("\n")).toMatch(/Not confirmed: `s` \(done already/);
    expect((await planRun(opts())).lines.find((l) => l.id === "s")!.status).toBe("unchanged");
  });

  it("is never rolled back: a person did it, so a later failure in the same run leaves it recorded", async () => {
    await applyRun(opts());
    cloud.failNext("create", "beta");
    const r = await applyRun(opts(PLAN, { confirm: ["s"], confirmedBy: "alice" }));
    expect(r.receipt.status).toBe("failed");
    expect(r.receipt.lines.b!.status).toBe("failed");
    expect(r.receipt.lines.s!.status).toBe("applied");
    expect(r.receipt.ledger.find((e) => e.line === "s")?.manual?.how).toBe("confirmed");
  });

  it("refuses confirmations it cannot record, and recreating a step, before anything runs", async () => {
    await expect(applyRun(opts(PLAN, { confirm: ["s"] }))).rejects.toMatchObject({ code: "USAGE", message: expect.stringMatching(/needs the name of the person/) });
    await expect(applyRun(opts(PLAN, { confirm: ["a"], confirmedBy: "alice" }))).rejects.toMatchObject({ code: "USAGE", message: expect.stringMatching(/only manual steps can be confirmed. Manual steps here: s/) });
    await expect(applyRun(opts(PLAN, { recreate: ["s"] }))).rejects.toMatchObject({ code: "USAGE", message: expect.stringMatching(/a manual step is done by a person/) });
    expect(cloud.writes).toHaveLength(0);
  });

  it("destroy asks for the undo, keeps the record until it is confirmed, and forgets a step without undo", async () => {
    await applyRun(opts(PLAN, { confirm: [] }));
    await applyRun(opts(PLAN, { confirm: ["s"], confirmedBy: "alice" }));
    await expect(destroyRun(opts(PLAN, { confirm: ["s"] }))).rejects.toMatchObject({ code: "USAGE" });
    await expect(destroyRun(opts(PLAN, { confirm: ["a"], confirmedBy: "alice" }))).rejects.toMatchObject({ code: "USAGE" });

    const first = await destroyRun(opts());
    expect(first.receipt.status).toBe("partial");
    expect(first.receipt.lines.s).toMatchObject({ status: "waiting", errorCode: "MANUAL_STEP_PENDING" });
    expect(first.manual).toEqual([{ line: "s", title: "Register the callback", action: "undo", instructions: "Unregister it", observable: false }]);
    expect(cloud.items.size).toBe(0);
    expect(first.receipt.ledger.map((e) => e.line)).toEqual(["s"]);

    // The line is gone from the plan: the undo is still asked for, from the ledger.
    const without = PLAN.replace(/  - id: s[\s\S]*?undo: Unregister it\n/, "").replace("    depends_on: [s]\n", "");
    const second = await destroyRun(opts(without, { confirm: ["s"], confirmedBy: "bob" }));
    expect(second.receipt.status).toBe("complete");
    expect(second.receipt.lines.s).toMatchObject({ status: "destroyed", notes: { manual: { undoneBy: "bob" } } });
    expect(second.receipt.ledger).toEqual([]);

    const noUndo = PLAN.replace("    undo: Unregister it\n", "");
    await applyRun(opts(noUndo, { confirm: ["s"], confirmedBy: "alice" }));
    const third = await destroyRun(opts(noUndo));
    expect(third.receipt.status).toBe("complete");
    expect(third.receipt.lines.s).toMatchObject({ status: "destroyed", notes: { manual: { nothingToUndo: true } } });
  });

  it("an observable step is done once its read sees it, and missing drift (a todo again) when it no longer does", async () => {
    const seen = PLAN.replace("    undo: Unregister it\n", "    seen: true\n");
    world.seen = true;
    const r = await applyRun(opts(seen));
    expect(r.receipt.status).toBe("complete");
    expect(r.receipt.lines.s).toMatchObject({ status: "applied", notes: { manual: { verifiedAt: expect.any(String) } } });
    expect(r.receipt.ledger.find((e) => e.line === "s")!.manual).toMatchObject({ how: "verified" });
    expect((await applyRun(opts(seen))).receipt.lines.s!.status).toBe("unchanged");

    world.seen = false;
    const plan = await planRun(opts(seen));
    expect(plan.drift).toEqual([expect.objectContaining({ kind: "missing", line: "s" })]);
    expect(plan.lines.find((l) => l.id === "s")).toMatchObject({ status: "todo", manual: { observable: true } });
    const waiting = await applyRun(opts(seen));
    expect(waiting.receipt.lines.s!.status).toBe("waiting");
    // A person confirms it although the verify request does not see it (it lags): their word counts.
    const confirmed = await applyRun(opts(seen, { confirm: ["s"], confirmedBy: "alice" }));
    expect(confirmed.receipt.lines.s!.status).toBe("applied");
    expect((await planRun(opts(seen))).lines.find((l) => l.id === "s")!.status).toBe("unchanged");
  });
});
