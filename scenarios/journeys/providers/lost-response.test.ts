/**
 * "Did it happen?" — a write that succeeded server-side but whose response never reached Sponson.
 *
 * Correct behaviour (README: "Rolls back what this run created", "Destroy is symmetric: removes what Sponson
 * created"; invariant I2: after a failed run's rollback the set of Sponson-created resources equals the
 * set before the run): a resource Sponson wrote must be either rolled back or remembered as Sponson's, whether
 * or not the HTTP response arrived. Otherwise it is recorded as `adopted` on the next run and `--destroy`
 * leaves it behind forever.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isPath, PR_BRANCH, THREE_LINE_PLAN, World } from "./harness.js";

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

describe("lost responses", () => {
  it("neon branch created but the POST response was lost: the next apply must still treat the branch as Sponson's, so destroy removes it", async () => {
    w = await World.create({
      plan: `version: 1
providers:
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
`,
    });
    w.proxy.on(isPath("POST", /^\/neon\/projects\/[^/]+\/branches$/), () => "drop", 1);

    const r1 = await w.cli("apply --json");
    expect(r1.code).toBe(1);
    expect(r1.json.receipt.lines.db.status).toBe("failed");
    // The write did happen server-side. v2 (write-ahead intent) records the intent before the POST, so the
    // run can recover it at once: either it rolls the branch back as part of this failed run, or it keeps it in the
    // ledger as Sponson's. Leaving it in the cloud *and* out of the ledger is the leak this test guards against.
    const survived = w.branches(PR_BRANCH).length;
    const inLedger = (r1.json.receipt.ledger ?? []).some((e: { key: string; createdBy: string }) => e.key === `branch:${PR_BRANCH}` && e.createdBy !== "adopted");
    expect({ survived, inLedger }, "branch written in run 1 is neither rolled back nor recorded as Sponson's").toSatisfy(
      (x: { survived: number; inLedger: boolean }) => x.survived === 0 || (x.survived === 1 && x.inLedger),
    );

    const r2 = await w.cli("apply --json");
    expect(r2.code).toBe(0);
    expect(r2.json.receipt.status).toBe("complete");
    expect(w.branches(PR_BRANCH)).toHaveLength(1); // no duplicate
    // Sponson made this branch; it must not be laundered into "adopted".
    expect.soft(r2.json.receipt.lines.db.createdBy, "db created by Sponson in run 1 is recorded as adopted in run 2").toBe("sponson");

    const d = await w.cli("apply --destroy --json");
    expect(d.code).toBe(0);
    expect(w.branches(PR_BRANCH), "destroy left the Sponson-created branch behind").toHaveLength(0);
  });

  it("3-line plan: env write lost after succeeding, rollback hits 429 (Retry-After: 1), next apply converges without duplicates and destroy leaves nothing", async () => {
    w = await World.create({ plan: THREE_LINE_PLAN });
    // line 2: the bulk upsert lands in Vercel, the client sees a reset connection
    w.proxy.on(isPath("POST", /^\/vercel\/v10\/projects\/[^/]+\/env$/), () => "drop", 1);
    // rollback of line 1: Neon rate-limits the DELETE once
    w.proxy.on(isPath("DELETE", /^\/neon\/projects\/[^/]+\/branches\/[^/]+$/), () => ({ status: 429, headers: { "retry-after": "1" }, body: { code: "", message: "rate limit exceeded" } }), 1);

    const r1 = await w.cli("apply --json");
    expect(r1.code).toBe(1);
    expect(r1.json.receipt.lines.env.status).toBe("failed");
    // A 429 with a one-second Retry-After is not a reason to abandon a rollback.
    expect.soft(r1.json.receipt.lines.db.status, "rollback gave up on a 429 instead of honouring Retry-After").toBe("rolled_back");
    // The env vars this run wrote must be rolled back or at least remembered for destroy.
    const envRemembered = (r1.json.receipt.lines.env.resources ?? []).some((r: { key: string }) => r.key === "env:preview:DATABASE_URL");
    expect.soft(envRemembered || w.envs("DATABASE_URL").length === 0, "env vars written in run 1 are neither rolled back nor in the receipt").toBe(true);

    const r2 = await w.cli("apply --json");
    expect(r2.code, r2.stdout).toBe(0);
    // callback waits for the deploy in the default mode, or completes if the deploy was already seen
    expect(["complete", "partial"]).toContain(r2.json.receipt.status);
    expect(w.branches(PR_BRANCH)).toHaveLength(1);
    expect(w.envs("DATABASE_URL")).toHaveLength(1);
    expect(w.envs("APP_NAME")).toHaveLength(1);
    expect.soft(r2.json.receipt.lines.env.createdBy, "env vars Sponson wrote in run 1 are recorded as adopted in run 2").toBe("sponson");

    // Finish the callback (deploy is READY in the sim), then tear the scope down.
    const r3 = await w.cli("apply --json");
    expect(r3.json.receipt.status).toBe("complete");
    expect(w.redirects()).toHaveLength(1);

    const d = await w.cli("apply --destroy --json");
    expect(d.code).toBe(0);
    expect.soft(w.branches(PR_BRANCH), "branch left after destroy").toHaveLength(0);
    expect.soft(w.redirects(), "redirect left after destroy").toHaveLength(0);
    expect(w.envs().map((e) => e.key), "env vars Sponson wrote survive destroy").toEqual([]);
  });

  it("vercel bulk upsert answers 200 with one entry under `failed`: the entries it did create are rolled back with the rest of the run", async () => {
    w = await World.create({
      plan: `version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
  - id: env
    adapter: vercel
    op: env
    values:
      DATABASE_URL: { from: db.connection_string }
      FEATURE_FLAGS: "checkout-v2"
`,
    });
    // Vercel accepts DATABASE_URL and rejects FEATURE_FLAGS inside a 200 (assumption V4 in sim/src/routes/vercel.ts).
    w.proxy.on(isPath("POST", /^\/vercel\/v10\/projects\/[^/]+\/env$/), (r) => {
      const items = JSON.parse(r.body) as Array<{ key: string }>;
      return {
        forwardWith: { body: JSON.stringify(items.filter((i) => i.key !== "FEATURE_FLAGS")) },
        rewrite: (u) => {
          const b = JSON.parse(u.body);
          b.failed = [{ error: { code: "ENV_CONFLICT", key: "FEATURE_FLAGS", message: "conflicts with an existing variable" } }];
          return { ...u, body: JSON.stringify(b) };
        },
      };
    }, 1);

    const r1 = await w.cli("apply --json");
    expect(r1.code).toBe(1);
    expect(r1.json.receipt.lines.env.status).toBe("failed");
    expect(r1.json.receipt.lines.env.error).toMatch(/FEATURE_FLAGS/);
    expect(r1.json.receipt.lines.db.status).toBe("rolled_back");
    expect(w.branches(PR_BRANCH)).toHaveLength(0);
    // DATABASE_URL now points at a branch that was just deleted, and nothing records that Sponson wrote it.
    expect(w.envs("DATABASE_URL"), "partially-applied env var survived the rollback (dangling connection string)").toHaveLength(0);
  });
});
