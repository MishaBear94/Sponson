/**
 * A scope's receipt is the only memory of what Sponson created in it (README: "Receipts are the agent's memory";
 * "Destroy is symmetric: removes what Sponson created"). These tests check that the memory survives the ordinary
 * events of a PR's life — a new push, a pending deploy, a failed run, a key removed from `values:` — so that the
 * PR-close destroy still finds everything.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PROD_ENV, Team, sha, teamPlan } from "./team.js";

const PR = { pr: 42, branch: "feat/search" };
let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

describe("lifecycle: the receipt remembers everything the scope created", () => {
  it("a second push (new sha, new preview URL) does not orphan the first push's Clerk redirect: PR-close destroy removes both", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("m1-a");
    const b = sha("m1-b");

    team.deploy(a);
    const ra = await team.cli(["apply"], { ...PR, sha: a });
    expect(ra.json.receipt.status).toBe("complete");
    team.deploy(b);
    const rb = await team.cli(["apply"], { ...PR, sha: b });
    expect(rb.json.receipt.status).toBe("complete");
    // The first push's build predates the first env write, so Sponson triggers one redeploy
    // (`redeployed: true`) and its preview URL is the redeploy's, not Team.previewUrl(a). Use what each run recorded.
    const urlA = ra.json.receipt.lines.env.outputs.preview_url as string;
    const urlB = rb.json.receipt.lines.env.outputs.preview_url as string;
    expect(urlA).toContain(a.slice(0, 8));
    expect(urlB).toBe(Team.previewUrl(b));
    expect(team.apiResources().clerk.map((r) => r.url).sort()).toEqual([urlA, urlB].sort());

    const d = await team.cli(["apply", "--destroy"], { ...PR, sha: b });
    expect(d.code).toBe(0);
    // Expected: nothing Sponson created in pr-42 survives the destroy.
    expect(team.apiResources().clerk.map((r) => r.url), "Clerk redirects left after PR-close destroy").toEqual([]);
  });

  it("closing the PR while the newest push is still deploying does not forget the callback registered for the previous push", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("m2-a");
    const b = sha("m2-b");

    team.deploy(a);
    expect((await team.cli(["apply"], { ...PR, sha: a })).json.receipt.status).toBe("complete");
    // push b; Vercel has not finished building it when the synchronize run applies
    const r = await team.cli(["apply"], { ...PR, sha: b });
    expect(r.json.receipt.status).toBe("partial");
    expect(r.json.receipt.lines.callback.status).toBe("waiting");

    // PR closed before b ever deploys
    await team.cli(["apply", "--destroy"], { ...PR, sha: b });
    expect(team.apiResources().clerk.map((x) => x.url), "callback of the previous push leaked").toEqual([]);
  });

  it("a console hotfix that made apply fail with DRIFT_CHANGED is still protected on the next run (CI re-run / next push)", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("m3-a");
    team.deploy(a);
    expect((await team.cli(["apply"], { ...PR, sha: a })).code).toBe(0);

    team.sim.state.applyChaos({ drift: { "vercel.env.preview.DATABASE_URL": "postgres://hotfix@pooler/neondb" } });
    const first = await team.cli(["apply"], { ...PR, sha: a });
    expect(first.code).toBe(1);
    expect(first.json.receipt.lines.env.errorCode).toBe("DRIFT_CHANGED");

    // Nobody passed --reconcile. The same workflow simply runs again (re-run button, or the next push).
    const second = await team.cli(["apply"], { ...PR, sha: a });
    expect(team.vercelEnv("preview", "DATABASE_URL")[0]?.value, "hotfix silently overwritten without --reconcile").toBe("postgres://hotfix@pooler/neondb");
    expect(second.code).toBe(1);
  });

  it("after a run that failed on one line, PR-close destroy still removes the lines that run skipped", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("m4-a");
    team.deploy(a);
    expect((await team.cli(["apply"], { ...PR, sha: a })).json.receipt.status).toBe("complete");

    // A human edits the preview var in the console; the next run fails on `env` and skips `callback`.
    team.sim.state.applyChaos({ drift: { "vercel.env.preview.DATABASE_URL": "postgres://hotfix@pooler/neondb" } });
    const failed = await team.cli(["apply"], { ...PR, sha: a });
    expect(failed.json.receipt.lines.callback.status).toBe("skipped");

    // PR closed.
    await team.cli(["apply", "--destroy"], { ...PR, sha: a });
    const left = team.apiResources();
    expect({ clerk: left.clerk.map((r) => r.url), vercel: left.vercel.map((e) => e.key), neon: left.neon.map((b) => b.name) }, "resources left after destroy").toEqual({ clerk: [], vercel: [], neon: [] });
  });

  it("a key removed from `values:` mid-PR is tracked (orphan, not 'unmanaged') and removed by the PR-close destroy", async () => {
    team = await Team.create({ plan: teamPlan({ previewValues: { FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" } }), env: PROD_ENV });
    const a = sha("m5-a");
    const b = sha("m5-b");
    team.deploy(a);
    expect((await team.cli(["apply"], { ...PR, sha: a })).json.receipt.status).toBe("complete");

    // Next push drops SEARCH_INDEX from the plan.
    await team.writePlan(teamPlan({ previewValues: { FEATURE_SEARCH: "on" } }));
    team.deploy(b);
    expect((await team.cli(["apply"], { ...PR, sha: b })).code).toBe(0);

    const plan = await team.cli(["plan"], { ...PR, sha: b });
    const drift = (plan.json.drift as Array<{ kind: string; resource: { key: string } }>).find((d) => d.resource.key === "env:preview:feat/search:SEARCH_INDEX" /* v0.2 key: env:<target>:<gitBranch|*>:<KEY> */);
    expect(drift?.kind, "SEARCH_INDEX was created by Sponson in this scope; plan calls it").toBe("orphan");

    await team.cli(["apply", "--destroy"], { ...PR, sha: b });
    expect(team.vercelEnv("preview", "SEARCH_INDEX").map((e) => e.gitBranch), "SEARCH_INDEX leaked after destroy").toEqual([]);
  });
});
