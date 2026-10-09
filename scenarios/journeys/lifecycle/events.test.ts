/**
 * Events arrive late, out of order, twice, and for commits that are no longer the PR head. The documented CI
 * (action/README.md + action/action.yml) turns every one of them into `sponson apply`. These tests check the cloud
 * a team would look at afterwards.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeGitHub, PROD_ENV, PreviewWorkflow, TOKENS, Team, documentedWorkflow, sha, teamPlan } from "./team.js";

let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

const PR = { pr: 42, branch: "feat/search" };

describe("lifecycle: late and out-of-order events", () => {
  it("a stale deployment_status for an older push does not roll the preview back to that commit's plan", async () => {
    team = await Team.create({ env: PROD_ENV });
    const a = sha("ev1-a");
    const b = sha("ev1-b");
    const planA = teamPlan({ previewValues: { FEATURE_SEARCH: "on" } });
    const planB = teamPlan({ previewValues: { FEATURE_SEARCH: "off" } });

    await team.writePlan(planA);
    expect((await team.cli(["apply"], { ...PR, sha: a })).json.receipt.status).toBe("partial"); // opened
    await team.writePlan(planB);
    expect((await team.cli(["apply"], { ...PR, sha: b })).json.receipt.status).toBe("partial"); // synchronize
    team.deploy(b);
    expect((await team.cli(["apply"], { ...PR, sha: b })).json.receipt.status).toBe("complete"); // deployment_status b
    expect(team.vercelEnv("preview", "FEATURE_SEARCH")[0]?.value).toBe("off");

    // Vercel finishes the older build afterwards; its deployment_status run checks out commit a.
    team.deploy(a);
    await team.writePlan(planA);
    const late = await team.cli(["apply"], { ...PR, sha: a });

    expect(
      {
        FEATURE_SEARCH: team.vercelEnv("preview", "FEATURE_SEARCH")[0]?.value,
        receiptSha: (await team.receipt("preview", "pr-42"))?.ctx.git.sha === b ? "b (newest)" : "a (stale)",
        redeploys: late.writes.filter((w) => w.path.includes("/v13/deployments")).length,
      },
      "a stale event reverted the preview to commit a's plan / rewrote the receipt as of a / redeployed a",
    ).toEqual({ FEATURE_SEARCH: "off", receiptSha: "b (newest)", redeploys: 0 });
  });

  it("the documented workflow: production deploy of the merge commit does not resurrect the merged PR's destroyed preview", async () => {
    team = await Team.create({ env: PROD_ENV });
    const gh = new FakeGitHub();
    const wf = new PreviewWorkflow(team, gh);
    const plan = teamPlan();
    const a = gh.commit("ev2-pr42-a", plan);
    const m1 = gh.commit("ev2-main-m1", plan);

    const pr = gh.open(42, "feat/search", a);
    await wf.fire({ name: "pull_request", action: "opened", pr });
    team.deploy(a);
    await wf.fire({ name: "deployment_status", sha: a, ref: "feat/search", environment: "Preview", state: "success" });
    expect(team.apiResources().neon.map((b) => b.name)).toEqual(["sponson/preview/pr-42"]);

    gh.close(42, { mergeSha: m1 });
    const destroyed = await wf.fire({ name: "pull_request", action: "closed", pr: gh.prs.get(42)! });
    expect(destroyed?.json.receipt.status).toBe("complete");
    expect(team.apiResources().neon).toEqual([]);

    expect((await wf.production(m1, "alice", PROD_ENV)).json.receipt.status).toBe("complete");
    team.deploy(m1);
    await wf.fire({ name: "deployment_status", sha: m1, ref: "main", environment: "Production", state: "success" });

    const left = team.apiResources();
    expect(
      { neon: left.neon.map((b) => b.name), preview: left.vercel.filter((e) => e.target === "preview").map((e) => `${e.key}@${e.gitBranch}`), clerk: left.clerk.map((c) => c.url) },
      `preview resources after the merge (runs: ${wf.runs.map((r) => `${r.event}->${r.command} pr=${r.scope.pr} branch=${r.scope.branch}`).join("; ")})`,
    ).toEqual({ neon: [], preview: [], clerk: ["https://app.example.com/sso-callback"] });
  });

  it("the documented workflow: a preview build that finishes after the PR was closed does not recreate its preview", async () => {
    team = await Team.create({ env: PROD_ENV });
    const gh = new FakeGitHub();
    const wf = new PreviewWorkflow(team, gh);
    const a = gh.commit("ev3-a", teamPlan());
    const b = gh.commit("ev3-b", teamPlan());

    const pr = gh.open(42, "feat/search", a);
    await wf.fire({ name: "pull_request", action: "opened", pr });
    team.deploy(a);
    await wf.fire({ name: "deployment_status", sha: a, ref: "feat/search", environment: "Preview", state: "success" });
    await wf.fire({ name: "pull_request", action: "synchronize", pr: gh.push(42, b) });
    // closed (not merged) before b's build finishes
    await wf.fire({ name: "pull_request", action: "closed", pr: gh.close(42) });
    team.deploy(b);
    await wf.fire({ name: "deployment_status", sha: b, ref: "feat/search", environment: "Preview", state: "success" });

    const left = team.apiResources();
    expect({ neon: left.neon.map((x) => x.name), vercel: left.vercel.map((e) => e.key), clerk: left.clerk.map((c) => c.url) }, "a closed PR's preview came back").toEqual({ neon: [], vercel: [], clerk: [] });
  });

  it("the documented workflow's destroy step can actually destroy (it receives the provider tokens)", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const wfDoc = await documentedWorkflow();
    const steps = Object.values(wfDoc.jobs as Record<string, { env?: Record<string, string>; steps: Array<{ with?: { command?: string }; env?: Record<string, string> }> }>).flatMap((j) =>
      j.steps.map((s) => ({ ...s, jobEnv: j.env ?? {} })),
    );
    const destroyStep = steps.find((s) => s.with?.command === "destroy");
    expect(destroyStep, "README workflow has a destroy step").toBeTruthy();
    // Resolve `${{ secrets.X }}` to the token the team stored under X; everything else is passed through.
    const stepEnv: Record<string, string | undefined> = { VERCEL_TOKEN: undefined, NEON_API_KEY: undefined, CLERK_SECRET_KEY: undefined };
    for (const [k, v] of Object.entries({ ...(wfDoc.env ?? {}), ...destroyStep!.jobEnv, ...(destroyStep!.env ?? {}) })) {
      const m = /secrets\.([A-Z0-9_]+)/.exec(String(v));
      stepEnv[k] = m ? (TOKENS as Record<string, string>)[m[1]!] : String(v);
    }

    const a = sha("ev4-a");
    team.deploy(a);
    expect((await team.cli(["apply"], { ...PR, sha: a })).json.receipt.status).toBe("complete");
    const d = await team.raw(["apply", "--destroy", "--json", "--env", "preview", "--pr", "42", "--branch", "feat/search", "--sha", a], stepEnv);
    const left = team.apiResources();
    expect(
      { status: d.json?.receipt?.status, left: left.neon.length + left.vercel.length + left.clerk.length },
      `destroy with the documented step env ${JSON.stringify(Object.keys(stepEnv).filter((k) => stepEnv[k]))}: ${JSON.stringify(Object.fromEntries(Object.entries(d.json?.receipt?.lines ?? {}).map(([k, l]: [string, any]) => [k, l.error ?? l.status])))}`,
    ).toEqual({ status: "complete", left: 0 });
  });

  it("a production apply from a GitHub `push` to main (no PR, no flags, GITHUB_HEAD_REF empty) lands in scope `main`", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const m = sha("ev5-main");
    // a real checkout of main, as actions/checkout leaves it
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: team.cwd });
    execFileSync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "m"], { cwd: team.cwd });
    const event = join(team.cwd, "event.json");
    await writeFile(event, JSON.stringify({ ref: "refs/heads/main", after: m, head_commit: { id: m } }));

    // The action's scope step yields no pr/branch/sha for a push, so it passes no flags.
    const r = await team.raw(["apply", "--json", "--env", "production"], {
      ...TOKENS,
      ...PROD_ENV,
      SPONSON_APPROVED_BY: "alice",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: event,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_NAME: "main",
      GITHUB_HEAD_REF: "",
      GITHUB_SHA: m,
    });
    expect({ exit: r.exit, scope: r.json?.receipt?.scope ?? r.json?.error?.code, branch: r.json?.receipt?.ctx.git.branch }).toEqual({ exit: 0, scope: "main", branch: "main" });
  });
});
