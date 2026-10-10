/** Unit tests for the Netlify adapter against the in-process sim. */
import { pendingMarker, resolveParams } from "@sponson/core";
import type { NetlifySeed } from "@sponson/sim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { netlifyAdapter } from "./netlify.js";
import { harness, recordingProxy, SHA, writeIndex, type Harness } from "./testing.js";

const env = netlifyAdapter.ops.env!;
const provider = { site: "site_demo", account: "acme" };
const SENS = { state: "sensitive" };
const ENV_LIST = /^\/netlify\/accounts\/acme\/env$/;

/** A site whose git integration has seen the harness's commit on `feat/x`, as a pull request (42) or a plain push. */
function site(extra: Partial<NetlifySeed["sites"][string]> = {}): NetlifySeed {
  return { sites: { site_demo: { name: "demo-site", account: "acme", pushes: [{ sha: SHA, branch: "feat/x", pr: 42 }, { sha: SHA, branch: "main" }], ...extra } } };
}

describe("netlify env", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ netlify: site() });
  });
  afterEach(() => h.close());

  const params = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => env.defaults!({ values, ...extra }, h.ctx);
  const vars = () => h.sim.state.netlify.sites.site_demo!.envs;

  it("defaults the context from ctx (the git branch's value in previews) and declares the environment it writes", () => {
    expect(params({})).toEqual({ values: {}, context: "branch", branch: "feat/x" });
    expect(env.defaults!({}, { ...h.ctx, env: "production" })).toEqual({ context: "production" });
    expect(params({}, { context: "deploy-preview" })).toEqual({ values: {}, context: "deploy-preview" });
    expect(env.writesEnvironment!(params({}, { context: "production" }), h.ctx)).toBe("production");
    expect(env.writesEnvironment!(params({}), h.ctx)).toBe("branch");
    expect(env.writesEnvironment!({}, { ...h.ctx, env: "production" })).toBe("production");
  });

  it("create, unchanged with zero writes, update in place; intent before the create; values never shown", async () => {
    const actx = h.actx("netlify", provider);
    const p = params({ DATABASE_URL: "postgres://a", API_KEY: "k1" });
    expect(await env.read(actx, p)).toBeNull();
    expect(env.diff(null, p)[0]).toEqual({ key: "env:branch:feat/x:DATABASE_URL", kind: "create", label: "DATABASE_URL (branch feat/x)", before: { state: "absent" }, after: SENS });

    const r = await env.apply(actx, p, null);
    expect(r.created).toEqual(["env:branch:feat/x:DATABASE_URL", "env:branch:feat/x:API_KEY"]);
    expect(h.intents).toEqual([{ keys: r.created, writesBefore: 0 }]);
    expect(writeIndex(h, "POST", ENV_LIST)).toBe(0);
    expect(vars().find((e) => e.key === "DATABASE_URL")!.values).toMatchObject([{ context: "branch", context_parameter: "feat/x", value: "postgres://a" }]);

    const live = await env.read(actx, p);
    expect(live?.resources).toEqual(r.resources);
    expect(env.diff(live, p).every((d) => d.kind === "unchanged")).toBe(true);
    const n = (await h.writes()).length;
    expect((await env.apply(actx, p, live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(n);

    const p2 = params({ DATABASE_URL: "postgres://b", API_KEY: "k1" });
    expect(env.diff(live, p2)[0]).toMatchObject({ kind: "update", before: SENS, after: SENS });
    const r2 = await env.apply(actx, p2, live);
    expect(r2.created).toEqual([]);
    expect(h.intents).toHaveLength(1);
    expect(writeIndex(h, "PATCH", /\/env\/DATABASE_URL$/, n)).toBeGreaterThanOrEqual(n);
    // Updated in place: same value id.
    expect(r2.resources[0]!.id).toBe(r.resources[0]!.id);
    expect(env.diff(await env.read(actx, p2), p2).every((d) => d.kind === "unchanged")).toBe(true);
  });

  it("adds its context's value to a variable a human made, and destroy removes only that value", async () => {
    await h.close();
    h = await harness({ netlify: site({ envs: [{ key: "API_URL", values: [{ context: "production", value: "https://api" }] }] }) });
    const actx = h.actx("netlify", provider);
    const p = params({ API_URL: "https://preview-api" }, { context: "deploy-preview" });
    const r = await env.apply(actx, p, await env.read(actx, p));
    expect(r.created).toEqual(["env:deploy-preview:*:API_URL"]);
    expect(writeIndex(h, "PATCH", /\/env\/API_URL$/)).toBeGreaterThanOrEqual(0);
    expect(writeIndex(h, "POST", ENV_LIST)).toBe(-1);
    expect(vars()[0]!.values.map((v) => v.context)).toEqual(["production", "deploy-preview"]);

    await env.destroy(actx, r.resources);
    expect(vars()).toHaveLength(1);
    expect(vars()[0]!.values).toMatchObject([{ context: "production", value: "https://api" }]);
    await env.destroy(actx, r.resources); // already gone is success
  });

  it("destroy deletes a variable it leaves with no value at all", async () => {
    const actx = h.actx("netlify", provider);
    const r = await env.apply(actx, params({ A: "1" }), null);
    await env.destroy(actx, r.resources);
    expect(vars()).toHaveLength(0);
  });

  it("two contexts of one variable are two resources; destroying one leaves the other", async () => {
    const actx = h.actx("netlify", provider);
    const prod = params({ A: "p" }, { context: "production" });
    const branch = params({ A: "b" });
    const rp = await env.apply(actx, prod, null);
    const rb = await env.apply(actx, branch, null);
    expect(rp.resources[0]!.key).toBe("env:production:*:A");
    expect(rb.resources[0]!.key).toBe("env:branch:feat/x:A");
    expect(env.diff(await env.read(actx, prod), prod)[0]!.kind).toBe("unchanged");
    await env.destroy(actx, rb.resources);
    expect(vars()[0]!.values).toMatchObject([{ context: "production", value: "p" }]);
    expect(await env.read(actx, branch)).toBeNull();
  });

  it("refuses a variable with one value for all contexts, and writes nothing", async () => {
    await h.close();
    h = await harness({ netlify: site({ envs: [{ key: "A", values: [{ context: "all", value: "x" }] }] }) });
    const actx = h.actx("netlify", provider);
    await expect(env.read(actx, params({ A: "1" }))).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
    await expect(env.apply(actx, params({ A: "1" }), null)).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
    expect(await h.writes()).toHaveLength(0);
  });

  it("a variable created between our list and our POST (400) gets its value by PATCH instead, announced first", async () => {
    await h.close();
    h = await harness({ netlify: site({ envs: [{ key: "A", values: [{ context: "production", value: "p" }] }] }) });
    // The first list does not show A yet, as if it were created right after it.
    let lists = 0;
    const proxy = await recordingProxy(h.sim.url, (req, body) => (req.method === "GET" && req.path.endsWith("/env") && lists++ === 0 ? [] : body));
    try {
      const actx = h.actx("netlify", provider, { env: { ...h.env, NETLIFY_API_URL: `${proxy.url}/netlify` } });
      const r = await env.apply(actx, params({ A: "1" }), null);
      expect(r.created).toEqual(["env:branch:feat/x:A"]);
      expect(proxy.log.map((x) => x.method)).toEqual(expect.arrayContaining(["POST", "PATCH"]));
      expect(vars()[0]!.values.map((v) => v.context)).toEqual(["production", "branch"]);
    } finally {
      await proxy.close();
    }
  });

  it("a POST refused for another reason is not retried as a PATCH", async () => {
    const actx = h.actx("netlify", provider);
    await h.chaos({ fail_on: "POST /netlify/accounts/*", fail_next: 1, status: 400 });
    await expect(env.apply(actx, params({ A: "1" }), null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
  });

  it("a secret variable is hashed as unreadable: recorded as read() sees it, so it never reports drift", async () => {
    await h.close();
    h = await harness({ netlify: site({ envs: [{ key: "TOKEN", is_secret: true, values: [{ context: "production", value: "s" }] }] }) });
    const actx = h.actx("netlify", provider);
    const p = params({ TOKEN: "t1" });
    const r = await env.apply(actx, p, await env.read(actx, p));
    const live = await env.read(actx, p);
    expect(live?.resources[0]!.hash).toBe(r.resources[0]!.hash);
    // The value cannot be compared, so it is always written again (like Vercel's `sensitive`).
    expect(env.diff(live, p)[0]!.kind).toBe("update");
  });

  it("looks the account up from the site when the plan does not name it", async () => {
    const actx = h.actx("netlify", { site: "site_demo" });
    await env.apply(actx, params({ A: "1" }), null);
    expect(h.sim.state.writes.some((w) => w.path.startsWith("/netlify/accounts/acct_acme/env"))).toBe(true);
  });

  it("rejects bad params with PARAM_INVALID before calling the API", async () => {
    const actx = h.actx("netlify", provider);
    await expect(env.read(actx, { context: "all", values: {} })).rejects.toMatchObject({ code: "PARAM_INVALID", details: { param: "context" } });
    await expect(env.read(actx, { context: "branch", values: {} })).rejects.toMatchObject({ code: "PARAM_INVALID", details: { param: "branch" } });
    await expect(env.read(actx, { context: "production", branch: "x", values: {} })).rejects.toMatchObject({ code: "PARAM_INVALID", details: { param: "branch" } });
    await expect(env.read(actx, { context: "production", branch: 3, values: {} })).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(env.read(actx, { context: "production", values: [] })).rejects.toMatchObject({ code: "PARAM_INVALID", details: { param: "values" } });
    expect(await h.writes()).toHaveLength(0);
  });

  it("pending markers diff with their reference; apply refuses them", async () => {
    const p = params({ DATABASE_URL: pendingMarker("db.connection_string") });
    expect(env.diff(null, p)[0]!.after).toEqual({ state: "pending", ref: "db.connection_string" });
    await expect(env.apply(h.actx("netlify", provider), p, null)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("listScope lists every value of the line's context and branch, whoever set it", async () => {
    await h.close();
    h = await harness({
      netlify: site({
        envs: [
          { key: "A", values: [{ context: "branch", context_parameter: "feat/x", value: "a" }, { context: "production", value: "p" }] },
          { key: "B", values: [{ context: "branch", context_parameter: "other", value: "b" }] },
        ],
      }),
    });
    const listed = await env.listScope!(h.actx("netlify", provider), params({}));
    expect(listed.map((r) => r.key)).toEqual(["env:branch:feat/x:A"]);
  });

  it("names a missing token, site or account", async () => {
    await expect(env.read({ ...h.actx("netlify", provider), env: {} }, params({ A: "1" }))).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    await expect(env.read(h.actx("netlify", {}), params({ A: "1" }))).rejects.toMatchObject({ code: "PLAN_INVALID" });
    await expect(env.read(h.actx("netlify", { site: "nope" }), params({ A: "1" }))).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("a GET that answers 502 once is retried", async () => {
    await h.chaos({ fail_on: "GET /netlify/accounts/*", fail_next: 1, status: 502 });
    expect(await env.read(h.actx("netlify", provider), params({ A: "1" }))).toBeNull();
  });
});

describe("netlify env: the deploy barrier", () => {
  let h: Harness;
  afterEach(() => h.close());
  const start = async (chaos: Record<string, unknown> = {}) => {
    h = await harness({ netlify: site(), chaos: chaos as never });
  };
  const params = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => env.defaults!({ values, ...extra }, h.ctx);

  it("the Deploy Preview of this commit, once ready: permalink, deploy id and the pull request's URL", async () => {
    await start();
    const actx = h.actx("netlify", provider);
    const p = params({ A: "1" });
    const r = await env.apply(actx, p, null);
    expect(r.notes).toBeUndefined();
    const out = await env.awaitExternal!(actx, p, { resources: r.resources, outputs: {} });
    const d = h.sim.state.netlify.sites.site_demo!.deploys.find((x) => x.context === "deploy-preview")!;
    expect(out).toEqual({ preview_url: `https://${d.id}--demo-site.netlify.app`, deploy_id: d.id, deploy_preview_url: "https://deploy-preview-42--demo-site.netlify.app" });
  });

  it("production lines wait for the production deploy; dev lines have no deploy", async () => {
    await start();
    const actx = h.actx("netlify", provider);
    const p = params({ A: "1" }, { context: "production" });
    await env.apply(actx, p, null);
    const out = await env.awaitExternal!(actx, p, { resources: [], outputs: {} });
    const d = h.sim.state.netlify.sites.site_demo!.deploys.find((x) => x.context === "production")!;
    expect(out).toMatchObject({ deploy_id: d.id, deploy_preview_url: `https://${d.id}--demo-site.netlify.app` });
    await expect(env.awaitExternal!(actx, params({ A: "1" }, { context: "dev" }), { resources: [], outputs: {} })).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("never → null; building → null then ready; fail → throws", async () => {
    await start({ deploy: "never" });
    let actx = h.actx("netlify", provider);
    await env.apply(actx, params({ A: "1" }), null);
    expect(await env.awaitExternal!(actx, params({ A: "1" }), { resources: [], outputs: {} })).toBeNull();
    await h.close();

    await start({ deploy: "delay:0.2" });
    actx = h.actx("netlify", provider);
    await env.apply(actx, params({ A: "1" }), null);
    expect(await env.awaitExternal!(actx, params({ A: "1" }), { resources: [], outputs: {} })).toBeNull();
    await new Promise((r) => setTimeout(r, 250));
    expect(await env.awaitExternal!(actx, params({ A: "1" }), { resources: [], outputs: {} })).toMatchObject({ deploy_preview_url: "https://deploy-preview-42--demo-site.netlify.app" });
    await h.close();

    await start({ deploy: "fail" });
    actx = h.actx("netlify", provider);
    await env.apply(actx, params({ A: "1" }), null);
    await expect(env.awaitExternal!(actx, params({ A: "1" }), { resources: [], outputs: {} })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
  });

  it("a branch line rebuilds the branch when the deploy predates the write, and only the new build counts", async () => {
    await start({ deploy: "stale" });
    const actx = h.actx("netlify", provider);
    const p = params({ A: "1" });
    const r = await env.apply(actx, p, null);
    expect(r.notes).toEqual({ redeployed: true });
    expect(writeIndex(h, "POST", /^\/netlify\/sites\/site_demo\/builds$/)).toBeGreaterThan(0);
    const fresh = h.sim.state.netlify.sites.site_demo!.deploys.find((d) => d.context === "branch-deploy")!;
    expect(await env.awaitExternal!(actx, p, { resources: r.resources, outputs: {} })).toMatchObject({ deploy_id: fresh.id });
  });

  it("a deploy-preview line cannot rebuild: the stale deploy is reported and never taken as ready", async () => {
    await start({ deploy: "stale" });
    const actx = h.actx("netlify", provider);
    const p = params({ A: "1" }, { context: "deploy-preview" });
    const r = await env.apply(actx, p, null);
    const stale = h.sim.state.netlify.sites.site_demo!.deploys[0]!;
    expect(r.notes).toEqual({ stale_deploy: stale.id });
    expect(writeIndex(h, "POST", /\/builds/)).toBe(-1);
    expect(await env.awaitExternal!(actx, p, { resources: r.resources, outputs: {} })).toBeNull();
  });

  it("a production line rebuilds production without a branch", async () => {
    await start({ deploy: "stale" });
    const actx = h.actx("netlify", provider);
    const r = await env.apply(actx, params({ A: "1" }, { context: "production" }), null);
    expect(r.notes).toEqual({ redeployed: true });
    expect(writeIndex(h, "POST", /^\/netlify\/sites\/site_demo\/builds$/)).toBeGreaterThan(0);
  });

  it("a deploy list that keeps failing transiently means still waiting, not failed", async () => {
    await start();
    const actx = h.actx("netlify", provider, { env: { ...h.env, SPONSON_HTTP_RETRIES: "0" } });
    await env.apply(actx, params({ A: "1" }), null);
    await h.chaos({ fail_on: "GET /netlify/sites/site_demo/deploys*", fail_next: 1, status: 503 });
    expect(await env.awaitExternal!(actx, params({ A: "1" }), { resources: [], outputs: {} })).toBeNull();
  });
});

describe("netlify env adopt", () => {
  const ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: 42 }, scope: "pr-42" };

  it("one line per context and branch, values kept, the branch named only when it is not the current one", () => {
    const lines = env.adopt!([{ key: "env:production:*:A" }, { key: "env:production:*:B" }, { key: "env:branch:feat/x:A" }, { key: "env:branch:release/*:C" }], ctx);
    expect(lines).toEqual([
      { id: "env-production", params: { context: "production", values: { A: { keep: true }, B: { keep: true } } }, keys: ["env:production:*:A", "env:production:*:B"] },
      { id: "env-branch", params: { context: "branch", values: { A: { keep: true } } }, keys: ["env:branch:feat/x:A"] },
      { id: "env-branch-release/*", params: { context: "branch", branch: "release/*", values: { C: { keep: true } } }, keys: ["env:branch:release/*:C"] },
    ]);
    const kept = resolveParams(env.defaults!(lines[1]!.params, ctx), new Map()).params;
    expect(env.diff({ resources: [{ key: "env:branch:feat/x:A", id: "x", hash: "h" }], outputs: {} }, kept)[0]!.kind).toBe("unchanged");
  });

  it("refuses a key that is not an env key", () => {
    expect(() => env.adopt!([{ key: "item:x" }], ctx)).toThrow(/not an env key/);
  });
});
