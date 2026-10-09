/**
 * Several PRs are open at once. Each PR's run only remembers its own scope; another PR's preview must not look
 * like something a human made in a console ("unmanaged ... Run `sponson init` to adopt it"), and `init` must not
 * write another PR's preview branch into this PR's plan.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PROD_ENV, Team, sha, teamPlan } from "./team.js";

let team: Team | undefined;
afterEach(async () => {
  await team?.close();
  team = undefined;
});

describe("lifecycle: concurrent PRs see each other's previews", () => {
  it("PR #43's plan does not report PR #42's preview branch and callback as unmanaged, and `init` there adopts nothing", async () => {
    team = await Team.create({ plan: teamPlan(), env: PROD_ENV });
    const a = sha("x-42");
    const b = sha("x-43");
    team.deploy(a);
    expect((await team.cli(["apply"], { pr: 42, branch: "feat/search", sha: a })).json.receipt.status).toBe("complete");

    const plan43 = await team.cli(["plan"], { pr: 43, branch: "feat/billing", sha: b });
    const unmanaged = (plan43.json.drift as Array<{ kind: string; resource: { key: string } }>).filter((d) => d.kind === "unmanaged").map((d) => d.resource.key);
    expect(unmanaged, "PR #42's Sponson-managed preview shown as unmanaged in PR #43").toEqual([]);

    const before = await team.readPlan();
    await team.cli(["init"], { pr: 43, branch: "feat/billing", sha: b });
    expect(await team.readPlan(), "`init` in PR #43 wrote PR #42's preview into the shared plan file").toBe(before);
  });
});
