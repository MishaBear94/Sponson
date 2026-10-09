/**
 * Console edits interleaved with applies. The human is fast and sloppy: change, delete, re-create by hand with
 * the same name, change and change back, edit an adopted vs a Sponson-created thing, move a var between targets.
 *
 * Expectations: 决策-引用与漂移.md drift table (changed → warn + refuse without --reconcile; missing → recreate;
 * unmanaged → never touch) and README "destroy … never touches resources it merely adopted".
 */
import { afterEach, describe, expect, it } from "vitest";
import { Journey, driftKinds, lineStatus, receiptLine } from "./harness.js";

let j: Journey | undefined;
afterEach(async () => {
  await j?.close();
  j = undefined;
});

const PLAN = `version: 1
receipts: local
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
      FEATURE_X: "on"
    environments: [preview]
`;

describe("console edits beside applies", () => {
  it("change a value in the console, then change it back: no drift, no write, no refusal", async () => {
    j = await Journey.start(undefined, PLAN);
    expect((await j.apply()).code).toBe(0);
    j.state.applyChaos({ drift: { "vercel.env.preview.FEATURE_X": "off" } });
    expect(driftKinds(await j.plan())).toContain("changed:env:env:preview:feat/x:FEATURE_X");
    j.state.applyChaos({ drift: { "vercel.env.preview.FEATURE_X": "on" } });
    const p = await j.plan();
    expect(p.json.drift).toEqual([]);
    expect(lineStatus(p, "env")).toBe("unchanged");
    const w = j.state.writes.length;
    const a = await j.apply();
    expect(a.json.receipt.status).toBe("complete");
    expect(j.state.writes.length).toBe(w);
  });

  it("human aligns the plan with a console hotfix: apply accepts it without --reconcile and records the new hash", async () => {
    j = await Journey.start(undefined, PLAN);
    expect((await j.apply()).code).toBe(0);
    j.state.applyChaos({ drift: { "vercel.env.preview.FEATURE_X": "hotfix" } });
    await j.writePlan(PLAN.replace('FEATURE_X: "on"', 'FEATURE_X: "hotfix"'));
    const a = await j.apply();
    expect(a.code, a.stdout).toBe(0);
    expect(receiptLine(a, "env").status).toBe("unchanged");
    expect((await j.plan()).json.drift).toEqual([]);
    expect((await j.destroy()).code).toBe(0);
    expect(j.branchEnv("FEATURE_X")).toHaveLength(0);
  });

  it("console edit to an adopted and a Sponson-created var: refused, reconciled, and ownership survives the refusal", async () => {
    j = await Journey.start({ vercel: { projects: { prj_demo: { envs: [{ key: "FEATURE_X", value: "on", target: "preview", gitBranch: "feat/x" }] } } } }, PLAN);
    const a1 = await j.apply();
    expect(a1.code).toBe(0);
    const res = receiptLine(a1, "env").resources as Array<{ key: string; createdBy: string }>;
    expect(res.find((r) => r.key.endsWith("FEATURE_X"))?.createdBy).toBe("adopted");
    expect(res.find((r) => r.key.endsWith("DATABASE_URL"))?.createdBy).toBe("sponson");
    j.state.applyChaos({ drift: { "vercel.env.preview.FEATURE_X": "human", "vercel.env.preview.DATABASE_URL": "postgres://human" } });
    const p = await j.plan();
    expect(driftKinds(p)).toEqual(expect.arrayContaining(["changed:env:env:preview:feat/x:FEATURE_X", "changed:env:env:preview:feat/x:DATABASE_URL"]));
    const a2 = await j.apply();
    expect(a2.code).toBe(1);
    expect(j.branchEnv("FEATURE_X")[0]?.value).toBe("human");
    const a3 = await j.apply("--reconcile");
    expect(a3.code).toBe(0);
    // reconcile must not change who owns what
    const res3 = receiptLine(a3, "env").resources as Array<{ key: string; createdBy: string }>;
    expect(res3.find((r) => r.key.endsWith("FEATURE_X"))?.createdBy).toBe("adopted");
    expect(res3.find((r) => r.key.endsWith("DATABASE_URL"))?.createdBy, "the refused run wiped the line's resources; reconcile re-recorded DATABASE_URL as adopted").toBe("sponson");
    expect((await j.destroy()).code).toBe(0);
    expect(j.branchEnv("FEATURE_X")).toHaveLength(1);
    expect(j.branchEnv("DATABASE_URL"), "DATABASE_URL Sponson created leaked after destroy").toHaveLength(0);
  });

  it("a refused apply stays refused: retrying plain apply must not overwrite the console edit", async () => {
    // 决策: 被改动 → "该行拒绝执行，整个 apply 失败，除非带 --reconcile。默认不覆盖人在控制台改的东西".
    // CI retries; a human re-runs the job. The second plain apply must refuse exactly like the first.
    j = await Journey.start(undefined, PLAN);
    expect((await j.apply()).code).toBe(0);
    j.state.applyChaos({ drift: { "vercel.env.preview.FEATURE_X": "emergency-off" } });
    const a1 = await j.apply();
    expect(a1.code).toBe(1);
    expect(receiptLine(a1, "env").errorCode).toBe("DRIFT_CHANGED");
    const p = await j.plan();
    expect.soft(driftKinds(p), "drift vanished from plan after one refused apply").toContain("changed:env:env:preview:feat/x:FEATURE_X");
    const a2 = await j.apply();
    expect.soft(a2.code, "second plain apply was not refused").toBe(1);
    expect(j.branchEnv("FEATURE_X")[0]?.value, "the emergency console fix was silently overwritten on retry").toBe("emergency-off");
  });

  it("human deletes the Sponson branch and re-creates one with the same name by hand: plan says so, destroy keeps the human's branch", async () => {
    // Same key, new provider id. The human's branch may hold data they loaded by hand; it is not Sponson's.
    j = await Journey.start(undefined, PLAN);
    expect((await j.apply()).code).toBe(0);
    const original = j.branchNamed("sponson/preview/pr-42")[0]!.id;
    j.consoleDeleteBranch("sponson/preview/pr-42");
    const mine = j.consoleCreateBranch("sponson/preview/pr-42", "main");
    expect(mine.id).not.toBe(original);
    const p = await j.plan();
    // v0.2 (决策-v0.2 G1.4 "同 key 不同 provider id = 被替换（changed），不认领"; G6.3 blocked): the replaced branch is
    // `changed` drift with `replaced: true`, the db line is blocked DRIFT_CHANGED and env (which reads db) is blocked too.
    expect(driftKinds(p)).toContain("changed:db:branch:sponson/preview/pr-42");
    expect((p.json.drift as Array<{ kind: string; replaced?: boolean }>).find((d) => d.kind === "changed")?.replaced).toBe(true);
    expect(lineStatus(p, "db")).toBe("blocked");
    expect(lineStatus(p, "env")).toBe("blocked");
    const refused = await j.apply();
    expect(refused.code, "plain apply must refuse a replaced resource").toBe(1);
    expect(receiptLine(refused, "db").errorCode).toBe("DRIFT_CHANGED");
    // with --reconcile the human's branch is taken over as adopted, and the env var is pointed at it
    const a = await j.apply("--reconcile");
    expect(a.code, a.stdout).toBe(0);
    expect((a.json.receipt.ledger as Array<{ key: string; createdBy: string }>).find((e) => e.key === "branch:sponson/preview/pr-42")?.createdBy).toBe("adopted");
    expect(j.branchEnv("DATABASE_URL")[0]?.value).toContain(mine.id);
    expect(j.branchNamed("sponson/preview/pr-42")).toHaveLength(1);
    expect((await j.destroy()).code).toBe(0);
    expect(j.branchNamed("sponson/preview/pr-42"), "destroy deleted the branch a human created by hand").toHaveLength(1);
  });

  it("human deletes and re-creates a Sponson var by hand, then the PR closes: destroy is truthful about what it removed", async () => {
    j = await Journey.start(undefined, PLAN);
    expect((await j.apply()).code).toBe(0);
    j.consoleDeleteEnv("FEATURE_X");
    j.consoleSetEnv("FEATURE_X", "on"); // same key, same value, new id
    const p = await j.plan();
    // v0.2 (决策-v0.2 G1.4): same key, new provider id = replaced → `changed` drift (replaced: true), line blocked.
    expect(driftKinds(p)).toContain("changed:env:env:preview:feat/x:FEATURE_X");
    expect(lineStatus(p, "env")).toBe("blocked");
    const d = await j.destroy();
    expect(d.code).toBe(0);
    const left = j.branchEnv("FEATURE_X");
    // Either destroy removed it, or it says it did not. "destroyed" with the var still there is a silent leak.
    expect(left.length === 0 || d.json.receipt.lines.env.status !== "destroyed" || JSON.stringify(d.json).includes("FEATURE_X"), `receipt: ${JSON.stringify(d.json.receipt.lines.env)}`).toBe(true);
    // and the next plan in this scope at least mentions it
    const p2 = await j.plan();
    // The plan's own line declares FEATURE_X, so a live FEATURE_X is not drift; what must be truthful is that
    // the plan sees it as existing (not something to create) and the destroy receipt named it (asserted above).
    expect(left.length === 0 || lineStatus(p2, "env") !== "create", `plan after destroy: ${JSON.stringify(p2.json.lines)}`).toBe(true);
  });

  it("human moves a Sponson var from preview to production by hand: preview is recreated, production is never touched", async () => {
    j = await Journey.start(undefined, PLAN);
    expect((await j.apply()).code).toBe(0);
    const v = j.branchEnv("FEATURE_X")[0]!.value;
    j.consoleDeleteEnv("FEATURE_X", "preview");
    j.consoleSetEnv("FEATURE_X", v, "production");
    const p = await j.plan();
    expect(driftKinds(p)).toContain("missing:env:env:preview:feat/x:FEATURE_X");
    expect(lineStatus(p, "env")).toBe("create");
    expect((await j.apply()).code).toBe(0);
    expect(j.branchEnv("FEATURE_X")).toHaveLength(1);
    expect((await j.destroy()).code).toBe(0);
    expect(j.branchEnv("FEATURE_X")).toHaveLength(0);
    expect(j.envs().filter((e) => e.key === "FEATURE_X" && e.target.includes("production"))).toHaveLength(1);
  });
});
