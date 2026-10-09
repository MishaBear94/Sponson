import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, destroyRun, planRun, type RunOptions } from "./engine.js";
import { SponsonError } from "./errors.js";
import { parsePlan } from "./plan.js";
import { Redactor } from "./redact.js";
import { LocalReceiptStore } from "./receipts/local.js";
import { Registry } from "./registry.js";
import { FakeCloud, fakeSecretSource } from "./testing/fake.js";
import type { Ctx } from "./types.js";

const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc1234def", short_sha: "abc1234" }, pr: { number: 42 }, scope: "pr-42" };

const PLAN = `
version: 1
changes:
  - id: a
    adapter: fake
    op: item
    name: alpha
    value: one
  - id: b
    adapter: fake
    op: item
    name: beta
    value: { from: a.id }
  - id: c
    adapter: fake
    op: item
    name: gamma
    value: { from: b.id }
`;

let cloud: FakeCloud;
let store: LocalReceiptStore;
let registry: Registry;

function opts(source = PLAN, extra: Partial<RunOptions> = {}): RunOptions {
  return { plan: parsePlan(source).plan, ctx, registry, store, env: {}, ...extra };
}

beforeEach(async () => {
  cloud = new FakeCloud();
  registry = new Registry().addAdapter(cloud.adapter()).addSecretSource(fakeSecretSource({ TOKEN: "hunter2-secret" }));
  store = new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-receipts-")));
});

describe("plan", () => {
  it("is read-only and shows create for every missing line", async () => {
    const r = await planRun(opts());
    expect(r.lines.map((l) => l.status)).toEqual(["create", "pending", "pending"]);
    expect(r.lines[1]!.waitingOn).toBe("a");
    expect(cloud.writes).toHaveLength(0);
  });

  it("shows resolved references once the dependency exists", async () => {
    cloud.seed("alpha", "one");
    const r = await planRun(opts());
    expect(r.lines[1]!.status).toBe("create");
    expect(r.lines[1]!.inputs["value"]).toMatchObject({ state: "resolved", value: "it_1", ref: "a.id" });
    expect(r.lines[2]!.status).toBe("pending");
  });

  it("never shows a sensitive output value", async () => {
    cloud.seed("alpha", "one");
    const r = await planRun(opts(PLAN.replace("{ from: a.id }", "{ from: a.secret }")));
    expect(r.lines[1]!.inputs["value"]).toMatchObject({ state: "resolved", value: null, sensitive: true });
    expect(JSON.stringify(r)).not.toContain("s-alpha-one");
    expect(r.lines[0]!.outputs["secret"]).toBe("(secret)");
  });

  it("blocks dependents of a line that cannot be read", async () => {
    cloud.failNext("read", "alpha");
    const r = await planRun(opts());
    expect(r.lines.map((l) => l.status)).toEqual(["error", "blocked", "blocked"]);
  });
});

describe("apply", () => {
  it("applies in order, passes outputs through references, writes a complete receipt", async () => {
    const { receipt } = await applyRun(opts());
    expect(receipt.status).toBe("complete");
    expect(Object.values(receipt.lines).map((l) => l.status)).toEqual(["applied", "applied", "applied"]);
    expect(cloud.items.get("beta")!.value).toBe(cloud.items.get("alpha")!.id);
    expect(receipt.lines["a"]!.createdBy).toBe("sponson");
    expect(receipt.lines["a"]!.outputs).toEqual({ id: "it_1" });
    expect(await store.read("preview", "pr-42")).toMatchObject({ runId: receipt.runId });
  });

  it("is idempotent: a second apply performs zero writes", async () => {
    await applyRun(opts());
    const before = cloud.writes.length;
    const { receipt } = await applyRun(opts());
    expect(cloud.writes.length).toBe(before);
    expect(Object.values(receipt.lines).every((l) => l.status === "unchanged")).toBe(true);
    expect(receipt.lines["a"]!.createdBy).toBe("sponson");
  });

  it("rolls back what this run created when a later line fails", async () => {
    cloud.failNext("apply", "gamma");
    const { receipt } = await applyRun(opts());
    expect(receipt.status).toBe("failed");
    expect(receipt.lines["a"]!.status).toBe("rolled_back");
    expect(receipt.lines["b"]!.status).toBe("rolled_back");
    expect(receipt.lines["c"]!.status).toBe("failed");
    expect(cloud.items.size).toBe(0);
  });

  it("does not roll back resources that existed before this run", async () => {
    await applyRun(opts(PLAN.split("  - id: c")[0]));
    cloud.failNext("apply", "gamma");
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["a"]!.status).toBe("unchanged");
    expect(cloud.items.has("alpha")).toBe(true);
    expect(receipt.status).toBe("failed");
  });

  it("records rollback_failed with the leftover resource instead of hiding it", async () => {
    cloud.failNext("apply", "gamma");
    cloud.failNext("destroy", "alpha");
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["a"]!.status).toBe("rollback_failed");
    expect(receipt.lines["a"]!.error).toContain("alpha");
    expect(receipt.lines["b"]!.status).toBe("rolled_back");
    expect(cloud.items.has("alpha")).toBe(true);
  });

  it("skips lines that depend on a failed line", async () => {
    cloud.failNext("apply", "beta");
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["c"]!.status).toBe("skipped");
    expect(receipt.lines["c"]!.error).toContain("b");
  });

  it("resumes after a crash: lines applied before the crash are unchanged, the rest are applied", async () => {
    await expect(
      applyRun(
        opts(PLAN, {
          onLineDone: (id) => {
            if (id === "b") throw new Error("SIGKILL");
          },
        }),
      ),
    ).rejects.toThrow("SIGKILL");
    expect(await store.read("preview", "pr-42")).toBeNull(); // no half-written receipt
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["a"]!.status).toBe("unchanged");
    expect(receipt.lines["b"]!.status).toBe("unchanged");
    expect(receipt.lines["c"]!.status).toBe("applied");
    // adopted vs ours: the crash lost the receipt, so pre-crash items are adopted and will not be destroyed
    expect(receipt.lines["a"]!.createdBy).toBe("adopted");
  });
});

describe("external outputs", () => {
  const EXT = `
version: 1
changes:
  - id: site
    adapter: fake
    op: item
    name: site
    value: v1
  - id: cb
    adapter: fake
    op: item
    name: callback
    value: { from: site.url }
`;

  it("stops with partial when the deploy has not happened and resumes once it has", async () => {
    cloud.external = "never";
    const first = await applyRun(opts(EXT));
    expect(first.receipt.status).toBe("partial");
    expect(first.receipt.lines["site"]!.status).toBe("applied");
    expect(first.receipt.lines["cb"]).toMatchObject({ status: "waiting", waitingFor: "deploy" });

    cloud.external = "ok";
    const second = await applyRun(opts(EXT));
    expect(second.receipt.status).toBe("complete");
    expect(second.receipt.lines["site"]!.status).toBe("unchanged");
    expect(cloud.items.get("callback")!.value).toBe("https://site.example.test");
  });

  it("skips dependents when the deploy failed, and the run is failed, not waiting forever", async () => {
    cloud.external = "fail";
    const { receipt } = await applyRun(opts(EXT));
    expect(receipt.lines["cb"]!.status).toBe("skipped");
    expect(receipt.lines["cb"]!.error).toContain("deploy failed");
    expect(receipt.lines["site"]!.status).toBe("applied"); // nothing to roll back: the deploy failed, not us
    expect(receipt.status).toBe("failed"); // but the plan was not realized
  });

  it("with --wait, times out instead of hanging", async () => {
    cloud.external = "never";
    await expect(applyRun(opts(EXT, { wait: true, waitTimeoutMs: 50, pollIntervalMs: 10 }))).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
  });

  it("plan shows the url once the deploy exists", async () => {
    cloud.seed("site", "v1");
    const r = await planRun(opts(EXT));
    expect(r.lines[1]!.inputs["value"]).toMatchObject({ state: "resolved", value: "https://site.example.test" });
  });
});

describe("drift", () => {
  it("refuses to overwrite a value changed outside Sponson unless reconcile", async () => {
    await applyRun(opts());
    cloud.drift("alpha", "edited-in-console");
    const plan = await planRun(opts());
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "changed", line: "a" }));

    const { receipt } = await applyRun(opts());
    expect(receipt.status).toBe("failed");
    expect(receipt.lines["a"]!.error).toContain("--reconcile");
    expect(cloud.items.get("alpha")!.value).toBe("edited-in-console");

    const fixed = await applyRun(opts(PLAN, { reconcile: true }));
    expect(fixed.receipt.status).toBe("complete");
    expect(fixed.receipt.lines["a"]!.notes).toMatchObject({ reconciled: true });
    expect(cloud.items.get("alpha")!.value).toBe("one");
  });

  it("recreates a resource that went missing", async () => {
    await applyRun(opts());
    cloud.delete("alpha");
    const plan = await planRun(opts());
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "missing", line: "a" }));
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["a"]!.status).toBe("applied");
    expect(receipt.lines["a"]!.createdBy).toBe("sponson");
  });

  it("lists unmanaged resources and never touches them", async () => {
    cloud.seed("legacy", "keep-me");
    const plan = await planRun(opts());
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "unmanaged", resource: expect.objectContaining({ key: "item:legacy" }) }));
    await applyRun(opts());
    expect(cloud.items.get("legacy")!.value).toBe("keep-me");
  });

  it("reports an orphan when a line is removed from the plan, and leaves the resource alone", async () => {
    await applyRun(opts());
    const shorter = PLAN.split("  - id: c")[0]!;
    const plan = await planRun(opts(shorter));
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "orphan", line: "c" }));
    const { receipt } = await applyRun(opts(shorter));
    expect(cloud.items.has("gamma")).toBe(true);
    expect(receipt.lines["c"]).toMatchObject({ orphan: true });
    // destroy still knows about it
    await destroyRun(opts(shorter));
    expect(cloud.items.has("gamma")).toBe(false);
  });

  it("treats a changed value that already matches the plan as drift but not as a conflict", async () => {
    await applyRun(opts());
    cloud.drift("alpha", "two");
    cloud.drift("alpha", "one");
    const { receipt } = await applyRun(opts());
    expect(receipt.status).toBe("complete");
  });
});

describe("secrets", () => {
  const SECRET = `
version: 1
changes:
  - id: s
    adapter: fake
    op: item
    name: withsecret
    value: { secret: "fake://TOKEN" }
`;

  it("resolves secrets only in apply, redacts them everywhere, and stores a fingerprint", async () => {
    const redactor = new Redactor();
    const plan = await planRun(opts(SECRET, { redactor }));
    expect(plan.lines[0]!.inputs["value"]).toMatchObject({ state: "secret", value: null, ref: "fake://TOKEN" });
    expect(redactor.size()).toBe(0);

    cloud.failNext("apply", "withsecret"); // the fake error message embeds the value
    const failed = await applyRun(opts(SECRET, { redactor }));
    expect(failed.receipt.lines["s"]!.error).not.toContain("hunter2");

    const ok = await applyRun(opts(SECRET, { redactor }));
    expect(ok.receipt.lines["s"]!.secretFingerprints).toHaveProperty("fake://TOKEN");
    expect(JSON.stringify(ok.receipt)).not.toContain("hunter2");
    expect(cloud.items.get("withsecret")!.value).toBe("hunter2-secret");
  });

  it("warns when the secret changed since the last apply", async () => {
    await applyRun(opts(SECRET));
    registry.addSecretSource(fakeSecretSource({ TOKEN: "rotated" }));
    const { warnings } = await applyRun(opts(SECRET));
    expect(warnings.join("\n")).toMatch(/changed since the last apply/);
  });

  it("fails the line when the secret source cannot resolve", async () => {
    const { receipt } = await applyRun(opts(SECRET.replace("TOKEN", "NOPE")));
    expect(receipt.lines["s"]!.status).toBe("failed");
    expect(receipt.lines["s"]!.error).toContain("NOPE");
  });
});

describe("environments and approval", () => {
  it("rejects production without approval", async () => {
    await expect(applyRun(opts(PLAN, { ctx: { ...ctx, env: "production" } }))).rejects.toMatchObject({ code: "ENV_NOT_APPROVED" });
    const ok = await applyRun(opts(PLAN, { ctx: { ...ctx, env: "production" }, approvedBy: "alice" }));
    expect(ok.receipt.status).toBe("complete");
  });

  it("rejects an unknown environment with the list of known ones", async () => {
    await expect(planRun(opts(PLAN, { ctx: { ...ctx, env: "prod" } }))).rejects.toMatchObject({ code: "ENV_UNKNOWN", details: { known: ["preview", "production"] } });
  });

  it("filters lines by environment and rejects references across the filter", async () => {
    const src = PLAN.replace("value: one\n", "value: one\n    environments: [production]\n");
    await expect(planRun(opts(src))).rejects.toMatchObject({ code: "REF_FILTERED" });
  });
});

describe("locks", () => {
  it("refuses to run while another apply holds the scope", async () => {
    await store.acquireLock("preview", "pr-42", "other", 60_000);
    await expect(applyRun(opts())).rejects.toMatchObject({ code: "LOCK_HELD" });
  });

  it("preempts an expired lock and says so", async () => {
    await store.acquireLock("preview", "pr-42", "crashed", -1);
    const { receipt, warnings } = await applyRun(opts());
    expect(receipt.lockPreempted).toBe("crashed");
    expect(warnings[0]).toMatch(/expired lock/);
  });

  it("waits for a lock with --wait", async () => {
    await store.acquireLock("preview", "pr-42", "other", 60_000);
    setTimeout(() => void store.releaseLock("preview", "pr-42", "other"), 30);
    const { receipt } = await applyRun(opts(PLAN, { wait: true, pollIntervalMs: 10, waitTimeoutMs: 2000 }));
    expect(receipt.status).toBe("complete");
  });
});

describe("destroy", () => {
  it("destroys only what Sponson created, in reverse order, and keeps adopted resources", async () => {
    cloud.seed("alpha", "one"); // exists before Sponson: adopted
    await applyRun(opts());
    const { receipt } = await destroyRun(opts());
    expect(receipt.destroy).toBe(true);
    expect(receipt.lines["c"]!.status).toBe("destroyed");
    expect(receipt.lines["b"]!.status).toBe("destroyed");
    expect(receipt.lines["a"]!.status).toBe("skipped");
    expect(cloud.items.has("alpha")).toBe(true);
    expect(cloud.items.has("gamma")).toBe(false);
    const order = cloud.writes.filter((w) => w.op === "delete").map((w) => w.name);
    expect(order).toEqual(["gamma", "beta"]);
  });

  it("is fine when the resource is already gone", async () => {
    await applyRun(opts());
    cloud.delete("gamma");
    const { receipt } = await destroyRun(opts());
    expect(receipt.status).toBe("complete");
  });

  it("says nothing to destroy when there is no receipt", async () => {
    const { receipt, warnings } = await destroyRun(opts());
    expect(receipt.lines).toEqual({});
    expect(warnings[0]).toMatch(/Nothing to destroy/);
  });

  it("starts from zero after destroy (PR reopened)", async () => {
    await applyRun(opts());
    await destroyRun(opts());
    const { receipt } = await applyRun(opts());
    expect(Object.values(receipt.lines).every((l) => l.status === "applied")).toBe(true);
  });

  it("records destroy_failed and keeps the resource in the receipt", async () => {
    await applyRun(opts());
    cloud.failNext("destroy", "beta");
    const { receipt } = await destroyRun(opts());
    expect(receipt.status).toBe("failed");
    expect(receipt.lines["b"]!.status).toBe("destroy_failed");
    expect(receipt.lines["b"]!.resources).toHaveLength(1);
  });
});

describe("error codes", () => {
  it("keeps the SponsonError code on the receipt line so agents can branch on it", async () => {
    await applyRun(opts());
    cloud.drift("alpha", "edited");
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["a"]).toMatchObject({ status: "failed", errorCode: "DRIFT_CHANGED" });
  });
});

describe("receipt robustness", () => {
  it("degrades to no-receipt mode when the receipt is corrupt", async () => {
    await applyRun(opts());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join((store as unknown as { root: string }).root, "preview/pr-42/latest.json"), "{ not json");
    const r = await planRun(opts());
    expect(r.warnings[0]).toMatch(/not valid JSON/);
    expect(r.previous).toBeNull();
  });

  it("refuses receipts from a newer version", async () => {
    await applyRun(opts());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join((store as unknown as { root: string }).root, "preview/pr-42/latest.json"), JSON.stringify({ version: 2, lines: {}, scope: "pr-42", environment: "preview" }));
    await expect(planRun(opts())).rejects.toBeInstanceOf(SponsonError);
  });
});
