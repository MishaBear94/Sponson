/**
 * Lifecycle units ("scopes": pr-42, branch-feat-x, main) versus the identities of the resources they own. A Neon
 * branch is named after the scope; a Vercel preview variable is identified by (key, target, git branch); a line is
 * identified by its id. When those identities drift apart over a PR's life — a renamed line id, a renamed PR
 * branch, the same git branch seen under two scopes — the receipt and the cloud must still agree.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PROD_ENV, Team, sha, teamPlan } from "./team.js";

let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

describe("lifecycle: scope and resource identity", () => {
  it("renaming a line id mid-PR (env -> vars) does not leave a phantom orphan that keeps claiming the live variables", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("id-a");
    const b = sha("id-b");
    team.deploy(a);
    expect((await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: a })).json.receipt.status).toBe("complete");

    await team.writePlan(teamPlan({ envId: "vars" }));
    team.deploy(b);
    const r = await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: b });
    expect(r.json.receipt.status).toBe("complete");
    expect(team.vercelEnv("preview", "DATABASE_URL").length, "rename duplicated the variable").toBe(1);

    const plan = await team.cli(["plan"], { pr: 42, branch: "feat/search", sha: b });
    const orphans = (plan.json.drift as Array<{ kind: string; line?: string; resource: { key: string } }>).filter((d) => d.kind === "orphan" && d.line === "env").map((d) => d.resource.key);
    expect(orphans, "variables still managed by `vars` reported as orphans of the old id `env`").toEqual([]);
    const vars = (await team.receipt("preview", "pr-42"))!.lines.vars!;
    expect(vars.resources.map((x) => `${x.key}:${x.createdBy}`), "Sponson-created variables relabelled as adopted after the rename").toEqual(vars.resources.map((x) => `${x.key}:sponson`));
  });

  it("renaming the PR's head branch mid-PR: the variables written under the old git branch are destroyed with the PR", async () => {
    team = await Team.create({ plan: teamPlan({ callback: false }), env: PROD_ENV });
    const a = sha("rn-a");
    expect((await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: a })).json.receipt.status).toBe("complete");
    // the author renames the branch on GitHub; the PR (and the scope pr-42) is the same
    expect((await team.cli(["apply"], { pr: 42, branch: "feat/search-v2", sha: a })).json.receipt.status).toBe("complete");
    await team.cli(["apply", "--destroy"], { pr: 42, branch: "feat/search-v2", sha: a });
    const left = team.apiResources().vercel.map((e) => `${e.key}@${e.gitBranch}`);
    expect(left, "preview variables of the PR left after its destroy").toEqual([]);
  });

  it("an agent opened the preview locally before the PR existed (scope branch-feat-search); CI's pr-42 takes the scope over openly, and exactly one scope owns each variable", async () => {
    team = await Team.create({ plan: teamPlan({ callback: false }), env: PROD_ENV });
    const a = sha("ag-a");
    const b = sha("ag-b");
    // local: no PR yet, `gh` finds none -> scope branch-feat-search
    const local = await team.cli(["apply"], { pr: null, branch: "feat/search", sha: a });
    expect(local.json.receipt.scope).toBe("branch-feat-search");
    // PR opened; CI applies pr-42 on the same git branch, then again on the next push
    const ci1 = await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: a });
    const ci2 = await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: b });

    // v0.2 scope succession: a pull request supersedes the branch scope of its head
    // branch. pr-42 inherits branch-feat-search's resources (said loudly in a warning) and the branch scope's receipt
    // releases them, so exactly one scope owns each variable and destroying either scope cannot hit the other's.
    for (const r of [ci1, ci2]) expect(r.json.receipt.status).toBe("complete");
    expect((ci1.json.warnings as string[]).join("\n")).toMatch(/Inherited \d+ resources? from scope `branch-feat-search`/);
    const claims = new Map<string, string[]>();
    for (const rc of await team.allLatestReceipts()) {
      if (rc.destroy) continue;
      for (const e of rc.ledger) if (e.key.startsWith("env:") && e.createdBy !== "adopted") claims.set(e.id, [...(claims.get(e.id) ?? []), rc.scope]);
    }
    const shared = [...claims.entries()].filter(([, scopes]) => new Set(scopes).size > 1).map(([id, scopes]) => `${id}: ${[...new Set(scopes)].join(" & ")}`);
    expect(shared, "two scopes' ledgers claim the same Vercel variables as their own").toEqual([]);
    // the variables the agent created locally now belong to pr-42 alone
    const localOwned = (local.json.receipt.ledger as Array<{ key: string; id: string; createdBy: string }>).filter((e) => e.key.startsWith("env:"));
    expect(localOwned.length).toBeGreaterThan(0);
    for (const e of localOwned) expect(claims.get(e.id), e.key).toEqual(["pr-42"]);
    // and closing the PR removes them; the old branch scope has nothing left to destroy
    await team.cli(["apply", "--destroy"], { pr: 42, branch: "feat/search", sha: b });
    await team.cli(["apply", "--destroy"], { pr: null, branch: "feat/search", sha: b });
    expect(team.apiResources().vercel.filter((e) => e.gitBranch === "feat/search")).toEqual([]);
  });
});
