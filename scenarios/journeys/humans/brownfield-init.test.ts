/**
 * Brownfield adoption: a project that already has preview/production vars, Neon branches and Clerk URLs,
 * then `sponson init` (no plan → plan → --adopt) and plan/apply/destroy on top.
 *
 * Expectations: init is import (it makes the plan catch up with reality;
 * unmanaged things are never touched; adopted things are never destroyed) and README ("Run again to adopt
 * resources the plan does not know about").
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SimSeed } from "@sponson/sim";
import { Journey, driftKinds, receiptLine } from "./harness.js";

let j: Journey | undefined;
afterEach(async () => {
  await j?.close();
  j = undefined;
});

/** 15 env vars: 5 project-wide preview, 5 branch-scoped preview for this PR's branch, 5 production. */
function brownfield(): Partial<SimSeed> {
  const envs: Array<{ key: string; value: string; target: string; gitBranch?: string }> = [];
  for (const k of ["NEXT_PUBLIC_SITE", "SENTRY_DSN", "LOG_LEVEL", "STRIPE_PUBLISHABLE", "ANALYTICS_ID"]) envs.push({ key: k, value: `shared-${k}-value`, target: "preview" });
  for (const k of ["FEATURE_FLAGS", "API_BASE", "DEBUG", "PREVIEW_BANNER", "SEED_USERS"]) envs.push({ key: k, value: `branch-${k}-value`, target: "preview", gitBranch: "feat/x" });
  for (const k of ["DATABASE_URL", "STRIPE_KEY", "SENTRY_DSN", "LOG_LEVEL", "NEXT_PUBLIC_SITE"]) envs.push({ key: k, value: `prod-${k}-value`, target: "production" });
  return {
    vercel: { projects: { prj_demo: { envs } } },
    neon: { projects: { proj_demo: { branches: [{ name: "main" }, { name: "dev", parent: "main" }, { name: "sponson/preview/legacy-qa", parent: "main" }] } } },
    clerk: { redirect_urls: ["https://myapp.com/sso-callback", "https://staging.myapp.com/sso-callback"] },
  };
}

const ALL_VALUES = () =>
  brownfield()
    .vercel!.projects.prj_demo!.envs.map((e) => e.value);

const PLAN_WITH_COMMENTS = `# Release plan for the checkout service.
# Owner: payments team. Do not reorder without telling #release.
version: 1
environments: [preview, production]
receipts: local
providers:
  vercel: { project: prj_demo }   # linked via .vercel/project.json
  neon: { project: proj_demo }
  clerk: {}

changes:
  # The per-PR database. Parent is main so migrations run against real-ish data.
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]

  # Vars the app needs per preview.
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }  # never a literal
    environments: [preview]

  - id: callback
    adapter: clerk
    op: redirect_allow
    url: "https://myapp.com/sso-callback"   # shared by every preview
# trailing note: production lines live in release.production.yaml
`;

describe("brownfield init", () => {
  it("init three times on a brownfield project is idempotent and never writes a value into the plan", async () => {
    j = await Journey.start(brownfield());
    const r1 = await j.init();
    expect(r1.code).toBe(0);
    const r2 = await j.init();
    expect(r2.code).toBe(0);
    const after2 = await j.readPlan();
    const r3 = await j.init();
    expect(r3.code).toBe(0);
    expect(r3.stdout).toMatch(/Nothing to adopt/);
    expect(await j.readPlan(), "third init must not touch the file").toBe(after2);
    const r4 = await j.init();
    expect(await j.readPlan()).toBe(after2);
    expect(r4.code).toBe(0);
    // values are references, never copies
    for (const v of ALL_VALUES()) expect(after2, `value ${v} leaked into the plan`).not.toContain(v);
    // the branch-scoped preview vars were adopted as `{ keep: true }` (v2: existence, not value)
    for (const k of ["FEATURE_FLAGS", "API_BASE", "DEBUG", "PREVIEW_BANNER", "SEED_USERS"]) expect(after2).toMatch(new RegExp(`${k}:\\s*\\{\\s*keep: true`));
    // nothing in the cloud changed: init writes the plan file only
    expect(j.state.writes).toHaveLength(0);
  });

  it("init adopts the project-wide preview vars that every preview deployment actually gets", async () => {
    // README: "Run again to adopt resources the plan does not know about." Five preview vars with no git branch
    // are the most common kind on a real project; they are in the preview environment the plan targets.
    j = await Journey.start(brownfield());
    await j.init();
    await j.init();
    const p = await j.plan();
    const plan = await j.readPlan();
    // v2: adopted values are `{ keep: true }` (never a copied value or a made-up env reference), and
    // project-wide vars are adopted into a `branch: "*"` line so they stay project-wide.
    const shared = plan.slice(plan.indexOf('branch: "*"') >= 0 ? plan.lastIndexOf("- id:", plan.indexOf('branch: "*"')) : plan.length);
    const visible = ["NEXT_PUBLIC_SITE", "SENTRY_DSN", "LOG_LEVEL", "STRIPE_PUBLISHABLE", "ANALYTICS_ID"].filter(
      (k) => new RegExp(`${k}:\\s*\\{\\s*keep: true`).test(shared) || driftKinds(p).some((d) => d.endsWith(`:env:preview:*:${k}`)),
    );
    expect(driftKinds(p).filter((d) => d.startsWith("unmanaged:")), "a third look still finds things to adopt").toEqual([]);
    expect(visible, "project-wide preview vars are neither adopted nor even reported as unmanaged").toEqual(["NEXT_PUBLIC_SITE", "SENTRY_DSN", "LOG_LEVEL", "STRIPE_PUBLISHABLE", "ANALYTICS_ID"]);
  });

  it("init keeps the human's comments and leaves existing lines byte-for-byte untouched", async () => {
    j = await Journey.start(brownfield(), PLAN_WITH_COMMENTS);
    const r = await j.init();
    expect(r.code).toBe(0);
    const after = await j.readPlan();
    for (const c of ["# Release plan for the checkout service.", "# Owner: payments team.", "# linked via .vercel/project.json", "# The per-PR database.", "# Vars the app needs per preview.", "# never a literal", "# shared by every preview", "# trailing note"]) {
      expect(after, `comment lost: ${c}`).toContain(c);
    }
    // Running init again with a plan appends unmanaged resources as new lines and leaves existing lines alone.
    const humanPart = PLAN_WITH_COMMENTS.split("# trailing note")[0]!;
    expect(after.startsWith(humanPart), `existing lines were rewritten:\n${after}`).toBe(true);
    // and the Clerk URL a human added in the console was adopted, as a reference to itself
    expect(after).toContain("https://staging.myapp.com/sso-callback");
  });

  it("init adopts a Neon branch a human made outside the sponson/ prefix when asked by name", async () => {
    // Brownfield: the team's long-lived `dev` branch. `init --adopt <name>` is the documented way to take one thing over.
    j = await Journey.start(brownfield(), PLAN_WITH_COMMENTS);
    const r = await j.init("--adopt", "branch:dev");
    expect(r.code, r.stderr).toBe(0);
    expect(await j.readPlan()).toMatch(/name: dev/);
  });

  it("after init adopts, plan reports the adopted lines as unchanged and apply leaves their values alone", async () => {
    // Adoption means "the plan caught up with reality": the very next plan must not propose to rewrite 5 vars,
    // and apply must not fail or overwrite them because a CI env var with the same name is absent or different.
    j = await Journey.start(brownfield(), PLAN_WITH_COMMENTS);
    await j.init();
    const p = await j.plan();
    const adopted = (p.json.lines as Array<{ id: string; adapter: string; status: string }>).filter((l) => l.id.startsWith("env-"));
    expect(adopted.length).toBeGreaterThan(0);
    for (const l of adopted) expect(l.status, `adopted line ${l.id} right after init`).toBe("unchanged");

    j.env.FEATURE_FLAGS = "ci-has-a-different-value";
    const a = await j.apply();
    expect(a.code, a.stdout).toBe(0);
    expect(j.branchEnv("FEATURE_FLAGS")[0]?.value, "adopted value was overwritten by apply").toBe("branch-FEATURE_FLAGS-value");
    expect(j.branchEnv("API_BASE")[0]?.value).toBe("branch-API_BASE-value");
  });

  it("adopted resources survive destroy; only what Sponson created goes", async () => {
    j = await Journey.start(brownfield(), PLAN_WITH_COMMENTS);
    await j.init();
    // make the adopted secret refs resolvable with the exact live values so apply is a no-op on them
    // v0.2: Vercel listScope covers this branch's vars plus project-wide preview vars, so init adopts both kinds.
    for (const e of j.envs()) if (e.target.includes("preview") && (e.gitBranch === "feat/x" || !e.gitBranch)) j.env[e.key] = e.value;
    const a = await j.apply();
    expect(a.code, JSON.stringify(a.json?.receipt?.lines)).toBe(0);
    for (const id of Object.keys(a.json.receipt.lines)) if (id !== "db" && id !== "env") expect(receiptLine(a, id).createdBy, id).toBe("adopted");
    const d = await j.destroy();
    expect(d.code).toBe(0);
    // Sponson's own branch and DATABASE_URL are gone
    expect(j.branchNamed("sponson/preview/pr-42")).toHaveLength(0);
    expect(j.branchEnv("DATABASE_URL")).toHaveLength(0);
    // everything that existed before is still there
    for (const e of brownfield().vercel!.projects.prj_demo!.envs) {
      expect(j.envs().some((x) => x.key === e.key && x.target.includes(e.target) && x.value === e.value), `${e.target}/${e.key}`).toBe(true);
    }
    for (const n of ["main", "dev", "sponson/preview/legacy-qa"]) expect(j.branchNamed(n), n).toHaveLength(1);
    for (const u of ["https://myapp.com/sso-callback", "https://staging.myapp.com/sso-callback"]) expect(j.redirects().some((r) => r.url === u), u).toBe(true);
  });

  it("init in one PR does not adopt another PR's preview branch into the shared plan (zombie branch)", async () => {
    // PR 41 and PR 42 are both open; both used Sponson. The plan file is shared by every PR.
    j = await Journey.start(undefined, PLAN_WITH_COMMENTS);
    j.ctx.pr = 41;
    j.ctx.branch = "feat/41";
    expect((await j.apply()).code).toBe(0);
    j.ctx.pr = 42;
    j.ctx.branch = "feat/x";
    expect((await j.apply()).code).toBe(0);
    // a human in PR 42 runs init to pick up something they added by hand
    await j.init();
    // PR 41 merges; its workflow destroys its scope
    j.ctx.pr = 41;
    j.ctx.branch = "feat/41";
    expect((await j.destroy()).code).toBe(0);
    expect(j.branchNamed("sponson/preview/pr-41")).toHaveLength(0);
    // PR 42 pushes again
    j.ctx.pr = 42;
    j.ctx.branch = "feat/x";
    const a = await j.apply();
    expect(a.code).toBe(0);
    expect(j.branchNamed("sponson/preview/pr-41"), "PR 42 resurrected PR 41's database branch").toHaveLength(0);
  });
});
