import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, destroyRun, planRun, type RunOptions } from "./index.js";
import { parsePlan } from "../plan.js";
import { Redactor } from "../redact.js";
import { LocalReceiptStore } from "../receipts/local.js";
import { Registry } from "../registry.js";
import { FakeCloud } from "../testing/fake.js";
import type { Ctx } from "../types.js";

// ADR 0018: the fake item's `token` is revealed only by the create. Later runs keep a dependent's value only when the
// ledger's fingerprints prove it is the current one; everything else is refused, or recreated on request.

const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc1234def", short_sha: "abc1234" }, pr: { number: 42 }, scope: "pr-42" };

const PLAN = `
version: 1
changes:
  - id: pw
    adapter: fake
    op: item
    name: pw
    value: one
  - id: env
    adapter: fake
    op: item
    name: env
    value: { from: pw.token }
`;

const SECOND = `
  - id: env2
    adapter: fake
    op: item
    name: env2
    value: { from: pw.token }
`;

let cloud: FakeCloud;
let root: string;
let store: LocalReceiptStore;
let registry: Registry;
let redactor: Redactor;

function opts(source = PLAN, extra: Partial<RunOptions> = {}): RunOptions {
  return { plan: parsePlan(source).plan, ctx, registry, store, env: {}, redactor, ...extra };
}

/** Every receipt file the store holds (invariant I1: no token in any of them). */
async function allReceipts(): Promise<string> {
  const dir = join(root, "preview", "pr-42");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
}

const tokenOf = (name: string) => `t-${cloud.items.get(name)!.id}-${name}`;

beforeEach(async () => {
  cloud = new FakeCloud();
  registry = new Registry().addAdapter(cloud.adapter());
  root = await mkdtemp(join(tmpdir(), "sponson-once-"));
  store = new LocalReceiptStore(root);
  redactor = new Redactor();
});

describe("once-only outputs: fingerprints decide what later runs may keep", () => {
  it("records keyed fingerprints on the producer and the dependent, never the value", async () => {
    const { receipt } = await applyRun(opts());
    const token = tokenOf("pw");
    expect(cloud.items.get("env")?.value).toBe(token);
    const pw = receipt.ledger.find((e) => e.line === "pw")!;
    const env = receipt.ledger.find((e) => e.line === "env")!;
    expect(pw.onceFingerprints?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(env.onceInputs?.["pw.token"]).toBe(pw.onceFingerprints?.token);
    expect(await allReceipts()).not.toContain(token);
    // Kept through runs that never see the value, so every later run can still vouch for it.
    const again = await applyRun(opts());
    expect(Object.values(again.receipt.lines).map((l) => l.status)).toEqual(["unchanged", "unchanged"]);
    expect(again.receipt.ledger.find((e) => e.line === "env")!.onceInputs).toEqual(env.onceInputs);
    expect(again.receipt.ledger.find((e) => e.line === "pw")!.onceFingerprints).toEqual(pw.onceFingerprints);
  });

  it("refuses a dependent added after the producer was created", async () => {
    await applyRun(opts());
    const writes = cloud.writes.length;
    const p = await planRun(opts(PLAN + SECOND));
    expect(p.lines[2]).toMatchObject({ status: "blocked", errorCode: "OUTPUT_UNAVAILABLE" });
    const { receipt } = await applyRun(opts(PLAN + SECOND));
    expect(receipt.lines.env!.status).toBe("unchanged");
    expect(receipt.lines.env2).toMatchObject({ status: "blocked", errorCode: "OUTPUT_UNAVAILABLE" });
    expect(receipt.lines.env2!.error).toMatch(/not written with the current value.*recreate/);
    expect(cloud.writes.length).toBe(writes);
  });

  it("refuses a dependent edited outside Sponson instead of keeping the edit, even when reconciling", async () => {
    await applyRun(opts());
    cloud.drift("env", "pasted-by-hand");
    const { receipt } = await applyRun(opts(PLAN, { reconcile: true }));
    expect(receipt.lines.env).toMatchObject({ status: "blocked", errorCode: "OUTPUT_UNAVAILABLE" });
    expect(receipt.lines.env!.error).toMatch(/changed outside Sponson/);
    expect(cloud.items.get("env")?.value).toBe("pasted-by-hand");
  });

  it("an adopted producer gave nobody its value: a dependent that exists is still refused", async () => {
    cloud.seed("pw", "one");
    cloud.seed("env", "whatever-was-there");
    const { receipt } = await applyRun(opts());
    expect(receipt.lines.pw!.status).toBe("unchanged");
    expect(receipt.lines.env).toMatchObject({ status: "blocked", errorCode: "OUTPUT_UNAVAILABLE" });
  });

  it("recreate deletes and recreates the producer; the new value reaches every dependent in that run", async () => {
    await applyRun(opts());
    const old = { id: cloud.items.get("pw")!.id, token: tokenOf("pw") };
    const { receipt, drift } = await applyRun(opts(PLAN + SECOND, { recreate: ["pw"] }));
    expect(receipt.status).toBe("complete");
    expect(cloud.items.get("pw")!.id).not.toBe(old.id);
    expect(cloud.items.get("env")?.value).toBe(tokenOf("pw"));
    expect(cloud.items.get("env2")?.value).toBe(tokenOf("pw"));
    expect(receipt.lines.pw).toMatchObject({ status: "applied", notes: { recreated: true } });
    expect(receipt.lines.pw!.resources[0]).toMatchObject({ createdBy: "sponson" });
    expect(drift.filter((d) => d.kind === "missing")).toEqual([]);
    const text = await allReceipts();
    expect(text).not.toContain(tokenOf("pw"));
    expect(text).not.toContain(old.token);
    expect((await applyRun(opts(PLAN + SECOND))).receipt.status).toBe("complete");
    await destroyRun(opts(PLAN + SECOND));
    expect(cloud.items.size).toBe(0);
  });

  it("a recreated producer replaces one that existed: a later failure does not roll it back (I2)", async () => {
    await applyRun(opts());
    cloud.failNext("apply", "env2");
    const { receipt } = await applyRun(opts(PLAN + SECOND, { recreate: ["pw"] }));
    expect(receipt.status).toBe("failed");
    expect(receipt.lines.env2!.status).toBe("failed");
    expect(cloud.items.has("pw")).toBe(true);
    expect(receipt.ledger.find((e) => e.line === "pw")?.createdBy).toBe("sponson");
  });

  it("recreate never deletes what Sponson did not create, and names only lines of the plan", async () => {
    cloud.seed("pw", "one");
    const { receipt } = await applyRun(opts(PLAN, { recreate: ["pw"] }));
    expect(receipt.lines.pw).toMatchObject({ status: "failed", errorCode: "USAGE" });
    expect(cloud.items.get("pw")?.createdBy).toBe("seed");
    await expect(applyRun(opts(PLAN, { recreate: ["nope"] }))).rejects.toMatchObject({ code: "USAGE" });
  });

  it("plan with recreate shows the producer created and its dependents pending", async () => {
    await applyRun(opts());
    const p = await planRun(opts(PLAN, { recreate: ["pw"] }));
    expect(p.lines.map((l) => l.status)).toEqual(["create", "pending"]);
  });
});
