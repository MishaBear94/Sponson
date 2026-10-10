import { SponsonError, pendingMarker, resolveParams, sha256 } from "@sponson/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, recordingProxy, SHA, writeIndex, type Harness } from "./testing.js";
import { vercelAdapter } from "./vercel.js";

const env = vercelAdapter.ops.env!;
const deploy = vercelAdapter.ops.deploy!;
const UPSERT = /^\/vercel\/v10\/projects\/[^/]+\/env$/;
const DEPLOY = /^\/vercel\/v13\/deployments$/;

describe("vercel env", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const params = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => env.defaults!({ values, ...extra }, h.ctx);
  const SENS = { state: "sensitive" };

  it("defaults target and branch from ctx, and declares the environment it writes", () => {
    expect(params({})).toEqual({ values: {}, target: "preview", branch: "feat/x" });
    expect(env.defaults!({}, { ...h.ctx, env: "production" })).toEqual({ target: "production" });
    expect(env.defaults!({}, { ...h.ctx, env: "staging" })).toEqual({ target: "preview", branch: "feat/x" });
    // A preview run whose line targets production writes production.
    expect(env.writesEnvironment!(params({}, { target: "production" }), h.ctx)).toBe("production");
    expect(env.writesEnvironment!(params({}), h.ctx)).toBe("preview");
    expect(deploy.writesEnvironment!({}, h.ctx)).toBe("preview");
    expect(deploy.writesEnvironment!({}, { ...h.ctx, env: "production" })).toBe("production");
  });

  it("create, update, unchanged, zero writes on second apply; keys carry the git branch", async () => {
    const actx = h.actx("vercel");
    const p = params({ DATABASE_URL: "postgres://a", API_KEY: "k1" });
    expect(await env.read(actx, p)).toBeNull();
    const diffs = env.diff(null, p);
    expect(diffs[0]).toEqual({ key: "env:preview:feat/x:DATABASE_URL", kind: "create", label: "DATABASE_URL (preview, feat/x)", before: { state: "absent" }, after: SENS });

    const r = await env.apply(actx, p, null);
    expect(r.created.sort()).toEqual(["env:preview:feat/x:API_KEY", "env:preview:feat/x:DATABASE_URL"]);
    expect(h.intents).toEqual([{ keys: ["env:preview:feat/x:DATABASE_URL", "env:preview:feat/x:API_KEY"], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", UPSERT)).toBe(0);
    expect(r.notes).toBeUndefined();
    expect(r.resources.map((x) => x.key).sort()).toEqual(r.created.sort());

    const live = await env.read(actx, p);
    expect(live?.resources).toEqual(r.resources);
    expect(env.diff(live, p).every((d) => d.kind === "unchanged" && d.before === undefined && d.after === undefined)).toBe(true);
    const n = (await h.writes()).length;
    const again = await env.apply(actx, p, live);
    expect(again.created).toEqual([]);
    expect((await h.writes()).length).toBe(n);

    const p2 = params({ DATABASE_URL: "postgres://b", API_KEY: "k1" });
    const d2 = env.diff(live, p2);
    expect(d2.find((d) => d.key === "env:preview:feat/x:DATABASE_URL")).toEqual({ key: "env:preview:feat/x:DATABASE_URL", kind: "update", label: "DATABASE_URL (preview, feat/x)", before: SENS, after: SENS });
    expect(d2.find((d) => d.key === "env:preview:feat/x:API_KEY")?.kind).toBe("unchanged");
    const r2 = await env.apply(actx, p2, live);
    expect(r2.created).toEqual([]);
    expect(h.intents).toHaveLength(1); // updates need no intent
    // every resource the line manages, not only the one written
    expect(r2.resources.map((x) => x.key).sort()).toEqual(r.created.sort());
    expect(r2.resources.find((x) => x.key.endsWith("DATABASE_URL"))?.hash).toBe(sha256("postgres://b"));
    const writes = await h.writes(n);
    expect(writes.filter((w) => w.method === "POST" && UPSERT.test(w.path))).toHaveLength(1);
    const sim = h.sim.state.vercel.projects.prj_demo!;
    expect(sim.envs.find((e) => e.key === "DATABASE_URL")?.value).toBe("postgres://b");
    expect(sim.envs.find((e) => e.key === "DATABASE_URL")?.gitBranch).toBe("feat/x");
  });

  it("a project-wide preview line (branch: '*') is its own resource, written without a git branch", async () => {
    const actx = h.actx("vercel");
    const p = params({ LOG_LEVEL: "debug" }, { branch: "*" });
    const r = await env.apply(actx, p, null);
    expect(r.created).toEqual(["env:preview:*:LOG_LEVEL"]);
    expect(h.sim.state.vercel.projects.prj_demo!.envs[0]).not.toHaveProperty("gitBranch");
    // the branch-scoped line does not see it as its own
    expect(await env.read(actx, params({ LOG_LEVEL: "debug" }))).toBeNull();
  });

  it("rejects bad params with PARAM_INVALID before calling the API", async () => {
    await expect(env.read(h.actx("vercel"), { ...params({}), target: "staging" })).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/target.*preview, production, development/) });
    await expect(env.read(h.actx("vercel"), { ...params({}), values: [] })).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(env.read(h.actx("vercel"), { target: "production", branch: "feat/x", values: {} })).rejects.toMatchObject({ code: "PARAM_INVALID" });
    expect(() => env.diff(null, { ...params({}), target: "staging" })).toThrow(SponsonError);
    expect(await h.writes()).toEqual([]);
  });

  it("never puts values or value hashes in diffs", () => {
    const p = params({ SECRET: "hunter2" });
    const live = { resources: [{ key: "env:preview:feat/x:SECRET", id: "env_1", hash: sha256("old") }], outputs: {} };
    const text = JSON.stringify([env.diff(null, p), env.diff(live, p)]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(sha256("old").slice(0, 8));
    expect(text).not.toContain("sha:");
  });

  it("pending and secret markers diff with their reference; apply refuses them", async () => {
    const p = params({ DATABASE_URL: pendingMarker("db.connection_string"), STRIPE_KEY: pendingMarker("env://STRIPE_KEY") });
    expect(env.diff(null, p)).toEqual([
      { key: "env:preview:feat/x:DATABASE_URL", kind: "create", label: "DATABASE_URL (preview, feat/x)", before: { state: "absent" }, after: { state: "pending", ref: "db.connection_string" } },
      { key: "env:preview:feat/x:STRIPE_KEY", kind: "create", label: "STRIPE_KEY (preview, feat/x)", before: { state: "absent" }, after: { state: "secret", ref: "env://STRIPE_KEY" } },
    ]);
    const live = { resources: [{ key: "env:preview:feat/x:DATABASE_URL", id: "env_1", hash: sha256("x") }], outputs: {} };
    expect(env.diff(live, p)[0]).toMatchObject({ kind: "update", before: SENS, after: { state: "pending", ref: "db.connection_string" } });
    await expect(env.apply(h.actx("vercel"), p, null)).rejects.toThrow(/pending/);
  });

  it("refuses a var whose one record spans targets the line does not own, and writes nothing", async () => {
    const now = Date.now();
    h.sim.state.vercel.projects.prj_demo!.envs.push({ id: "env_shared", key: "API_BASE", value: "v1", target: ["production", "preview", "development"], type: "encrypted", createdAt: now, updatedAt: now, createdBy: "sim" });
    const p = env.defaults!({ values: { API_BASE: "v2" } }, { ...h.ctx, env: "production" });
    const e = await env.read(h.actx("vercel"), p).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "PROVIDER_CONFLICT", message: expect.stringMatching(/shared by targets production, preview, development.*Split it in the Vercel dashboard/) });
    expect(await h.writes()).toEqual([]);
    // Writing blind (no read) is refused by the provider as a conflict, not silently duplicated.
    await expect(env.apply(h.actx("vercel"), p, null)).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
    expect(h.sim.state.vercel.projects.prj_demo!.envs).toHaveLength(1);
  });

  it("a non-empty `failed` in the upsert answer is an error naming the keys only", async () => {
    await h.chaos({ env_upsert_fail: ["FEATURE_FLAGS"] });
    const e = await env.apply(h.actx("vercel"), params({ DATABASE_URL: "postgres://secret-value", FEATURE_FLAGS: "secret-flag" }), null).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "PROVIDER_INVALID", message: "vercel: the bulk upsert rejected 1 env var(s): FEATURE_FLAGS" });
    expect(JSON.stringify(e)).not.toContain("secret-");
    // DATABASE_URL was written and intended, so the engine can find and roll it back.
    expect(h.intents.flatMap((i) => i.keys)).toContain("env:preview:feat/x:DATABASE_URL");
  });

  it("a 429 with Retry-After on the upsert is waited out", async () => {
    await h.chaos({ fail_on: "POST /vercel/v10/*", fail_next: 1, status: 429, retry_after: 0 });
    const r = await env.apply(h.actx("vercel"), params({ A: "1" }), null);
    expect(r.created).toEqual(["env:preview:feat/x:A"]);
  });

  it("trusts the upsert answer: no list after the write, so a lagging list cannot fail the apply", async () => {
    let hide = false;
    const proxy = await recordingProxy(h.sim.url, (req, body) => {
      if (req.method === "POST" && UPSERT.test(req.path)) hide = true;
      if (hide && req.method === "GET" && req.path.endsWith("/env")) return { ...(body as object), envs: [] };
      return body;
    });
    try {
      const actx = h.actx("vercel", undefined, { env: { ...h.env, VERCEL_API_URL: `${proxy.url}/vercel` } });
      const r = await env.apply(actx, params({ A: "1", B: "2" }), null);
      expect(r.resources.map((x) => x.id)).toEqual(h.sim.state.vercel.projects.prj_demo!.envs.map((e) => e.id));
      const post = proxy.log.findIndex((x) => x.method === "POST");
      expect(proxy.log.slice(post + 1).filter((x) => x.path.endsWith("/env"))).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("reads every page of the env list", async () => {
    await h.close();
    const envs = ["S1", "S2", "S3", "S4", "S5"].map((key) => ({ key, value: key, target: "preview" }));
    h = await harness({ vercel: { projects: { prj_demo: { envs } } }, chaos: { page_size: 2 } });
    const actx = h.actx("vercel");
    const p = params({ S5: "S5", NEW: "n" }, { branch: "*" });
    const live = await env.read(actx, p);
    expect(live?.resources.map((r) => r.key)).toEqual(["env:preview:*:S5"]);
    await env.apply(actx, p, live);
    const n = h.sim.state.writes.length;
    const live2 = await env.read(actx, p);
    expect(env.diff(live2, p).map((d) => d.kind)).toEqual(["unchanged", "unchanged"]);
    await env.apply(actx, p, live2);
    expect(h.sim.state.writes.length).toBe(n);
  });

  it("listScope lists the target's vars for this git branch and the project-wide ones; destroy tolerates 404", async () => {
    await h.close();
    h = await harness({
      vercel: {
        projects: {
          prj_demo: {
            envs: [
              { key: "LEGACY", value: "1", target: "preview", gitBranch: "feat/x" },
              { key: "SHARED", value: "1", target: "preview" },
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
    expect(scope.map((r) => r.key).sort()).toEqual(["env:preview:*:SHARED", "env:preview:feat/x:LEGACY", "env:preview:feat/x:NEW"]);

    const prod = env.defaults!({ values: {} }, { ...h.ctx, env: "production" });
    expect((await env.listScope!(actx, prod)).map((r) => r.key)).toEqual(["env:production:*:PROD"]);

    const mine = scope.filter((r) => r.key.endsWith(":NEW"));
    await env.destroy(actx, mine);
    await env.destroy(actx, mine);
    expect(await env.read(actx, p)).toBeNull();
  });

  it("a commit's preview build is never taken for its production build, and vice versa", async () => {
    const actx = h.actx("vercel");
    const live = { resources: [], outputs: {} };
    // The commit already has a preview deployment (the PR's build).
    const preview = await env.awaitExternal!(actx, params({}), live);
    expect(preview).toMatchObject({ preview_url: expect.any(String) });
    const previewId = preview!.deployment_id;
    // A production line for the same commit must wait for (here: get) the production build, not the preview.
    const prodParams = env.defaults!({ values: {}, target: "production" }, h.ctx);
    const prod = await env.awaitExternal!(actx, prodParams, live);
    expect(prod?.deployment_id).toBeDefined();
    expect(prod!.deployment_id).not.toBe(previewId);
    const listed = h.sim.state.vercel.projects.prj_demo!.deployments.find((d) => d.uid === prod!.deployment_id);
    expect(listed?.target).toBe("production");
    // And the preview lookup still returns the preview.
    expect((await env.awaitExternal!(actx, params({}), live))!.deployment_id).toBe(previewId);
  });

  it("the deploy op keys its deployment by environment and commit", async () => {
    const prodCtx = { ...h.ctx, env: "production" };
    const actx = { ...h.actx("vercel"), ctx: prodCtx };
    const live = await deploy.read(actx, {});
    expect(live?.resources[0]?.key).toBe(`deployment:production:${SHA}`);
    expect(h.sim.state.vercel.projects.prj_demo!.deployments.filter((d) => d.target === "production")).toHaveLength(1);
  });

  it("awaitExternal: ok → url, never → null, fail → throws, double → newest, building → null", async () => {
    const actx = h.actx("vercel");
    const live = { resources: [], outputs: {} };
    await h.chaos({ deploy: "never" });
    expect(await env.awaitExternal!(actx, params({}), live)).toBeNull();

    await h.chaos({ deploy: "ok" });
    const out = await env.awaitExternal!(actx, params({}), live);
    expect(out).toEqual({ preview_url: "https://prj_demo-abcdef12.vercel.app", deployment_id: expect.stringMatching(/^dpl_/) });

    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    await h.chaos({ deploy: "fail" });
    await expect(env.awaitExternal!(actx, params({}), live)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/deployment dpl_\d+ ended ERROR/) });

    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    await h.chaos({ deploy: "double" });
    expect(await env.awaitExternal!(actx, params({}), live)).toMatchObject({ preview_url: "https://prj_demo-abcdef12-2.vercel.app" });

    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    await h.chaos({ deploy: "delay:0.3" });
    expect(await env.awaitExternal!(actx, params({}), live)).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    expect(await env.awaitExternal!(actx, params({}), live)).not.toBeNull();
  });

  it("awaitExternal: a deployment list that keeps failing transiently means still waiting, not failed", async () => {
    await h.chaos({ fail_on: "GET /vercel/v7/deployments", fail_next: 10, status: 502 });
    expect(await env.awaitExternal!(h.actx("vercel"), params({}), { resources: [], outputs: {} })).toBeNull();
  });

  it("awaitExternal: a build canceled by a newer push on the branch fails", async () => {
    await h.chaos({ deploy: "cancel", deploy_ms: 500 });
    const post = (sha: string) =>
      fetch(`${h.sim.url}/vercel/v13/deployments`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ name: "prj_demo", gitSource: { type: "github", repoId: 100000, ref: "feat/x", sha } }) });
    await post(SHA);
    await post("f".repeat(40));
    await expect(env.awaitExternal!(h.actx("vercel"), params({}), { resources: [], outputs: {} })).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/CANCELED/) });
  });

  it("redeploys when the newest deployment predates the env write", async () => {
    const actx = h.actx("vercel");
    await h.chaos({ deploy: "stale" });
    const r = await env.apply(actx, params({ A: "1" }), null);
    expect(r.notes).toEqual({ redeployed: true });
    const deployments = h.sim.state.vercel.projects.prj_demo!.deployments;
    expect(deployments).toHaveLength(2);
    expect(new Set(deployments.map((d) => d.url)).size).toBe(2); // every deployment has its own URL
    expect((await h.writes()).filter((w) => DEPLOY.test(w.path))).toHaveLength(1);

    // A fresh deployment after the write: no redeploy.
    await fetch(`${h.sim.url}/_reset`, { method: "POST" });
    const r2 = await env.apply(actx, params({ A: "1" }), null);
    expect(r2.notes).toBeUndefined();
    expect(h.sim.state.vercel.projects.prj_demo!.deployments).toHaveLength(1);
  });

  it("reads a value the list does not decrypt from GET /v1/projects/:id/env/:id, so it diffs unchanged", async () => {
    const actx0 = h.actx("vercel");
    const p = params({ A: "plain-text-value" });
    await env.apply(actx0, p, null);
    // The list's `decrypt` parameter is deprecated: model a list that answers ciphertext with `decrypted: false`.
    const proxy = await recordingProxy(h.sim.url, (req, body) => {
      if (req.method === "GET" && /\/v10\/projects\/[^/]+\/env$/.test(req.path)) {
        const b = body as { envs: Array<Record<string, unknown>> };
        return { ...b, envs: b.envs.map((e) => ({ ...e, value: "ciphertext", decrypted: false })) };
      }
      return body;
    });
    try {
      const actx = h.actx("vercel", undefined, { env: { ...h.env, VERCEL_API_URL: `${proxy.url}/vercel` } });
      const live = await env.read(actx, p);
      expect(env.diff(live, p).map((d) => d.kind)).toEqual(["unchanged"]);
      expect(proxy.log.filter((x) => /^\/vercel\/v1\/projects\/prj_demo\/env\/env_/.test(x.path))).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it("an env list that ignores the page cursor yields each variable once", async () => {
    await h.close();
    h = await harness({ vercel: { projects: { prj_demo: { envs: [{ key: "S1", value: "1", target: "preview" }] } } } });
    const proxy = await recordingProxy(h.sim.url, (req, body) => (req.method === "GET" && req.path.endsWith("/env") ? { ...(body as object), pagination: { count: 1, next: 1700000000000, prev: null } } : body));
    try {
      const actx = h.actx("vercel", undefined, { env: { ...h.env, VERCEL_API_URL: `${proxy.url}/vercel` } });
      expect((await env.listScope!(actx, params({}, { branch: "*" }))).map((r) => r.key)).toEqual(["env:preview:*:S1"]);
    } finally {
      await proxy.close();
    }
  });

  it("names a failed upsert entry reported as `envVarKey`", async () => {
    const proxy = await recordingProxy(h.sim.url, (req, body) => (req.method === "POST" && UPSERT.test(req.path) ? { created: [], failed: [{ error: { code: "ENV_CONFLICT", envVarKey: "A", message: "value: s3cret" } }] } : body));
    try {
      const actx = h.actx("vercel", undefined, { env: { ...h.env, VERCEL_API_URL: `${proxy.url}/vercel` } });
      await expect(env.apply(actx, params({ A: "s3cret" }), null)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: "vercel: the bulk upsert rejected 1 env var(s): A" });
    } finally {
      await proxy.close();
    }
  });

  it("awaitExternal reads `readyState` (the spec's required field), waits while `url` is not set, and treats BLOCKED as failed", async () => {
    let mode: "building" | "blocked" | "ready" = "building";
    const proxy = await recordingProxy(h.sim.url, (req, body) => {
      if (req.method !== "GET" || !req.path.endsWith("/v7/deployments")) return body;
      const b = body as { deployments: Array<Record<string, unknown>> };
      return {
        ...b,
        deployments: b.deployments.map(({ state: _s, ...d }) => (mode === "building" ? { ...d, readyState: "BUILDING", url: null } : mode === "blocked" ? { ...d, readyState: "BLOCKED" } : d)),
      };
    });
    try {
      const actx = h.actx("vercel", undefined, { env: { ...h.env, VERCEL_API_URL: `${proxy.url}/vercel` } });
      const live = { resources: [], outputs: {} };
      expect(await env.awaitExternal!(actx, params({}), live)).toBeNull();
      mode = "ready";
      expect(await env.awaitExternal!(actx, params({}), live)).toMatchObject({ preview_url: "https://prj_demo-abcdef12.vercel.app" });
      mode = "blocked";
      await expect(env.awaitExternal!(actx, params({}), live)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/ended BLOCKED/) });
    } finally {
      await proxy.close();
    }
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

  it("creates a deployment (intent first) and polls it QUEUED → BUILDING → READY; destroy is a no-op", async () => {
    const actx = h.actx("vercel");
    await h.chaos({ deploy: "never", deploy_ms: 300 });
    expect(await deploy.read(actx, {})).toBeNull();
    expect(deploy.diff(null, {})[0]?.kind).toBe("create");
    const r = await deploy.apply(actx, {}, null);
    expect(r.created).toEqual([`deployment:preview:${SHA}`]);
    expect(h.intents).toEqual([{ keys: [`deployment:preview:${SHA}`], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", DEPLOY)).toBe(0);
    expect(r.outputs).toEqual({ preview_url: "https://prj_demo-abcdef12.vercel.app", deployment_id: expect.stringMatching(/^dpl_/) });
    const live = await deploy.read(actx, {});
    expect(live?.outputs).toEqual(r.outputs);
    expect(deploy.diff(live, {})).toEqual([{ key: `deployment:preview:${SHA}`, kind: "unchanged", label: `preview deployment ${r.outputs.deployment_id}` }]);
    await deploy.destroy(actx, r.resources);
    expect(await deploy.read(actx, {})).not.toBeNull();
  });

  it("a deployment of this sha still building is adopted and watched, never duplicated", async () => {
    const actx = h.actx("vercel");
    await h.chaos({ deploy: "never", deploy_ms: 400 });
    const first = await (
      await fetch(`${h.sim.url}/vercel/v13/deployments`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ name: "prj_demo", gitSource: { type: "github", repoId: 100000, ref: "feat/x", sha: SHA } }) })
    ).json() as { id: string };
    const live = await deploy.read(actx, {});
    expect(live?.resources[0]?.id).toBe(first.id);
    expect(deploy.diff(live, {})[0]?.kind).toBe("update");

    // Too short to finish: times out, still without a second build.
    await expect(deploy.apply({ ...actx, env: { ...h.env, SPONSON_DEPLOY_TIMEOUT_MS: "50" } }, {}, live)).rejects.toMatchObject({ code: "WAIT_TIMEOUT", message: expect.stringMatching(/not ready after 50ms/) });
    const r = await deploy.apply(actx, {}, await deploy.read(actx, {}));
    expect(r.created).toEqual([]);
    expect(h.intents).toEqual([]);
    expect(r.outputs.deployment_id).toBe(first.id);
    expect(h.sim.state.vercel.projects.prj_demo!.deployments).toHaveLength(1);
  });

  it("deploys through the project's Git connection: `gitSource` carries the linked repository's id", async () => {
    await h.chaos({ deploy: "never" });
    const r = await deploy.apply(h.actx("vercel"), {}, null);
    expect(r.outputs.preview_url).toBe("https://prj_demo-abcdef12.vercel.app");
    // The sim, like the spec, refuses a GitHub gitSource without `repoId` (or `org` + `repo`).
    expect((await h.writes()).filter((w) => DEPLOY.test(w.path) && w.failed)).toEqual([]);
  });

  it("refuses to deploy a project with no Git connection, before creating anything", async () => {
    h.sim.state.vercel.projects.prj_demo!.link = null;
    await h.chaos({ deploy: "never" });
    await expect(deploy.apply(h.actx("vercel"), {}, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/not connected to a Git repository/) });
    expect(await h.writes()).toEqual([]);
  });

  it("fails with PROVIDER_INVALID when the deployment errors", async () => {
    await h.chaos({ deploy: "fail" });
    await expect(deploy.apply(h.actx("vercel"), {}, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/ended ERROR/) });
  });
});

describe("vercel env adopt", () => {
  const env = vercelAdapter.ops.env!;
  const ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: 1 }, scope: "pr-1" };
  const keys = ["env:preview:feat/x:A", "env:preview:*:B", "env:preview:*:C", "env:preview:fix/a:b:D", "env:production:*:E"];

  it("groups by (target, branch), keeps values, and names the branch only when it is not the current one", () => {
    const lines = env.adopt!(keys.map((key) => ({ key })), ctx);
    expect(lines).toEqual([
      { id: "env-preview", params: { target: "preview", values: { A: { keep: true } } }, keys: ["env:preview:feat/x:A"] },
      { id: "env-preview-shared", params: { target: "preview", branch: "*", values: { B: { keep: true }, C: { keep: true } } }, keys: ["env:preview:*:B", "env:preview:*:C"] },
      { id: "env-preview-fix/a:b", params: { target: "preview", branch: "fix/a:b", values: { D: { keep: true } } }, keys: ["env:preview:fix/a:b:D"] },
      { id: "env-production-shared", params: { target: "production", branch: "*", values: { E: { keep: true } } }, keys: ["env:production:*:E"] },
    ]);
  });

  it("each adopted line declares exactly the keys it adopted, all unchanged against live", () => {
    for (const line of env.adopt!(keys.map((key) => ({ key })), ctx)) {
      const params = resolveParams(env.defaults!(line.params, ctx), new Map()).params;
      const live = { resources: line.keys.map((key) => ({ key, id: key, hash: "h" })), outputs: {} };
      const diffs = env.diff(live, params);
      expect(diffs.map((d) => d.key)).toEqual(line.keys);
      expect(diffs.every((d) => d.kind === "unchanged")).toBe(true);
    }
  });

  it("refuses a key that is not an env key", () => {
    expect(() => env.adopt!([{ key: "deployment:abc" }], ctx)).toThrow(SponsonError);
  });
});
