/**
 * List endpoints that do not return everything on the first call: paginated responses and
 * eventually-consistent reads right after a write.
 *
 * Pagination shapes modelled here:
 *   Neon   GET /projects/:id/branches  → { branches, pagination: { next } }, next page via ?cursor=
 *   Vercel GET /v9/projects/:id/env    → { envs, pagination: { count, next, prev } }, next page via ?until=
 * Real page sizes are larger than the 2–3 used here; any project with enough preview branches/vars hits it.
 * Expected behaviour: invariant I3 (apply; apply → the second run is all unchanged, 0 writes) and plain
 * convergence hold whatever page a resource lands on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isPath, PR_BRANCH, World, type Upstream } from "./harness.js";

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

function paginate<T>(u: Upstream, field: string, size: number, cursor: string | null, shape: (next: string | null, total: number) => Record<string, unknown>): Upstream {
  if (u.status !== 200) return u;
  const all = JSON.parse(u.body)[field] as T[];
  const start = cursor ? Number(cursor) : 0;
  const page = all.slice(start, start + size);
  const next = start + size < all.length ? String(start + size) : null;
  return { ...u, body: JSON.stringify({ [field]: page, pagination: shape(next, all.length) }) };
}

const ENV_PLAN = `version: 1
providers:
  vercel: { project: prj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    values:
      API_BASE: "https://api.pr-42.example.com"
      FEATURE_FLAGS: "checkout-v2"
`;

describe("paginated and lagging lists", () => {
  it("neon: the PR branch sits on page 3 of the branch list; the second apply sees it (unchanged, 0 writes) instead of POSTing a duplicate and failing on 409", async () => {
    w = await World.create({
      plan: `version: 1
providers:
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
`,
      seed: { neon: { projects: { proj_demo: { branches: [{ name: "main" }, { name: "dev", parent: "main" }, { name: "staging", parent: "main" }, { name: "sponson/preview/pr-7", parent: "main" }] } } } },
    });
    w.proxy.on(isPath("GET", /^\/neon\/projects\/[^/]+\/branches$/), (r) => ({
      rewrite: (u) => paginate(u, "branches", 2, r.query.get("cursor"), (next) => ({ ...(next ? { next } : {}), sort_by: "updated_at", sort_order: "DESC" })),
    }));

    const r1 = await w.cli("apply --json");
    expect(r1.json.receipt.status).toBe("complete");
    expect(w.branches(PR_BRANCH)).toHaveLength(1);

    const p = await w.cli("plan --json");
    expect.soft(p.json.lines[0].status, "plan proposes to create a branch that exists on page 3").toBe("unchanged");

    const r2 = await w.cli("apply --json");
    expect(r2.json.receipt.lines.db.status, r2.json.receipt.lines.db.error).toBe("unchanged");
    expect(r2.writes).toBe(0);
  });

  it("vercel: with more env vars than one page, the vars just upserted are found (no 'missing after upsert') and a second apply writes nothing", async () => {
    w = await World.create({
      plan: ENV_PLAN,
      seed: {
        vercel: {
          projects: {
            prj_demo: {
              envs: ["SENTRY_DSN", "NEXT_PUBLIC_POSTHOG_HOST", "LOG_LEVEL", "REDIS_URL", "SEARCH_HOST"].map((key) => ({ key, value: `v-${key}`, target: "preview" })),
            },
          },
        },
      },
    });
    w.proxy.on(isPath("GET", /^\/vercel\/v9\/projects\/[^/]+\/env$/), (r) => ({
      rewrite: (u) => paginate(u, "envs", 3, r.query.get("until"), (next, total) => ({ count: Math.min(3, total), next: next === null ? null : Number(next), prev: null })),
    }));

    const r1 = await w.cli("apply --json");
    expect(r1.json.receipt.lines.env.status, r1.json.receipt.lines.env.error).toBe("applied");
    const r2 = await w.cli("apply --json");
    expect(r2.json.receipt.lines.env.status).toBe("unchanged");
    expect(r2.writes).toBe(0);
  });

  it("vercel: the env list lags the upsert by ~0.5s (eventual consistency); apply does not fail with 'missing after upsert' and roll back the branch", async () => {
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
`,
    });
    let hidden: Set<string> = new Set();
    let hiddenUntil = 0;
    w.proxy.on(isPath("POST", /^\/vercel\/v10\/projects\/[^/]+\/env$/), (r) => {
      hidden = new Set((JSON.parse(r.body) as Array<{ key: string }>).map((i) => i.key));
      hiddenUntil = Date.now() + 500;
      return undefined;
    });
    w.proxy.on(isPath("GET", /^\/vercel\/v9\/projects\/[^/]+\/env$/), () => ({
      rewrite: (u) => {
        if (Date.now() >= hiddenUntil) return u;
        const b = JSON.parse(u.body);
        b.envs = b.envs.filter((e: { key: string }) => !hidden.has(e.key));
        return { ...u, body: JSON.stringify(b) };
      },
    }));

    const r = await w.cli("apply --json");
    expect(r.json.receipt.lines.env.status, r.json.receipt.lines.env.error).toBe("applied");
    expect(w.branches(PR_BRANCH)).toHaveLength(1);
  });
});
