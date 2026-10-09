/**
 * The plan file evolving across applies: renames, splits, merges, moved keys, renamed branches, retargeted lines,
 * environment filters, provider changes, reorders, deleting everything.
 *
 * The invariant every test checks in the end (README "Destroy is symmetric", 决策 orphan rule): whatever Sponson
 * created is either still tracked by the receipt (and removed by `apply --destroy`) or was deliberately destroyed;
 * nothing Sponson created is silently forgotten, duplicated, or re-labelled as someone else's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Journey, driftKinds, lineStatus, receiptLine } from "./harness.js";

let j: Journey | undefined;
afterEach(async () => {
  await j?.close();
  j = undefined;
});

const HEAD = `version: 1
receipts: local
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
`;

const DB = `  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]
`;

function envLine(id: string, values: Record<string, string>, extra = "") {
  const vals = Object.entries(values)
    .map(([k, v]) => `      ${k}: ${v}`)
    .join("\n");
  return `  - id: ${id}
    adapter: vercel
    op: env
    target: preview
    values:
${vals}
    environments: [preview]
${extra}`;
}

/** Every Sponson-created thing is gone after destroy, and what the human made is not. */
function expectCleanAfterDestroy(jj: Journey, keys: string[]) {
  for (const k of keys) expect(jj.branchEnv(k), `preview/${k} leaked after destroy`).toHaveLength(0);
  const leftover = jj.branches().filter((b) => b.name.startsWith("sponson/")).map((b) => b.name);
  expect(leftover, "Neon branches leaked after destroy").toEqual([]);
}

describe("plan refactors across applies", () => {
  it("rename a line id: no duplicate branch, no name collision, destroy still cleans it", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + DB.replace("id: db", "id: database") + envLine("env", { DATABASE_URL: "{ from: database.connection_string }" }));
    const p = await j.plan();
    expect(p.code).toBe(0);
    expect(lineStatus(p, "database")).toBe("unchanged");
    expect(lineStatus(p, "env")).toBe("unchanged");
    const a = await j.apply();
    expect(a.code, a.stdout).toBe(0);
    expect(j.branchNamed("sponson/preview/pr-42")).toHaveLength(1);
    // the branch is still Sponson's: either via the renamed line or the carried-over orphan
    const owners = Object.values(a.json.receipt.lines as Record<string, { resources: Array<{ key: string; createdBy: string }> }>).flatMap((l) => l.resources).filter((r) => r.key === "branch:sponson/preview/pr-42");
    expect(owners.some((r) => r.createdBy === "sponson"), "branch lost its Sponson ownership after the rename").toBe(true);
    // apply again: stable
    const a2 = await j.apply();
    expect(a2.code).toBe(0);
    expect(j.state.writes.filter((w) => w.method === "POST" && w.path.includes("/branches"))).toHaveLength(1);
    expect((await j.destroy()).code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL"]);
  });

  it("rename a line id: plan does not claim the branch was 'removed from the plan' while another line still declares it", async () => {
    // 决策 orphan = "回执说已 apply，plan 里这行被删了". The message says the resource is left alone and not in the
    // plan; for a pure rename that is false and tells the human to run destroy on something still in use.
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + DB.replace("id: db", "id: database") + envLine("env", { DATABASE_URL: "{ from: database.connection_string }" }));
    const p = await j.plan();
    expect(driftKinds(p).filter((d) => d.endsWith("branch:sponson/preview/pr-42") && d.startsWith("orphan")), JSON.stringify(p.json.drift)).toEqual([]);
  });

  it("split one vercel.env line into two: the moved key keeps its Sponson ownership and destroy removes it", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }", FEATURE_X: '"on"', LOG_LEVEL: "debug" }));
    expect((await j.apply()).code).toBe(0);
    // split: LOG_LEVEL and FEATURE_X move to their own line
    await j.writePlan(HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }) + envLine("flags", { FEATURE_X: '"on"', LOG_LEVEL: "debug" }));
    const p = await j.plan();
    expect(lineStatus(p, "flags")).toBe("unchanged");
    const a = await j.apply();
    expect(a.code).toBe(0);
    for (const r of receiptLine(a, "flags").resources) expect(r.createdBy, `${r.key} became 'adopted' after moving lines`).toBe("sponson");
    expect((await j.destroy()).code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL", "FEATURE_X", "LOG_LEVEL"]);
  });

  it("merge two vercel.env lines into one: no duplicate writes, destroy removes both keys exactly once", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }) + envLine("flags", { FEATURE_X: '"on"' }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }", FEATURE_X: '"on"' }));
    const p = await j.plan();
    expect(lineStatus(p, "env")).toBe("unchanged");
    const writes = j.state.writes.length;
    const a = await j.apply();
    expect(a.code).toBe(0);
    expect(j.state.writes.length - writes, "merging lines must not rewrite unchanged vars").toBe(0);
    expect(j.branchEnv("FEATURE_X")).toHaveLength(1);
    const d = await j.destroy();
    expect(d.code, d.stdout).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL", "FEATURE_X"]);
  });

  it("remove a key from a line: the var stays (deleting is not destroying) but is not forgotten — destroy removes it", async () => {
    // SKILL rule 5: "Deleting a line does not destroy its resource." The same must hold for one key of a line,
    // and `apply --destroy` must still remove it, as it does for a deleted line (c-drift/orphan.yaml).
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }", TEMP_FLAG: '"1"' }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }));
    expect((await j.apply()).code).toBe(0);
    expect(j.branchEnv("TEMP_FLAG"), "removing a key from the plan must not delete it").toHaveLength(1);
    const p = await j.plan();
    expect(driftKinds(p).some((d) => d.startsWith("unmanaged") && d.endsWith("TEMP_FLAG")), "a var Sponson created is reported as 'unmanaged, run init to adopt'").toBe(false);
    expect((await j.destroy()).code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL", "TEMP_FLAG"]);
  });

  it("change `name:` of a neon branch: the old branch is reported and destroyed, not leaked", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + DB.replace("parent: main", "parent: main\n    name: sponson/preview/pr-42-v2") + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }));
    const p = await j.plan();
    expect(lineStatus(p, "db")).toBe("create");
    const p1 = driftKinds(p);
    const a = await j.apply();
    expect(a.code).toBe(0);
    expect(j.branchNamed("sponson/preview/pr-42-v2")).toHaveLength(1);
    // the env var now points at the new branch
    expect(j.branchEnv("DATABASE_URL")[0]?.value).toContain(j.branchNamed("sponson/preview/pr-42-v2")[0]!.id);
    const p2 = await j.plan();
    const oldSeen = [...p1, ...driftKinds(p2)].filter((d) => d.endsWith("branch:sponson/preview/pr-42"));
    expect(oldSeen.some((d) => d.startsWith("unmanaged")), `old branch Sponson created is called unmanaged: ${oldSeen}`).toBe(false);
    expect((await j.destroy()).code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL"]);
  });

  it("change `target:` of a preview line to production: a preview run must not write production without approval", async () => {
    // README "Production needs a human": --env production without --approved-by is refused before any adapter
    // is touched. A preview-environment line retargeted to `production` reaches the same variables.
    j = await Journey.start(undefined, HEAD + envLine("env", { FEATURE_X: '"on"' }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + envLine("env", { FEATURE_X: '"on"' }).replace("target: preview", "target: production"));
    const before = j.envs().filter((e) => e.target.includes("production")).length;
    await j.apply();
    expect(j.envs().filter((e) => e.target.includes("production")).length, "preview apply wrote a production var without approval").toBe(before);
  });

  it("change `target:` of a line: the var it left behind in the old target is still Sponson's to destroy", async () => {
    j = await Journey.start(undefined, HEAD + envLine("env", { FEATURE_X: '"on"' }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + envLine("env", { FEATURE_X: '"on"' }).replace("target: preview", "target: development"));
    expect((await j.apply()).code).toBe(0);
    expect((await j.destroy()).code).toBe(0);
    expect(j.envs().filter((e) => e.key === "FEATURE_X"), "FEATURE_X leaked in some target").toEqual([]);
  });

  it("change `environments:` so a line leaves preview: it becomes an orphan, is kept, and destroy removes it", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }) + envLine("flags", { FEATURE_X: '"on"' }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }) + envLine("flags", { FEATURE_X: '"on"' }).replace("environments: [preview]", "environments: [production]"));
    const p = await j.plan();
    expect(driftKinds(p)).toContain("orphan:flags:env:preview:feat/x:FEATURE_X");
    expect((await j.apply()).code).toBe(0);
    expect(j.branchEnv("FEATURE_X")).toHaveLength(1);
    expect((await j.destroy()).code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL", "FEATURE_X"]);
  });

  it("change providers.vercel.project: destroy must not report 'destroyed' while the old project's vars still exist", async () => {
    j = await Journey.start(
      { vercel: { projects: { prj_demo: { envs: [] }, prj_new: { envs: [] } } } },
      HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }),
    );
    expect((await j.apply()).code).toBe(0);
    expect(j.branchEnv("DATABASE_URL", "preview", "prj_demo")).toHaveLength(1);
    // the team moves the app to a new Vercel project and edits the plan; the PR closes before another apply
    await j.writePlan((HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" })).replace("project: prj_demo", "project: prj_new"));
    const p = await j.plan();
    // plan says DATABASE_URL is 'missing … will be recreated' — it is not missing, it is in prj_demo
    expect.soft(driftKinds(p).filter((d) => d.startsWith("missing")), "plan calls a var in another project 'missing'").toEqual([]);
    const d = await j.destroy();
    expect(d.code).toBe(0);
    const stillThere = j.branchEnv("DATABASE_URL", "preview", "prj_demo");
    expect.soft(stillThere.length === 0 || d.json.receipt.lines.env.status !== "destroyed", "receipt says destroyed, DATABASE_URL still exists in prj_demo").toBe(true);
  });

  it("reorder lines: plan and apply are a no-op", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }) + envLine("flags", { FEATURE_X: '"on"' }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD + envLine("flags", { FEATURE_X: '"on"' }) + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }) + DB);
    const p = await j.plan();
    expect(p.json.lines.map((l: { status: string }) => l.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(p.json.drift).toEqual([]);
    const w = j.state.writes.length;
    const a = await j.apply();
    expect(a.json.receipt.status).toBe("complete");
    expect(j.state.writes.length).toBe(w);
    expect((await j.destroy()).code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL", "FEATURE_X"]);
  });

  it("delete everything from the plan: nothing is destroyed by apply, everything by destroy", async () => {
    j = await Journey.start(undefined, HEAD + DB + envLine("env", { DATABASE_URL: "{ from: db.connection_string }" }));
    expect((await j.apply()).code).toBe(0);
    await j.writePlan(HEAD.replace("changes:\n", "changes: []\n"));
    const p = await j.plan();
    expect(p.code).toBe(0);
    expect(driftKinds(p).filter((d) => d.startsWith("orphan")).length).toBe(2);
    const a = await j.apply();
    expect(a.code).toBe(0);
    expect(j.branchNamed("sponson/preview/pr-42")).toHaveLength(1);
    expect(j.branchEnv("DATABASE_URL")).toHaveLength(1);
    // a second apply with the empty plan still remembers them
    expect((await j.apply()).code).toBe(0);
    const d = await j.destroy();
    expect(d.code).toBe(0);
    expectCleanAfterDestroy(j, ["DATABASE_URL"]);
  });
});
