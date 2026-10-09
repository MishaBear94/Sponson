/**
 * Long journeys: a week of a team's CI against one cloud. Each journey keeps a running list of what a team would
 * notice going wrong (leaked previews, receipts that disagree with the cloud, production values that moved) and
 * asserts the whole list at the end, so one run shows every symptom rather than only the first.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeGitHub, PROD_ENV, PROD_DSN, PreviewWorkflow, Team, teamPlan, type CliResult } from "./team.js";

let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

class Notebook {
  problems: string[] = [];
  check(day: string, ok: boolean, what: string) {
    if (!ok) this.problems.push(`${day}: ${what}`);
  }
  async consistent(day: string, t: Team, opts: { ignoreScopes?: string[]; allowUnclaimed?: (p: string) => boolean } = {}) {
    for (const p of await t.receiptsVsReality(opts)) if (!opts.allowUnclaimed?.(p)) this.problems.push(`${day}: ${p}`);
  }
}

function status(r: CliResult | null): string {
  return r?.json?.receipt?.status ?? r?.json?.error?.code ?? `exit ${r?.code}`;
}

describe("lifecycle journeys", () => {
  it("a week in CI: three PRs, two merges, production with approval, duplicate and late deployment_status, one PR closed without its destroy", async () => {
    team = await Team.create({ env: PROD_ENV });
    const gh = new FakeGitHub();
    const wf = new PreviewWorkflow(team, gh);
    const nb = new Notebook();

    const v1 = teamPlan({ previewValues: { FEATURE_SEARCH: "off" }, prodValues: { FEATURE_SEARCH: "off" } });
    const v2 = teamPlan({ previewValues: { FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" }, prodValues: { FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2" } });
    const v3 = teamPlan({
      previewValues: { FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2", BILLING_V2: "true" },
      prodValues: { FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2", BILLING_V2: "false" },
    });

    // --- Monday: main is in production; two PRs open --------------------------------------------------------
    const m0 = gh.commit("wk-m0", v1);
    nb.check("Mon", status(await wf.production(m0, "lead-alice", PROD_ENV)) === "complete", "production apply of m0 not complete");
    team.deploy(m0);
    await wf.fire({ name: "deployment_status", sha: m0, ref: "main", environment: "Production", state: "success" });

    const a1 = gh.commit("wk-pr42-a1", v1);
    const pr42 = gh.open(42, "feat/search", a1);
    nb.check("Mon", status(await wf.fire({ name: "pull_request", action: "opened", pr: pr42 })) === "partial", "PR#42 opened run not partial");
    await wf.fire({ name: "deployment_status", sha: a1, ref: "feat/search", environment: "Preview", state: "pending" }); // filtered by `if:`
    team.deploy(a1);
    nb.check("Mon", status(await wf.fire({ name: "deployment_status", sha: a1, ref: "feat/search", environment: "Preview", state: "success" })) === "complete", "PR#42 deployment_status run not complete");

    const b1 = gh.commit("wk-pr43-b1", v1);
    const pr43 = gh.open(43, "feat/billing", b1);
    await wf.fire({ name: "pull_request", action: "opened", pr: pr43 });
    team.deploy(b1);
    await wf.fire({ name: "deployment_status", sha: b1, ref: "feat/billing", environment: "Preview", state: "success" });
    await nb.consistent("Mon", team);

    // --- Tuesday: PR #42 gets a second push that changes the plan; Vercel reports its deploy twice ---------------
    const a2 = gh.commit("wk-pr42-a2", v2);
    await wf.fire({ name: "pull_request", action: "synchronize", pr: gh.push(42, a2) });
    team.deploy(a2);
    await wf.fire({ name: "deployment_status", sha: a2, ref: "feat/search", environment: "Preview", state: "success" });
    const dup = await wf.fire({ name: "deployment_status", sha: a2, ref: "feat/search", environment: "Preview", state: "success" });
    nb.check("Tue", (dup?.writes.length ?? -1) === 0, `duplicate deployment_status wrote ${JSON.stringify(dup?.writes)}`);
    nb.check("Tue", team.vercelEnv("preview", "SEARCH_INDEX", "feat/search").length === 1, "PR#42 preview lacks SEARCH_INDEX");
    await nb.consistent("Tue", team);

    // --- Wednesday: PR #42 merged; destroy; production with approval; Vercel deploys the merge commit -----------
    const m1 = gh.commit("wk-m1", v2);
    await wf.fire({ name: "pull_request", action: "closed", pr: gh.close(42, { mergeSha: m1 }) });
    nb.check("Wed", !team.apiResources().neon.some((b) => b.name === "sponson/preview/pr-42"), "PR#42 Neon branch survived its destroy");
    nb.check("Wed", status(await wf.production(m1, "lead-alice", PROD_ENV)) === "complete", "production apply of m1 not complete");
    team.deploy(m1);
    await wf.fire({ name: "deployment_status", sha: m1, ref: "main", environment: "Production", state: "success" });
    await nb.consistent("Wed", team);

    // --- Thursday: PR #43 rebased onto main (force-push) and extends the plan; PR #44 opened and abandoned ------
    const b2 = gh.commit("wk-pr43-b2", v3);
    await wf.fire({ name: "pull_request", action: "synchronize", pr: gh.push(43, b2) });
    team.deploy(b2);
    await wf.fire({ name: "deployment_status", sha: b2, ref: "feat/billing", environment: "Preview", state: "success" });

    const c1 = gh.commit("wk-pr44-c1", v2);
    await wf.fire({ name: "pull_request", action: "opened", pr: gh.open(44, "spike/cache", c1) });
    team.deploy(c1);
    await wf.fire({ name: "deployment_status", sha: c1, ref: "spike/cache", environment: "Preview", state: "success" });
    gh.close(44); // the closed workflow never ran (Actions outage): README says such scopes are not garbage-collected yet
    await nb.consistent("Thu", team);

    // --- Friday: PR #43 merged; destroy; production; merge commit deployed ---------------------------------------
    const m2 = gh.commit("wk-m2", v3);
    await wf.fire({ name: "pull_request", action: "closed", pr: gh.close(43, { mergeSha: m2 }) });
    nb.check("Fri", status(await wf.production(m2, "lead-alice", PROD_ENV)) === "complete", "production apply of m2 not complete");
    team.deploy(m2);
    await wf.fire({ name: "deployment_status", sha: m2, ref: "main", environment: "Production", state: "success" });

    // --- End of week: what does the cloud look like? ------------------------------------------------------------
    const left = team.apiResources();
    const pr44Url = Team.previewUrl(c1);
    nb.check("End", JSON.stringify(left.neon.map((b) => b.name)) === JSON.stringify(["sponson/preview/pr-44"]), `Neon branches left: ${JSON.stringify(left.neon.map((b) => b.name))} (only the abandoned pr-44 expected)`);
    const previewVars = left.vercel.filter((e) => e.target === "preview").filter((e) => e.gitBranch !== "spike/cache");
    nb.check("End", previewVars.length === 0, `preview vars of closed PRs left: ${JSON.stringify(previewVars.map((e) => `${e.key}@${e.gitBranch ?? "(all branches)"}`))}`);
    const urls = left.clerk.map((c) => c.url).filter((u) => u !== pr44Url);
    nb.check("End", JSON.stringify(urls) === JSON.stringify(["https://app.example.com/sso-callback"]), `Clerk redirects left: ${JSON.stringify(urls)}`);
    const prod = Object.fromEntries(left.vercel.filter((e) => e.target === "production").map((e) => [e.key, e.value]));
    nb.check("End", JSON.stringify(prod) === JSON.stringify({ DATABASE_URL: PROD_DSN, FEATURE_SEARCH: "on", SEARCH_INDEX: "products_v2", BILLING_V2: "false" }), `production vars: ${JSON.stringify(Object.keys(prod).map((k) => `${k}=${k === "DATABASE_URL" ? (prod[k] === PROD_DSN ? "<prod dsn>" : "<other>") : prod[k]}`))}`);
    const prodReceipt = await team.receipt("production", "main");
    nb.check("End", prodReceipt?.ctx.git.sha === m2 && prodReceipt.status === "complete", `production receipt: ${prodReceipt?.status} @ ${prodReceipt?.ctx.git.sha}`);
    const pr44 = await team.receipt("preview", "pr-44");
    nb.check("End", pr44 !== null && !pr44.destroy, "the abandoned PR#44 has no live receipt a future gc could find");
    const strayScopes = (await team.allLatestReceipts()).filter((r) => r.environment === "preview" && !r.destroy && r.scope !== "pr-44").map((r) => r.scope);
    nb.check("End", strayScopes.length === 0, `live preview receipts besides pr-44: ${JSON.stringify(strayScopes)}`);
    await nb.consistent("End", team);

    expect(nb.problems, `CI runs:\n${wf.runs.map((r) => `  ${r.event} -> ${r.command} [pr=${r.scope.pr} branch=${r.scope.branch} sha=${r.scope.sha.slice(0, 7)}] ${status(r.result)}`).join("\n")}`).toEqual([]);
  });
});
