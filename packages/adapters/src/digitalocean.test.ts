/** Unit tests for the DigitalOcean adapter against the in-process sim (assumptions DO1… in packages/sim/src/routes/digitalocean.ts). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digitaloceanAdapter } from "./digitalocean.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const op = digitaloceanAdapter.ops.app!;
const KEY = "app:web-pr-42";
const FAST = { SPONSON_DIGITALOCEAN_POLL_MS: "1" };
const spec = (apiUrl = "https://api-pr-42.example.com") => ({
  name: "web-pr-42",
  services: [{ name: "web", github: { repo: "acme/web", branch: "feat/x" } }],
  envs: [
    { key: "API_URL", value: apiUrl, scope: "RUN_AND_BUILD_TIME" },
    { key: "DATABASE_URL", value: "postgres://u:p@db/x", type: "SECRET" },
  ],
});

describe("digitalocean app", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const actx = (env: NodeJS.ProcessEnv = {}) => h.actx("digitalocean", {}, { env: { ...h.env, ...FAST, ...env } });
  const apps = () => h.sim.state.digitalocean.apps;

  it("creates the app from the spec, waits for its deployment, reads back unchanged despite defaults and encrypted secrets", async () => {
    const params = { spec: spec() };
    expect(await op.read(actx(), params)).toBeNull();
    expect(op.diff(null, params)[0]).toMatchObject({ key: KEY, kind: "create" });
    expect(JSON.stringify(op.diff(null, params))).not.toContain("u:p@db");

    const r = await op.apply(actx(), params, null);
    expect(r.created).toEqual([KEY]);
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", /^\/digitalocean\/v2\/apps$/)).toBe(0);
    expect(r.outputs).toEqual({ app_id: apps()[0]!.id, live_url: expect.stringMatching(/^https:\/\/web-pr-42-/) });
    expect(apps()[0]!.spec).toMatchObject({ region: "nyc", envs: [{ key: "API_URL" }, { key: "DATABASE_URL", value: expect.stringMatching(/^EV\[/) }] });

    const live = await op.read(actx(), params);
    expect(op.diff(live, params)).toEqual([{ key: KEY, kind: "unchanged", label: "DigitalOcean app web-pr-42" }]);
    const writes = (await h.writes()).length;
    expect((await op.apply(actx(), params, live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(writes);
  });

  it("a changed spec is a whole-spec PUT and a new deployment; a console edit of a declared field is a hash change", async () => {
    const r = await op.apply(actx(), { spec: spec() }, null);
    const changed = { spec: spec("https://other.example.com") };
    let live = await op.read(actx(), changed);
    expect(op.diff(live, changed)[0]!.kind).toBe("update");
    const u = await op.apply(actx(), changed, live);
    expect(u.created).toEqual([]);
    expect(writeIndex(h, "PUT", new RegExp(`^/digitalocean/v2/apps/${String(r.outputs.app_id)}$`))).toBeGreaterThan(0);
    expect((apps()[0]!.spec.envs as Array<{ value: string }>)[0]!.value).toBe("https://other.example.com");
    expect((await op.read(actx(), changed))!.resources[0]!.hash).toBe(u.resources[0]!.hash);

    // A declared field edited in the console changes the live hash (changed drift); an undeclared one does not.
    h.sim.state.applyDrift("digitalocean.app.web-pr-42.env.API_URL", "https://edited.example.com");
    live = await op.read(actx(), changed);
    expect(live!.resources[0]!.hash).not.toBe(u.resources[0]!.hash);
    apps()[0]!.spec.envs = [{ key: "API_URL", value: "https://other.example.com", scope: "RUN_AND_BUILD_TIME", extra: 1 }, (apps()[0]!.spec.envs as unknown[])[1]];
    apps()[0]!.spec.alerts = [{ rule: "DEPLOYMENT_FAILED" }];
    expect((await op.read(actx(), changed))!.resources[0]!.hash).toBe(u.resources[0]!.hash);
  });

  it("a deployment that fails fails the line; wait: false returns before it ends", async () => {
    await h.close();
    h = await harness({ digitalocean: { failDeployments: true } });
    await expect(op.apply(actx(), { spec: spec() }, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    await h.close();
    h = await harness({ digitalocean: { deployPolls: 1000 } });
    const r = await op.apply(actx(), { spec: spec(), wait: false }, null);
    expect(r.outputs).toEqual({ app_id: apps()[0]!.id });
    await expect(op.apply(actx({ SPONSON_DIGITALOCEAN_DEPLOY_TIMEOUT_MS: "5" }), { spec: { ...spec(), name: "web-pr-43" } }, null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
  });

  it("an app with the name that exists already (409) is claimed and updated, not created", async () => {
    await h.close();
    h = await harness({ digitalocean: { apps: [spec("https://old.example.com")] } });
    const r = await op.apply(actx(), { spec: spec() }, null);
    expect(r.created).toEqual([]);
    expect(apps()).toHaveLength(1);
    expect((apps()[0]!.spec.envs as Array<{ value: string }>)[0]!.value).toBe("https://api-pr-42.example.com");
  });

  it("destroy deletes the app; gone and unlocated intents are fine", async () => {
    const r = await op.apply(actx(), { spec: spec() }, null);
    await op.destroy(actx(), r.resources);
    expect(apps()).toEqual([]);
    await op.destroy(actx(), r.resources);
    await op.destroy(actx(), [{ key: KEY, id: "", hash: "" }]);
  });

  it("reads every page of the app list; the spec needs a name", async () => {
    await h.close();
    h = await harness({ digitalocean: { apps: Array.from({ length: 150 }, (_x, i) => ({ name: `other-${i}` })).concat([spec()]) } });
    expect((await op.read(actx(), { spec: spec() }))!.resources[0]!.key).toBe(KEY);
    expect(() => op.diff(null, { spec: { services: [] } })).toThrow(/`spec.name` is required/);
    expect(() => op.diff(null, {})).toThrow(/`spec` is required/);
  });
});
