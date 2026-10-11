import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, destroyRun, planRun, type RunOptions } from "./index.js";
import { Lease } from "./lease.js";
import { SponsonError } from "../errors.js";
import { parsePlan } from "../plan.js";
import { Redactor } from "../redact.js";
import { LocalReceiptStore } from "../receipts/local.js";
import { Registry } from "../registry.js";
import { FakeCloud, fakeSecretSource } from "../testing/fake.js";
import type { Ctx } from "../types.js";

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
    expect(r.lines[0]!.outputs["secret"]).toBeNull(); // present, so agents know it exists; never text
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
    expect(receipt.lines["a"]!.outputs).toEqual({ id: "it_1", url: "https://alpha.example.test" }); // external outputs are recorded as soon as they exist
    expect(receipt.ledger.map((e) => [e.key, e.createdBy, e.line])).toEqual([
      ["item:alpha", "sponson", "a"],
      ["item:beta", "sponson", "b"],
      ["item:gamma", "sponson", "c"],
    ]);
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
    // The checkpoint written before each create survives the crash.
    const checkpoint = await store.read("preview", "pr-42");
    expect(checkpoint).toMatchObject({ status: "failed" });
    expect(checkpoint!.ledger.map((e) => e.key)).toEqual(["item:alpha", "item:beta"]);
    const { receipt } = await applyRun(opts());
    expect(receipt.lines["a"]!.status).toBe("unchanged");
    expect(receipt.lines["b"]!.status).toBe("unchanged");
    expect(receipt.lines["c"]!.status).toBe("applied");
    // Ownership survived the crash: everything is Sponson's and destroy removes all of it.
    expect(receipt.ledger.every((e) => e.createdBy === "sponson")).toBe(true);
    await destroyRun(opts());
    expect(cloud.items.size).toBe(0);
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
    const { receipt } = await applyRun(opts(EXT, { wait: true, waitTimeoutMs: 50, pollIntervalMs: 10 }));
    expect(receipt.status).toBe("failed");
    expect(receipt.lines["cb"]).toMatchObject({ status: "waiting", errorCode: "WAIT_TIMEOUT" });
    expect(receipt.lines["site"]!.status).toBe("applied"); // a slow deploy is not a reason to tear down the preview
    expect(receipt.ledger.map((e) => e.key)).toEqual(["item:site"]);
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
    expect(receipt.lines["a"]!.error).toContain("reconcile");
    expect(receipt.lines["a"]!.error).not.toContain("--");
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
    expect(receipt.ledger.find((e) => e.key === "item:gamma")).toMatchObject({ orphan: true, line: "c", createdBy: "sponson" });
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
    // plan resolves secrets only to mask them; the diff never carries the value.
    expect(redactor.size()).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).not.toContain("hunter2");

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
    const plan = await planRun(opts(SECRET.replace("TOKEN", "NOPE")));
    expect(plan.lines[0]).toMatchObject({ status: "blocked", errorCode: "SECRET_UNRESOLVED" });
    const { receipt } = await applyRun(opts(SECRET.replace("TOKEN", "NOPE")));
    expect(receipt.lines["s"]).toMatchObject({ status: "blocked", errorCode: "SECRET_UNRESOLVED" });
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
  it("stops on its own before its lease could have been taken, when renewals stall", async () => {
    // A store whose renewals never answer: the lease runs out by the holder's own clock.
    const stalled = new Proxy(store, {
      get: (t, k) => (k === "renewLock" ? () => new Promise<void>(() => {}) : typeof t[k as keyof typeof t] === "function" ? (t[k as keyof typeof t] as (...a: unknown[]) => unknown).bind(t) : t[k as keyof typeof t]),
    });
    await expect(applyRun(opts(PLAN, { store: stalled, lockTtlMs: 100, onLineDone: () => new Promise((r) => setTimeout(r, 120)) }))).rejects.toMatchObject({ code: "LOCK_LOST" });
    // The deadline falls before line b (each line waits 120ms > the 100ms lease): at most alpha was written,
    // however slow the machine is, and whatever was written is still owned by the ledger.
    const written = cloud.writes.map((w) => w.name);
    expect(written.filter((n) => n !== "alpha")).toEqual([]);
    const r = await store.read("preview", "pr-42");
    for (const name of written) expect(r?.ledger.find((e) => e.key === `item:${name}`)?.createdBy).toBe("sponson");
    expect(Object.values(r?.lines ?? {}).some((l) => l.errorCode === "LOCK_LOST")).toBe(true);
  });

  it("records the final receipt when renewals lagged but nobody took the lock (receipts are fenced by the store)", async () => {
    const stalled = new Proxy(store, {
      get: (t, k) => (k === "renewLock" ? () => new Promise<void>(() => {}) : typeof t[k as keyof typeof t] === "function" ? (t[k as keyof typeof t] as (...a: unknown[]) => unknown).bind(t) : t[k as keyof typeof t]),
    });
    // Every line is applied well before the holder's deadline; the deadline passes only before the final write.
    // The TTL is generous so that holds on a slow, instrumented CI runner too: three lines take far less than 800ms.
    const { receipt } = await applyRun(opts(PLAN, { store: stalled, lockTtlMs: 1000, onLineDone: (id) => (id === "c" ? new Promise((r) => setTimeout(r, 1100)) : undefined) }));
    expect(receipt.status).toBe("complete");
    const stored = await store.read("preview", "pr-42");
    expect(stored?.runId).toBe(receipt.runId);
    expect(stored?.ledger.every((e) => e.createdBy === "sponson" && e.id !== "")).toBe(true);
  });

  it("a lock that cannot be released is reported, never silently left behind", async () => {
    const stuck = new Proxy(store, {
      get: (t, k) => (k === "releaseLock" ? () => Promise.reject(new Error("push refused")) : typeof t[k as keyof typeof t] === "function" ? (t[k as keyof typeof t] as (...a: unknown[]) => unknown).bind(t) : t[k as keyof typeof t]),
    });
    const { receipt, warnings } = await applyRun(opts(PLAN, { store: stuck }));
    expect(receipt.status).toBe("complete");
    expect(warnings.join("\n")).toMatch(/Could not release the lock for preview\/pr-42 \(push refused\); it stays held until/);
  });

  it("never has two renewals in flight, however slow the store is", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let renewals = 0;
    const slow = new Proxy(store, {
      get: (t, k) =>
        k === "renewLock"
          ? async (...args: Parameters<typeof store.renewLock>) => {
              inFlight++;
              renewals++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await new Promise((r) => setTimeout(r, 60)); // slower than the 40ms renewal period
              inFlight--;
              return store.renewLock(...args);
            }
          : typeof t[k as keyof typeof t] === "function"
            ? (t[k as keyof typeof t] as (...a: unknown[]) => unknown).bind(t)
            : t[k as keyof typeof t],
    });
    // The lease on its own, held for a while: a fixed interval would start a renewal every 40ms.
    const lease = await Lease.acquire(opts(PLAN, { store: slow, lockTtlMs: 120 }), "holder");
    // Count-driven, not time-driven: however slow the machine, observe three renewals.
    while (renewals < 3) await new Promise((r) => setTimeout(r, 20));
    await lease.release();
    expect(maxInFlight).toBe(1);
  });

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

  /** Crash right after `b` created its item: the last receipt on disk is the checkpoint that holds `item:beta` as an intent. */
  async function crashAfterCreatingBeta(): Promise<void> {
    const crash = opts(PLAN, {
      onLineDone: (id) => {
        if (id === "b") throw new Error("SIGKILL");
      },
    });
    await expect(applyRun(crash)).rejects.toThrow("SIGKILL");
    const checkpoint = await store.read("preview", "pr-42");
    expect(checkpoint!.ledger.find((e) => e.key === "item:beta")).toMatchObject({ createdBy: "intent", line: "b" });
    expect(cloud.items.has("beta")).toBe(true);
  }

  it("after a crash, locates an intent through its line and destroys it as Sponson's", async () => {
    await crashAfterCreatingBeta();
    const { receipt } = await destroyRun(opts());
    expect(receipt.status).toBe("complete");
    expect(receipt.lines["b"]!.status).toBe("destroyed");
    expect(cloud.items.has("beta")).toBe(false);
    expect(cloud.items.has("alpha")).toBe(false);
    expect(receipt.ledger).toEqual([]);
  });

  it("after a crash, an intent whose line left the plan is INTENT_UNRESOLVED, never silently forgotten", async () => {
    await crashAfterCreatingBeta();
    const onlyA = PLAN.slice(0, PLAN.indexOf("  - id: b"));
    const { receipt } = await destroyRun(opts(onlyA));
    expect(receipt.status).toBe("failed");
    expect(receipt.lines["b"]).toMatchObject({ status: "destroy_failed", errorCode: "INTENT_UNRESOLVED" });
    expect(receipt.ledger.find((e) => e.key === "item:beta")).toMatchObject({ createdBy: "intent" });
    // Unlocatable means untouched: the item may be Sponson's, but nothing is deleted on a guess.
    expect(cloud.items.has("beta")).toBe(true);
    expect(cloud.items.has("alpha")).toBe(false);
  });

  it("records a preempted lock on the destroy receipt too", async () => {
    await applyRun(opts());
    await store.acquireLock("preview", "pr-42", "crashed", -1);
    const { receipt, warnings } = await destroyRun(opts());
    expect(receipt.lockPreempted).toBe("crashed");
    expect(warnings[0]).toMatch(/expired lock/);
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
    expect(receipt.lines["a"]).toMatchObject({ status: "blocked", errorCode: "DRIFT_CHANGED" });
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
    await writeFile(join((store as unknown as { root: string }).root, "preview/pr-42/latest.json"), JSON.stringify({ version: 3, lines: {}, scope: "pr-42", environment: "preview" }));
    await expect(planRun(opts())).rejects.toBeInstanceOf(SponsonError);
  });
});

describe("v2: the ledger never forgets", () => {
  it("a refused line stays refused on retry, and keeps its ownership", async () => {
    await applyRun(opts());
    cloud.drift("alpha", "hotfix");
    const first = await applyRun(opts());
    expect(first.receipt.lines["a"]).toMatchObject({ status: "blocked", errorCode: "DRIFT_CHANGED" });
    const plan = await planRun(opts());
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "changed", line: "a" }));
    expect(plan.lines[0]).toMatchObject({ status: "blocked", errorCode: "DRIFT_CHANGED" });
    const second = await applyRun(opts());
    expect(second.receipt.lines["a"]).toMatchObject({ status: "blocked", errorCode: "DRIFT_CHANGED" });
    expect(cloud.items.get("alpha")!.value).toBe("hotfix");
    expect(second.receipt.ledger.filter((e) => e.createdBy === "sponson").map((e) => e.key)).toEqual(["item:alpha", "item:beta", "item:gamma"]);
    await destroyRun(opts());
    expect(cloud.items.size).toBe(0);
  });

  it("a create whose response was lost is still Sponson's: rolled back on failure, or claimed on the next run", async () => {
    cloud.failNext("lost", "beta");
    const failed = await applyRun(opts());
    expect(failed.receipt.status).toBe("failed");
    expect(cloud.items.size).toBe(0); // alpha rolled back, and beta found by re-read and rolled back too

    cloud.failNext("lost", "gamma");
    cloud.failNext("destroy", "gamma"); // rollback cannot remove it either
    const second = await applyRun(opts());
    expect(second.receipt.ledger.find((e) => e.key === "item:gamma")).toMatchObject({ createdBy: "sponson" });
    const third = await applyRun(opts());
    expect(third.receipt.ledger.find((e) => e.key === "item:gamma")?.createdBy).toBe("sponson");
    await destroyRun(opts());
    expect(cloud.items.size).toBe(0);
  });

  it("renaming a line id moves ownership instead of orphaning", async () => {
    await applyRun(opts());
    const renamed = PLAN.replace("id: c", "id: renamed");
    const plan = await planRun(opts(renamed));
    expect(plan.drift.filter((d) => d.kind === "orphan")).toEqual([]);
    const { receipt } = await applyRun(opts(renamed));
    expect(receipt.ledger.find((e) => e.key === "item:gamma")).toMatchObject({ line: "renamed", createdBy: "sponson", orphan: false });
  });

  it("changing a resource's name leaves the old one as an orphan that destroy still removes", async () => {
    await applyRun(opts());
    const changed = PLAN.replace("name: gamma", "name: gamma2");
    const plan = await planRun(opts(changed));
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "orphan", resource: expect.objectContaining({ key: "item:gamma" }) }));
    expect(plan.drift.some((d) => d.kind === "missing")).toBe(false);
    await applyRun(opts(changed));
    await destroyRun(opts(changed));
    expect([...cloud.items.keys()]).toEqual([]);
  });

  it("a resource deleted and re-created by hand is not taken over silently", async () => {
    await applyRun(opts());
    const value = cloud.items.get("alpha")!.value;
    cloud.delete("alpha");
    cloud.items.set("alpha", { id: "human_1", name: "alpha", value, createdBy: "seed" });
    const plan = await planRun(opts());
    expect(plan.drift).toContainEqual(expect.objectContaining({ kind: "changed", replaced: true, line: "a" }));
    const refused = await applyRun(opts());
    expect(refused.receipt.lines["a"]).toMatchObject({ status: "blocked", errorCode: "DRIFT_CHANGED" });
    const taken = await applyRun(opts(PLAN, { reconcile: true }));
    expect(taken.receipt.ledger.find((e) => e.key === "item:alpha")).toMatchObject({ id: "human_1", createdBy: "adopted" });
    await destroyRun(opts());
    expect(cloud.items.has("alpha")).toBe(true); // the human's object survives
  });

  it("external outputs land in the receipt and ledger even when no line reads them", async () => {
    const { receipt } = await applyRun(opts(`version: 1\nchanges:\n  - { id: site, adapter: fake, op: item, name: site, value: v1 }\n`));
    expect(receipt.lines["site"]!.outputs).toMatchObject({ url: "https://site.example.test" });
    expect(receipt.ledger[0]!.outputs).toMatchObject({ url: "https://site.example.test" });
  });
});

describe("v2: scope and environment boundaries", () => {
  it("a line that writes to production needs approval even under --env preview", async () => {
    const src = PLAN.replace("value: one\n", "value: one\n    target: production\n");
    await expect(applyRun(opts(src))).rejects.toMatchObject({ code: "ENV_NOT_APPROVED", details: { productionLines: ["a"] } });
    expect(cloud.writes).toHaveLength(0);
    expect((await planRun(opts(src))).requiresApproval).toBe(true);
    const ok = await applyRun(opts(src, { approvedBy: "  alice  " }));
    expect(ok.receipt.approvedBy).toBe("alice");
    await expect(applyRun(opts(src, { approvedBy: "   " }))).rejects.toMatchObject({ code: "ENV_NOT_APPROVED" });
  });

  it("an op may decide from its provider block that a line writes to production (writesEnvironment's third argument)", async () => {
    const src = PLAN.replace("version: 1\n", "version: 1\nproviders:\n  fake: { production: true }\n");
    await expect(applyRun(opts(src))).rejects.toMatchObject({ code: "ENV_NOT_APPROVED", details: { productionLines: ["a", "b", "c"] } });
    expect(cloud.writes).toHaveLength(0);
    expect(cloud.reads).toBe(0);
    expect((await planRun(opts(src))).requiresApproval).toBe(true);
    expect((await planRun(opts(PLAN.replace("version: 1\n", "version: 1\nproviders:\n  fake: { production: false }\n")))).requiresApproval).toBe(false);
    expect((await applyRun(opts(src, { approvedBy: "alice" }))).receipt.status).toBe("complete");
  });

  it("another scope's resources are neither unmanaged nor changeable, but may be relied on", async () => {
    const shared = `version: 1\nchanges:\n  - { id: s, adapter: fake, op: item, name: shared, value: v1 }\n`;
    await applyRun(opts(shared));
    const other = { ...ctx, pr: { number: 43 }, scope: "pr-43" };
    const plan = await planRun(opts(shared, { ctx: other }));
    expect(plan.drift.filter((d) => d.kind === "unmanaged")).toEqual([]);
    const relied = await applyRun(opts(shared, { ctx: other }));
    expect(relied.receipt.lines["s"]!.status).toBe("unchanged");
    expect(relied.receipt.ledger[0]!.createdBy).toBe("adopted");
    const conflicting = await applyRun(opts(shared.replace("v1", "v2"), { ctx: other }));
    expect(conflicting.receipt.lines["s"]).toMatchObject({ status: "blocked", errorCode: "OWNED_BY_OTHER_SCOPE" });
    expect(cloud.items.get("shared")!.value).toBe("v1");
    await destroyRun(opts(shared, { ctx: other }));
    expect(cloud.items.has("shared")).toBe(true); // pr-43 never owned it
  });

  it("a late run for an older commit changes nothing", async () => {
    await applyRun(opts());
    await applyRun(opts(PLAN.replace("value: one", "value: two"), { ctx: { ...ctx, git: { ...ctx.git, sha: "newer", short_sha: "newer" } } }));
    const writes = cloud.writes.length;
    const late = await applyRun(opts());
    expect(late.receipt.stale).toBe(true);
    expect(cloud.writes.length).toBe(writes);
    expect(cloud.items.get("alpha")!.value).toBe("two");
    expect((await planRun(opts())).warnings.join("\n")).toMatch(/stale/);
  });

  it("a never-applied commit older than the last applied one is stale when ancestry can tell, and not otherwise", async () => {
    const newer = { ...ctx, git: { ...ctx.git, sha: "newer", short_sha: "newer" } };
    await applyRun(opts(PLAN.replace("value: one", "value: two"), { ctx: newer }));
    const writes = cloud.writes.length;
    const isAncestor = async (older: string, n: string) => (older === "older" && n === "newer" ? true : null);
    const older = { ...ctx, git: { ...ctx.git, sha: "older", short_sha: "older" } };
    const late = await applyRun(opts(PLAN, { ctx: older, isAncestor }));
    expect(late.receipt.stale).toBe(true);
    expect(late.receipt.lines["a"]).toMatchObject({ status: "skipped", errorCode: "STALE" });
    expect(cloud.writes.length).toBe(writes);
    // Unknown ancestry (shallow clone): not provably older, so the run proceeds.
    const unknown = await applyRun(opts(PLAN, { ctx: { ...ctx, git: { ...ctx.git, sha: "other", short_sha: "other" } }, isAncestor: async () => null }));
    expect(unknown.receipt.stale).toBeUndefined();
  });

  it("a misspelt output name fails before anything is written", async () => {
    await expect(planRun(opts(PLAN.replace("a.id", "a.idd")))).rejects.toMatchObject({ code: "REF_OUTPUT_UNKNOWN" });
  });
});

describe("once-only outputs (ADR 0018)", () => {
  const ONCE = `
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

  it("reaches dependents in the run that creates it, is never recorded, and a re-apply writes nothing", async () => {
    const first = await applyRun(opts(ONCE));
    expect(first.receipt.status).toBe("complete");
    expect(cloud.items.get("env")!.value).toBe(`t-${cloud.items.get("pw")!.id}-pw`);
    expect(JSON.stringify(first.receipt)).not.toContain("t-it_");

    const writes = cloud.writes.length;
    const plan = await planRun(opts(ONCE));
    expect(plan.lines.map((l) => l.status)).toEqual(["unchanged", "unchanged"]);
    expect(plan.lines[1]!.inputs["value"]).toMatchObject({ state: "kept", ref: "pw.token", dependsOn: "pw" });
    const again = await applyRun(opts(ONCE));
    expect(again.receipt.status).toBe("complete");
    expect(Object.values(again.receipt.lines).map((l) => l.status)).toEqual(["unchanged", "unchanged"]);
    expect(cloud.writes.length).toBe(writes);
  });

  it("is pending in a plan while the producing line still has to create its resource", async () => {
    const r = await planRun(opts(ONCE));
    expect(r.lines.map((l) => l.status)).toEqual(["create", "pending"]);
  });

  it("a re-created producer (missing drift) passes its new value on in that run", async () => {
    await applyRun(opts(ONCE));
    cloud.delete("pw");
    const r = await applyRun(opts(ONCE));
    expect(r.receipt.status).toBe("complete");
    expect(cloud.items.get("env")!.value).toBe(`t-${cloud.items.get("pw")!.id}-pw`);
  });

  it("a dependent that would need the value in a later run is refused, and nothing is re-created", async () => {
    await applyRun(opts(ONCE));
    cloud.delete("env");
    const writes = cloud.writes.length;
    const plan = await planRun(opts(ONCE));
    expect(plan.lines[1]).toMatchObject({ status: "blocked", errorCode: "OUTPUT_UNAVAILABLE" });
    const r = await applyRun(opts(ONCE));
    expect(r.receipt.status).toBe("failed");
    expect(r.receipt.lines["env"]).toMatchObject({ status: "blocked", errorCode: "OUTPUT_UNAVAILABLE", error: expect.stringMatching(/`pw.token`.*earlier run.*Nothing was written/) });
    expect(cloud.writes.length).toBe(writes);
    expect(cloud.items.has("pw")).toBe(true);
  });
});

describe("ops that narrow their provider block and declare outputs per line (OpSpec.providerFor, outputsFor)", () => {
  const NARROW = `
version: 1
providers:
  fake:
    one: { region: eu }
    two: { region: us }
changes:
  - { id: a, adapter: fake, op: item, api: one, name: alpha, value: v, declared: [extra] }
  - { id: b, adapter: fake, op: item, api: two, name: beta, value: { from: a.extra } }
`;

  beforeEach(() => {
    const base = cloud.adapter();
    const item = base.ops.item!;
    const narrowed = {
      ...item,
      providerFor: (block: Record<string, unknown>, params: Record<string, unknown>) => {
        const b = block[String(params.api)];
        if (!b || typeof b !== "object") throw new SponsonError("PLAN_INVALID", `no api ${String(params.api)}`);
        return b as Record<string, unknown>;
      },
      outputsFor: (params: Record<string, unknown>) => ({
        ...item.outputs,
        ...Object.fromEntries(((params.declared as string[] | undefined) ?? []).map((n) => [n, { available: "immediate" as const }])),
      }),
    };
    registry = new Registry().addAdapter({ ...base, ops: { item: narrowed } });
  });

  it("records each resource under its own part of the provider block", async () => {
    const { receipt } = await applyRun(opts(NARROW.replace("{ from: a.extra }", "w")));
    expect(receipt.ledger.map((e) => [e.key, e.provider])).toEqual([
      ["item:alpha", { region: "eu" }],
      ["item:beta", { region: "us" }],
    ]);
  });

  it("checks references against the outputs a line declares, before any provider call", async () => {
    await expect(planRun(opts(NARROW.replace("a.extra", "a.undeclared")))).rejects.toMatchObject({ code: "REF_OUTPUT_UNKNOWN" });
    expect(cloud.reads).toBe(0);
    const r = await planRun(opts(NARROW));
    expect(r.lines.find((l) => l.id === "b")!.waitingOn).toBe("a");
  });

  it("fails the run before any provider call when a line names a block that does not exist", async () => {
    await expect(planRun(opts(NARROW.replace("api: two", "api: three")))).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(cloud.reads).toBe(0);
  });
});
