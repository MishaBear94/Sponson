/**
 * Long single-PR journeys driven directly through the CLI (the way the action calls it: explicit --pr/--branch/--sha):
 * the plan file is edited on almost every push, deploys arrive late, twice, and out of order, the close-time destroy
 * fails once and is retried, the PR is reopened. After every step the receipts are cross-checked against the cloud.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PROD_ENV, Team, sha, teamPlan, type CliResult } from "./team.js";

let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

const PR = { pr: 42, branch: "feat/search" };

class Log {
  problems: string[] = [];
  check(step: string, ok: boolean, what: string) {
    if (!ok) this.problems.push(`${step}: ${what}`);
  }
  async consistent(step: string, t: Team) {
    for (const p of await t.receiptsVsReality()) this.problems.push(`${step}: ${p}`);
  }
}

const st = (r: CliResult) => r.json?.receipt?.status ?? r.json?.error?.code ?? `exit ${r.exit}`;

describe("lifecycle journeys: one PR, many pushes", () => {
  it("plan edited on every push (add, change, rename id, move a line to production, remove, secret rotation), deploy reported twice, then closed", async () => {
    team = await Team.create({ env: { ...PROD_ENV, STRIPE_TEST_KEY: "fake_ts_first_51Habc" } });
    const log = new Log();
    const push = async (label: string, plan: string, opts: { deploy?: boolean } = {}) => {
      const s = sha(label);
      await team!.writePlan(plan);
      const sync = await team!.cli(["apply"], { ...PR, sha: s }); // pull_request: synchronize
      let ds: CliResult | null = null;
      if (opts.deploy !== false) {
        team!.deploy(s);
        ds = await team!.cli(["apply"], { ...PR, sha: s }); // deployment_status: success
        const again = await team!.cli(["apply"], { ...PR, sha: s }); // ... delivered twice
        log.check(label, again.writes.length === 0, `repeated deployment_status performed writes: ${JSON.stringify(again.writes)}`);
      }
      await log.consistent(label, team!);
      return { s, sync, ds };
    };
    const flags = (envs: string, target: string) => `  - id: flags
    adapter: vercel
    op: env
    target: ${target}
    values:
      BETA_BANNER: "true"
    environments: ${envs}
`;

    // 1 opened
    let r = await push("p1-open", teamPlan({ previewValues: { FEATURE_SEARCH: "on" } }));
    log.check("p1", st(r.ds!) === "complete", `deployment_status run ${st(r.ds!)}`);
    // 2 add a key and a secret
    r = await push("p2-add", teamPlan({ previewValues: { FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v1" }, extra: "" }).replace('      SEARCH_INDEX: "products_v1"\n', '      SEARCH_INDEX: "products_v1"\n      STRIPE_KEY: { secret: "env://STRIPE_TEST_KEY" }\n'));
    log.check("p2", team.vercelEnv("preview", "STRIPE_KEY", "feat/search")[0]?.value === "fake_ts_first_51Habc", "STRIPE_KEY not injected");
    // 3 change a value
    const withSecret = (v: Record<string, string>, id?: string, extra = "") =>
      teamPlan({ previewValues: v, envId: id, extra }).replace("      DATABASE_URL: { from: db.connection_string }\n", '      DATABASE_URL: { from: db.connection_string }\n      STRIPE_KEY: { secret: "env://STRIPE_TEST_KEY" }\n');
    r = await push("p3-change", withSecret({ FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" }));
    log.check("p3", team.vercelEnv("preview", "SEARCH_INDEX", "feat/search")[0]?.value === "products_v2", "SEARCH_INDEX not updated");
    // 4 rename the env line `env` -> `vars` (callback follows)
    r = await push("p4-rename", withSecret({ FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" }, "vars"));
    log.check("p4", team.vercelEnv("preview", "SEARCH_INDEX").length === 1 && team.apiResources().neon.length === 1, "rename duplicated resources");
    const p4 = await team.receipt("preview", "pr-42");
    log.check("p4", (p4?.lines.vars?.resources ?? []).every((x) => x.createdBy === "sponson"), `after rename, receipt calls Sponson-created vars ${JSON.stringify(p4?.lines.vars?.resources.map((x) => `${x.key}:${x.createdBy}`))}`);
    // 5 add a flags line, then move it to production
    r = await push("p5-flags", withSecret({ FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" }, "vars", flags("[preview]", "preview")));
    log.check("p5", team.vercelEnv("preview", "BETA_BANNER", "feat/search").length === 1, "BETA_BANNER not created");
    r = await push("p6-move", withSecret({ FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" }, "vars", flags("[production]", "production")));
    log.check("p6", team.vercelEnv("production", "BETA_BANNER").length === 0, "a preview run wrote the production flag");
    // 7 remove a key
    r = await push("p7-remove", withSecret({ FEATURE_SEARCH: "on" }, "vars", flags("[production]", "production")));
    // 8 the test Stripe key is rotated in the secret store; the next push picks it up
    team.baseEnv.STRIPE_TEST_KEY = "fake_ts_second_51Hxyz";
    r = await push("p8-rotate", withSecret({ FEATURE_SEARCH: "on" }, "vars", flags("[production]", "production")));
    log.check("p8", team.vercelEnv("preview", "STRIPE_KEY", "feat/search")[0]?.value === "fake_ts_second_51Hxyz", "rotated secret not applied");
    log.check("p8", !JSON.stringify(r.sync.json).includes("fake_ts_"), "secret value in JSON output");

    // closed
    const d = await team.cli(["apply", "--destroy"], { ...PR, sha: r.s });
    log.check("close", st(d) === "complete", `destroy ${st(d)}`);
    const left = team.apiResources();
    log.check("close", left.neon.length + left.vercel.length + left.clerk.length === 0, `left after destroy: ${JSON.stringify({ neon: left.neon.map((b) => b.name), vercel: left.vercel.map((e) => `${e.key}@${e.target}/${e.gitBranch}`), clerk: left.clerk.map((c) => c.url) })}`);

    expect(log.problems).toEqual([]);
  });

  it("deploys out of order: late build of an old push, deployment_status before the synchronize run, a force-push, a failing destroy retried, a reopen", async () => {
    team = await Team.create({ env: PROD_ENV });
    const log = new Log();
    const planOn = teamPlan({ previewValues: { FEATURE_SEARCH: "on", CACHE_TTL: "60" } });
    const planOff = teamPlan({ previewValues: { FEATURE_SEARCH: "off", CACHE_TTL: "60" } });
    const planTtl = teamPlan({ previewValues: { FEATURE_SEARCH: "off", CACHE_TTL: "300" } });
    const [a1, a2, a3, a4] = ["oo-a1", "oo-a2", "oo-a3", "oo-a4"].map(sha) as [string, string, string, string];
    const apply = async (s: string, plan: string) => {
      await team!.writePlan(plan);
      return team!.cli(["apply"], { ...PR, sha: s });
    };

    // a1 opened, a2 pushed before a1 ever deployed
    log.check("a1 opened", st(await apply(a1, planOn)) === "partial", "not partial");
    log.check("a2 sync", st(await apply(a2, planOff)) === "partial", "not partial");
    // a2's build finishes first
    team.deploy(a2);
    log.check("a2 deployed", st(await apply(a2, planOff)) === "complete", "not complete");
    // then a1's build finishes; its deployment_status run checks out a1
    team.deploy(a1);
    await apply(a1, planOn);
    log.check("a1 late", team.vercelEnv("preview", "FEATURE_SEARCH", "feat/search")[0]?.value === "off", "late a1 event reverted FEATURE_SEARCH to a1's value");
    await log.consistent("a1 late", team);

    // force-push a3 (rebase); Vercel is fast: deployment_status arrives before the synchronize run
    team.deploy(a3);
    log.check("a3 ds-first", st(await apply(a3, planTtl)) === "complete", "deployment_status-first run not complete");
    const sync = await apply(a3, planTtl);
    log.check("a3 sync", sync.writes.length === 0, `late synchronize run wrote ${JSON.stringify(sync.writes)}`);
    log.check("a3", team.vercelEnv("preview", "CACHE_TTL", "feat/search")[0]?.value === "300", "CACHE_TTL not 300");
    await log.consistent("a3", team);

    // closed; Neon is having a bad minute: the branch delete fails once
    team.sim.state.applyChaos({ fail_next: 1, fail_on: "DELETE /neon/*", status: 500 });
    const d1 = await team.cli(["apply", "--destroy"], { ...PR, sha: a3 });
    log.check("close#1", st(d1) === "failed" && d1.json.receipt.lines.db.status === "destroy_failed", `first destroy ${st(d1)}`);
    // the team re-runs the closed workflow
    const d2 = await team.cli(["apply", "--destroy"], { ...PR, sha: a3 });
    log.check("close#2", st(d2) === "complete", `retried destroy ${st(d2)}`);
    let left = team.apiResources();
    log.check("close#2", left.neon.length + left.vercel.length + left.clerk.length === 0, `left after retried destroy: ${JSON.stringify({ neon: left.neon.map((b) => b.name), vercel: left.vercel.map((e) => e.key), clerk: left.clerk.map((c) => c.url) })}`);

    // reopened and pushed again: from zero, no "receipt not found"
    team.deploy(a4);
    const re = await apply(a4, planTtl);
    log.check("reopen", st(re) === "complete" && re.json.receipt.lines.db.status === "applied", `reopen apply ${st(re)} db=${re.json?.receipt?.lines?.db?.status}`);
    await log.consistent("reopen", team);
    const d3 = await team.cli(["apply", "--destroy"], { ...PR, sha: a4 });
    left = team.apiResources();
    log.check("close#3", st(d3) === "complete" && left.neon.length + left.vercel.length + left.clerk.length === 0, `final destroy ${st(d3)}, left ${JSON.stringify(left)}`);

    expect(log.problems).toEqual([]);
  });

  // No callback line here: per-push Clerk URLs are covered by receipt-memory.test.ts; this journey is about reopen.
  it("closed without its destroy, main moves on, reopened weeks later: the old preview is picked up again (not duplicated) and the eventual destroy removes it", async () => {
    team = await Team.create({ plan: teamPlan({ callback: false }), env: PROD_ENV });
    const log = new Log();
    const a = sha("cl-a");
    team.deploy(a);
    log.check("open", st(await team.cli(["apply"], { ...PR, sha: a })) === "complete", "open not complete");
    // closed; the destroy job never ran. Main moves on: production applied twice in the meantime.
    for (const [i, m] of [sha("cl-m1"), sha("cl-m2")].entries()) {
      const p = await team.cli(["apply", "--approved-by", "lead-alice"], { env: "production", pr: null, branch: "main", sha: m });
      log.check(`main#${i + 1}`, st(p) === "complete", `production ${st(p)}`);
    }
    // the plan of the abandoned scope is still visible to anyone who looks
    const plan = await team.cli(["plan"], { ...PR, sha: a });
    log.check("idle", plan.json.lines.every((l: { status: string }) => l.status === "unchanged"), `plan of the idle scope: ${JSON.stringify(plan.json.lines.map((l: { id: string; status: string }) => `${l.id}:${l.status}`))}`);
    // reopened with a rebase
    const b = sha("cl-b");
    team.deploy(b);
    const re = await team.cli(["apply"], { ...PR, sha: b });
    log.check("reopen", st(re) === "complete" && re.json.receipt.lines.db.status === "unchanged", `reopen ${st(re)} db=${re.json?.receipt?.lines?.db?.status}`);
    log.check("reopen", team.apiResources().neon.length === 1, "duplicate Neon branch after reopen");
    await log.consistent("reopen", team);
    // closed for good, and this time the destroy runs
    await team.cli(["apply", "--destroy"], { ...PR, sha: b });
    const left = team.apiResources();
    log.check("close", left.neon.length === 0 && left.vercel.every((e) => e.target === "production"), `left ${JSON.stringify({ neon: left.neon.map((x) => x.name), vercel: left.vercel.filter((e) => e.target !== "production").map((e) => e.key) })}`);
    log.check("close", left.clerk.map((c) => c.url).join() === "https://app.example.com/sso-callback", `clerk left ${JSON.stringify(left.clerk.map((c) => c.url))}`);
    const prodReceipt = await team.receipt("production", "main");
    log.check("close", prodReceipt?.status === "complete" && team.vercelEnv("production", "DATABASE_URL")[0]?.value === PROD_ENV.PROD_DATABASE_URL, "production disturbed by the PR's lifecycle");

    expect(log.problems).toEqual([]);
  });
});
