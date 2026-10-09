/**
 * Vercel deployments as the real API reports them: QUEUED → BUILDING → READY (or ERROR / CANCELED), builds that
 * outlast SPONSON_DEPLOY_TIMEOUT_MS, and a flaky status endpoint while Sponson watches for the deploy event.
 * The sim answers POST /v13/deployments with READY at once (assumption 6 in sim/server.ts); the proxy rewrites
 * states to give the deployment a lifecycle.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isPath, THREE_LINE_PLAN, World, type Upstream } from "./harness.js";

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

const DEPLOY_PLAN = `version: 1
providers:
  vercel: { project: prj_demo }
changes:
  - id: deploy
    adapter: vercel
    op: deploy
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: deploy.preview_url }
`;

/** Rewrite every deployment state the client sees through `stateFor(createdAt)`. */
function lifecycle(world: World, stateFor: (ageMs: number, real: string) => string) {
  const rewrite = (u: Upstream, field: "readyState" | "state"): Upstream => {
    if (u.status !== 200) return u;
    const b = JSON.parse(u.body);
    const fix = (d: Record<string, unknown>) => {
      d[field] = stateFor(Date.now() - Number(d.createdAt), String(d[field]));
    };
    if (Array.isArray(b.deployments)) b.deployments.forEach(fix);
    else fix(b);
    return { ...u, body: JSON.stringify(b) };
  };
  world.proxy.on(isPath("POST", /^\/vercel\/v13\/deployments$/), () => ({ rewrite: (u) => rewrite(u, "readyState") }));
  world.proxy.on(isPath("GET", /^\/vercel\/v13\/deployments\/[^/]+$/), () => ({ rewrite: (u) => rewrite(u, "readyState") }));
  world.proxy.on(isPath("GET", /^\/vercel\/v6\/deployments$/), () => ({ rewrite: (u) => rewrite(u, "state") }));
}

describe("deployment lifecycle", () => {
  it("explicit deploy op follows QUEUED → BUILDING → READY and feeds preview_url to the callback (passes)", async () => {
    w = await World.create({ plan: DEPLOY_PLAN });
    w.sim.state.applyChaos({ deploy: "never" }); // team turned off auto preview deploys (决策-执行模型 决定 D)
    lifecycle(w, (age, real) => (real !== "READY" ? real : age < 300 ? "QUEUED" : age < 700 ? "BUILDING" : "READY"));

    const r = await w.cli("apply --json");
    expect(r.json.receipt.status, JSON.stringify(r.json.receipt.lines)).toBe("complete");
    expect(r.json.receipt.lines.callback.status).toBe("applied");
    expect(w.redirects()).toHaveLength(1);
    expect(w.redirects()[0]!.url).toMatch(/^https:\/\/prj_demo-01234567\.vercel\.app$/);
    expect(w.deployments()).toHaveLength(1);
  });

  it("a build that outlasts SPONSON_DEPLOY_TIMEOUT_MS: re-running apply while it is still BUILDING watches that deployment instead of starting a second build of the same sha", async () => {
    w = await World.create({ plan: DEPLOY_PLAN, env: { SPONSON_DEPLOY_TIMEOUT_MS: "300" } });
    w.sim.state.applyChaos({ deploy: "never" });
    lifecycle(w, (_age, real) => (real === "READY" ? "BUILDING" : real)); // a 5-minute Next.js build, from our point of view

    const r1 = await w.cli("apply --json");
    expect(r1.exit).toBe(1);
    expect(r1.json.receipt.lines.deploy.error).toMatch(/not ready after 300ms/);
    expect(w.deployments()).toHaveLength(1);

    const r2 = await w.cli("apply --json");
    expect(r2.exit).toBe(1);
    expect(w.deployments(), "second apply triggered a duplicate build for the same sha").toHaveLength(1);
  });

  it("one 502 from the deployment list while checking for the deploy event leaves the run partial (still waiting), not failed with the callback skipped", async () => {
    w = await World.create({ plan: THREE_LINE_PLAN });
    // 1st GET /v6/deployments: vercel.env's redeploy check after the upsert. 2nd: awaitExternal for `callback`.
    let n = 0;
    w.proxy.on(isPath("GET", /^\/vercel\/v6\/deployments$/), () => (++n === 2 ? { status: 502, headers: { "content-type": "text/html" }, body: "<html>502 Bad Gateway</html>" } : undefined));

    const r = await w.cli("apply --json");
    expect(r.json.receipt.lines.env.status).toBe("applied");
    expect(["waiting", "applied"], `callback: ${JSON.stringify(r.json.receipt.lines.callback)}`).toContain(r.json.receipt.lines.callback.status);
    expect(r.json.receipt.status).not.toBe("failed");
    expect(r.exit).toBe(0);
  });
});
