import { pendingMarker, sha256 } from "@sponson/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, SHA, type Harness } from "./testing.js";
import { vercelAdapter } from "./vercel.js";

const env = vercelAdapter.ops.env!;
const deploy = vercelAdapter.ops.deploy!;

describe("vercel env", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const params = (values: Record<string, unknown>) => env.defaults!({ values }, h.ctx);

  it("defaults target and branch from ctx", () => {
    expect(params({})).toEqual({ values: {}, target: "preview", branch: "feat/x" });
    expect(env.defaults!({}, { ...h.ctx, env: "production" })).toEqual({ target: "production" });
    expect(env.defaults!({}, { ...h.ctx, env: "staging" })).toEqual({ target: "preview", branch: "feat/x" });
  });

  it("create, update, unchanged, zero writes on second apply", async () => {
    const actx = h.actx("vercel");
    const p = params({ DATABASE_URL: "postgres://a", API_KEY: "k1" });
    expect(await env.read(actx, p)).toBeNull();
    const diffs = env.diff(null, p);
    expect(diffs.map((d) => d.kind)).toEqual(["create", "create"]);
    expect(diffs[0]).toEqual({ key: "env:preview:DATABASE_URL", kind: "create", label: "DATABASE_URL (preview)", after: `sha:${sha256("postgres://a").slice(0, 8)}` });

    const r = await env.apply(actx, p, null);
    expect(r.created.sort()).toEqual(["env:preview:API_KEY", "env:preview:DATABASE_URL"]);
    expect(r.notes).toBeUndefined();
    expect(r.resources.map((x) => x.key).sort()).toEqual(["env:preview:API_KEY", "env:preview:DATABASE_URL"]);

    const live = await env.read(actx, p);
    expect(live?.resources).toEqual(r.resources);
    expect(env.diff(live, p).every((d) => d.kind === "unchanged")).toBe(true);
    const n = (await h.writes()).length;
    const again = await env.apply(actx, p, live);
    expect(again.created).toEqual([]);
    expect((await h.writes()).length).toBe(n);

    const p2 = params({ DATABASE_URL: "postgres://b", API_KEY: "k1" });
    const d2 = env.diff(live, p2);
    expect(d2.find((d) => d.key === "env:preview:DATABASE_URL")).toMatchObject({ kind: "update", before: `sha:${sha256("postgres://a").slice(0, 8)}`, after: `sha:${sha256("postgres://b").slice(0, 8)}` });
    expect(d2.find((d) => d.key === "env:preview:API_KEY")?.kind).toBe("unchanged");
    const r2 = await env.apply(actx, p2, live);
    expect(r2.created).toEqual([]);
    const writes = await h.writes(n);
    expect(writes.filter((w) => w.method === "POST" && w.path.endsWith("/env"))).toHaveLength(1);
    const sim = h.sim.state.vercel.projects.prj_demo!;
    expect(sim.envs.find((e) => e.key === "DATABASE_URL")?.value).toBe("postgres://b");
    expect(sim.envs.find((e) => e.key === "DATABASE_URL")?.gitBranch).toBe("feat/x");
  });

  it("rejects an unknown target before calling the API", async () => {
    await expect(env.read(h.actx("vercel"), { ...params({}), target: "staging" })).rejects.toThrow(/target.*preview, production, development/);
    expect(await h.writes()).toEqual([]);
  });

  it("never puts values in diffs", () => {
    const p = params({ SECRET: "hunter2" });
    expect(JSON.stringify(env.diff(null, p))).not.toContain("hunter2");
  });

  it("pending values diff as create/update and apply refuses them", async () => {
    const p = params({ DATABASE_URL: pendingMarker("db.connection_string") });
    expect(env.diff(null, p)).toEqual([{ key: "env:preview:DATABASE_URL", kind: "create", label: "DATABASE_URL (preview)", after: "(pending ← db.connection_string)" }]);
    const live = { resources: [{ key: "env:preview:DATABASE_URL", id: "env_1", hash: sha256("x") }], outputs: {} };
    expect(env.diff(live, p)[0]).toMatchObject({ kind: "update", before: `sha:${sha256("x").slice(0, 8)}` });
    await expect(env.apply(h.actx("vercel"), p, null)).rejects.toThrow(/pending/);
  });

  it("listScope lists every env in the target+branch, destroy tolerates 404", async () => {
    await h.close();
    h = await harness({
      vercel: {
        projects: {
          prj_demo: {
            envs: [
              { key: "LEGACY", value: "1", target: "preview", gitBranch: "feat/x" },
              { key: "OTHER_BRANCH", value: "1", target: "preview", gitBranch: "main" },
              { key: "PROD", value: "1", target: "production" },
            ],
          },
        },
      },
    });
    const actx = h.actx("vercel");
    const p = params({ NEW: "v" });
    await env.apply(actx, p, null);
    const scope = await env.listScope!(actx, p);
    expect(scope.map((r) => r.key).sort()).toEqual(["env:preview:LEGACY", "env:preview:NEW"]);

    const prod = env.defaults!({ values: {} }, { ...h.ctx, env: "production" });
    expect((await env.listScope!(actx, prod)).map((r) => r.key)).toEqual(["env:production:PROD"]);

    const mine = scope.filter((r) => r.key === "env:preview:NEW");
    await env.destroy(actx, mine);
    await env.destroy(actx, mine);
    expect(await env.read(actx, p)).toBeNull();
  });

  it("awaitExternal: ok → url, never → null, fail → throws, double → newest", async () => {
    const actx = h.actx("vercel");
    const live = { resources: [], outputs: {} };
    await h.chaos({ deploy: "never" });
    expect(await env.awaitExternal!(actx, params({}), live)).toBeNull();

    await h.chaos({ deploy: "ok" });
    const out = await env.awaitExternal!(actx, params({}), live);
    expect(out).toEqual({ preview_url: expect.stringMatching(/^https:\/\/prj_demo-abcdef12\.vercel\.app$/), deployment_id: expect.stringMatching(/^dpl_/) });

    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    await h.chaos({ deploy: "fail" });
    await expect(env.awaitExternal!(actx, params({}), live)).rejects.toThrow(/deployment dpl_\d+ failed/);

    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    await h.chaos({ deploy: "double" });
    expect(await env.awaitExternal!(actx, params({}), live)).toMatchObject({ preview_url: "https://prj_demo-abcdef12-2.vercel.app" });

    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    await h.chaos({ deploy: "delay:0.3" });
    expect(await env.awaitExternal!(actx, params({}), live)).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    expect(await env.awaitExternal!(actx, params({}), live)).not.toBeNull();
  });

  it("redeploys when the newest deployment predates the env write", async () => {
    const actx = h.actx("vercel");
    await h.chaos({ deploy: "stale" });
    const r = await env.apply(actx, params({ A: "1" }), null);
    expect(r.notes).toEqual({ redeployed: true });
    const deployments = h.sim.state.vercel.projects.prj_demo!.deployments;
    expect(deployments).toHaveLength(2);
    expect((await h.writes()).filter((w) => w.path.endsWith("/v13/deployments"))).toHaveLength(1);

    // A fresh deployment after the write: no redeploy.
    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    const r2 = await env.apply(actx, params({ A: "1" }), null);
    expect(r2.notes).toBeUndefined();
    expect(h.sim.state.vercel.projects.prj_demo!.deployments).toHaveLength(1);
  });

  it("names missing token and project", async () => {
    await expect(env.read({ ...h.actx("vercel"), env: {} }, params({}))).rejects.toThrow(/VERCEL_TOKEN/);
    await expect(env.read(h.actx("vercel", {}), params({}))).rejects.toThrow(/providers\.vercel\.project/);
  });
});

describe("vercel deploy", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("creates a deployment and polls it to READY; destroy is a no-op", async () => {
    const actx = h.actx("vercel");
    await h.chaos({ deploy: "never" });
    expect(await deploy.read(actx, {})).toBeNull();
    expect(deploy.diff(null, {})[0]?.kind).toBe("create");
    const r = await deploy.apply(actx, {}, null);
    expect(r.created).toEqual([`deployment:${SHA}`]);
    expect(r.outputs).toEqual({ preview_url: "https://prj_demo-abcdef12.vercel.app", deployment_id: expect.stringMatching(/^dpl_/) });
    const live = await deploy.read(actx, {});
    expect(live?.outputs).toEqual(r.outputs);
    expect(deploy.diff(live, {})).toEqual([{ key: `deployment:${SHA}`, kind: "unchanged", label: `deployment ${r.outputs.deployment_id}` }]);
    await deploy.destroy(actx, r.resources);
    expect(await deploy.read(actx, {})).not.toBeNull();
  });

  it("fails when the deployment errors", async () => {
    await h.chaos({ deploy: "fail" });
    await expect(deploy.apply(h.actx("vercel"), {}, null)).rejects.toThrow(/failed/);
  });
});
