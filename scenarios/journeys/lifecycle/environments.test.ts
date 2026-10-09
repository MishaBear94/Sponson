/**
 * Two environments in one plan. Production needs a human (README: "`--env production` without `--approved-by` is
 * refused before any adapter is touched"; 验收策略 invariant 7: "无 --env production + 审批标记时，production 目标零写入").
 * A PR's preview run and a PR's destroy must never write to the production target, whatever a line says.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PROD_ENV, Team, sha, teamPlan } from "./team.js";

let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

function productionEnvs(t: Team) {
  return Object.values(t.sim.state.vercel.projects)
    .flatMap((p) => p.envs)
    .filter((e) => e.target.includes("production"))
    .map((e) => `${e.key}=${e.value}`)
    .sort();
}

describe("lifecycle: preview runs never touch production", () => {
  it("a PR adds a `target: production` line but forgets `environments: [production]`: the unapproved preview run and the PR-close destroy leave production alone", async () => {
    team = await Team.create({
      seed: { vercel: { projects: { prj_demo: { envs: [{ key: "FEATURE_SEARCH", value: "off", target: "production" }] } } } },
      plan: teamPlan({
        extra: `  - id: launch-flags
    adapter: vercel
    op: env
    target: production
    values:
      FEATURE_SEARCH: "on"
      SEARCH_INDEX: "products_v2"
`,
      }),
      env: PROD_ENV,
    });
    const before = productionEnvs(team);
    const a = sha("env-a");
    team.deploy(a);

    // pull_request: opened — preview, no approval anywhere
    const r = await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: a });
    expect(productionEnvs(team), `preview run (exit ${r.exit}) wrote to production`).toEqual(before);

    // pull_request: closed
    await team.cli(["apply", "--destroy"], { pr: 42, branch: "feat/search", sha: a });
    expect(productionEnvs(team), "PR-close destroy changed production").toEqual(before);
  });

  it("main's production apply and an open PR's preview coexist: neither run changes the other's resources", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("env2-a");
    const m = sha("env2-main");
    team.deploy(a);
    expect((await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: a })).json.receipt.status).toBe("complete");
    const previewBefore = team.apiResources();

    // production without approval: refused, zero writes
    const refused = await team.cli(["apply"], { env: "production", pr: null, branch: "main", sha: m });
    expect(refused.exit).toBe(2);
    expect(refused.writes).toEqual([]);

    const prod = await team.cli(["apply", "--approved-by", "alice"], { env: "production", pr: null, branch: "main", sha: m });
    expect(prod.json.receipt.status).toBe("complete");
    expect(prod.json.receipt.scope).toBe("main");
    expect(team.vercelEnv("production", "DATABASE_URL")[0]?.value).toBe(PROD_ENV.PROD_DATABASE_URL);

    // PR closes: preview gone, production intact
    const prodBefore = productionEnvs(team);
    await team.cli(["apply", "--destroy"], { pr: 42, branch: "feat/search", sha: a });
    expect(productionEnvs(team)).toEqual(prodBefore);
    expect(team.apiResources().neon).toEqual([]);
    expect(team.apiResources().clerk.map((c) => c.url)).toEqual(["https://app.example.com/sso-callback"]);
    expect(previewBefore.neon.length).toBe(1);
  });

  it("two PRs interleaved over two days (open, push, deploy, close in mixed order): each destroy removes exactly its own preview", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const p42 = { pr: 42, branch: "feat/search" };
    const p43 = { pr: 43, branch: "feat/billing" };
    const [a1, b1, a2] = ["il-a1", "il-b1", "il-a2"].map(sha) as [string, string, string];
    await team.cli(["apply"], { ...p42, sha: a1 });
    await team.cli(["apply"], { ...p43, sha: b1 });
    team.deploy(b1);
    expect((await team.cli(["apply"], { ...p43, sha: b1 })).json.receipt.status).toBe("complete");
    // PR 42's first push never deployed (cancelled by the second push), the second one does
    await team.writePlan(teamPlan({ previewValues: { FEATURE_SEARCH: "on" } }));
    await team.cli(["apply"], { ...p42, sha: a2 });
    team.deploy(a2);
    expect((await team.cli(["apply"], { ...p42, sha: a2 })).json.receipt.status).toBe("complete");
    const before43 = team.apiResources();

    await team.cli(["apply", "--destroy"], { ...p42, sha: a2 });
    const after = team.apiResources();
    expect(after.neon.map((b) => b.name)).toEqual(["sponson/preview/pr-43"]);
    expect(after.vercel.map((e) => `${e.key}@${e.gitBranch}`).sort()).toEqual(["DATABASE_URL@feat/billing", "FEATURE_SEARCH@feat/billing"]);
    expect(after.clerk.map((c) => c.url)).toEqual([Team.previewUrl(b1)]);
    expect(after.vercel.find((e) => e.key === "DATABASE_URL")?.value).toBe(before43.vercel.find((e) => e.key === "DATABASE_URL" && e.gitBranch === "feat/billing")?.value);
    expect(await team.receiptsVsReality()).toEqual([]);

    await team.cli(["apply", "--destroy"], { ...p43, sha: b1 });
    const none = team.apiResources();
    expect(none.neon.length + none.vercel.length + none.clerk.length).toBe(0);
  });
});
