/**
 * Transient provider errors: 429 with Retry-After, 502/503 on idempotent reads, 423 Locked from Neon while a
 * previous operation is still running, and connections that never answer.
 *
 * Expected behaviour is plain user expectation rather than a documented contract (nothing in README/SKILL
 * promises retries): a CLI meant to run unattended in CI against three SaaS APIs should absorb a single
 * transient error on a safe-to-retry request instead of failing the run and tearing down the preview
 * database it just created. Each test injects exactly one transient fault (or one bounded window of them).
 */
import { afterEach, describe, expect, it } from "vitest";
import { isPath, PR_BRANCH, THREE_LINE_PLAN, World } from "./harness.js";

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

const DB_AND_CALLBACK = `version: 1
providers:
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: "https://pr-42.shop.example.com/sso-callback"
    depends_on: [db]
`;

describe("transient provider errors", () => {
  it("one 429 with Retry-After: 1 on the Vercel env upsert is waited out, not turned into a rollback of the whole preview", async () => {
    w = await World.create({ plan: THREE_LINE_PLAN });
    w.proxy.on(isPath("POST", /^\/vercel\/v10\/projects\/[^/]+\/env$/), () => ({ status: 429, headers: { "retry-after": "1" }, body: { error: { code: "rate_limited", message: "Rate limit exceeded" } } }), 1);

    const r = await w.cli("apply --json");
    expect(r.json.receipt.lines.db.status, JSON.stringify(r.json.receipt.lines.env)).toBe("applied");
    expect(r.json.receipt.lines.env.status).toBe("applied");
    expect(r.exit).toBe(0);
    expect(w.branches(PR_BRANCH)).toHaveLength(1);
  });

  it("one 502 (HTML error page) on an idempotent GET mid-apply does not fail the run and delete the branch created a moment earlier", async () => {
    w = await World.create({ plan: DB_AND_CALLBACK });
    w.proxy.on(isPath("GET", /^\/clerk\/redirect_urls$/), () => ({ status: 502, headers: { "content-type": "text/html" }, body: "<html><body><h1>502 Bad Gateway</h1></body></html>" }), 1);

    const r = await w.cli("apply --json");
    expect(r.json.receipt.lines.callback.status, r.json.receipt.lines.callback.error).toBe("applied");
    expect(r.json.receipt.status).toBe("complete");
    expect(w.branches(PR_BRANCH)).toHaveLength(1);
  });

  it("one 503 on a read during `plan` yields a plan, not an error line (plan is read-only, so retrying is free)", async () => {
    w = await World.create({ plan: DB_AND_CALLBACK });
    w.proxy.on(isPath("GET", /^\/neon\/projects\/[^/]+\/branches$/), () => ({ status: 503, body: { message: "service unavailable" } }), 1);

    const r = await w.cli("plan --json");
    const db = r.json.lines.find((l: { id: string }) => l.id === "db");
    expect(db.status, db.error).toBe("create");
    expect(r.exit).toBe(0);
  });

  it("Neon answers 423 Locked while the previous branch's operations are still running: the second branch line retries instead of failing and rolling back the first", async () => {
    w = await World.create({
      plan: `version: 1
providers:
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
  - id: analytics
    adapter: neon
    op: branch
    name: "sponson/preview/pr-42-analytics"
`,
    });
    // Real Neon runs branch creation as async operations and rejects conflicting writes on the project with 423
    // until they finish. Model a 600ms operation window after every branch create.
    let busyUntil = 0;
    w.proxy.on(
      (r) => r.path.startsWith("/neon/") && r.method !== "GET",
      async (r) => {
        if (Date.now() < busyUntil) return { status: 423, body: { code: "", message: "project already has running conflicting operations, scheduling of new ones is prohibited" } };
        if (r.method === "POST") busyUntil = Date.now() + 600;
        return undefined;
      },
    );

    const r = await w.cli("apply --json");
    expect.soft(r.json.receipt.lines.db.status, `rollback of db: ${r.json.receipt.lines.db.error}`).not.toBe("rollback_failed");
    expect(r.json.receipt.lines.analytics.status, r.json.receipt.lines.analytics.error).toBe("applied");
    expect(r.json.receipt.lines.db.status).toBe("applied");
    expect(w.branches()).toHaveLength(3);
  });

  it("a provider that accepts the connection and never answers does not hang apply (and the scope lock) indefinitely", async () => {
    // The bound is SPONSON_HTTP_TIMEOUT_MS (design G3; default 30s, with retries). A 6s budget against the defaults would
    // only test the defaults' size, so the test sets a short timeout and few retries, as a CI user in a hurry would.
    w = await World.create({ plan: DB_AND_CALLBACK, env: { SPONSON_HTTP_TIMEOUT_MS: "300", SPONSON_HTTP_RETRIES: "1", SPONSON_HTTP_RETRY_BASE_MS: "50" } });
    w.proxy.on(isPath("GET", /^\/clerk\/redirect_urls$/), () => "hang");

    const BUDGET_MS = 6000;
    const outcome = await Promise.race([
      w.cli("apply --json").then((r) => ({ settled: true as const, r })),
      new Promise<{ settled: false }>((res) => setTimeout(() => res({ settled: false }), BUDGET_MS)),
    ]);
    // Undici's default headers timeout is 300s; nothing in Sponson bounds a single request.
    expect(outcome.settled, `apply still running after ${BUDGET_MS}ms against a hung Clerk endpoint`).toBe(true);
    if (!outcome.settled) return;
    const rc = outcome.r.json.receipt;
    expect(outcome.r.exit).toBe(1);
    expect(rc.lines.callback.errorCode).toMatch(/^PROVIDER_/);
    // The run failed, so the branch it created is rolled back, and the scope lock is free for the next run.
    expect(rc.lines.db.status).toBe("rolled_back");
    expect(w.branches(PR_BRANCH)).toHaveLength(0);
  }, 15000);
});
