/** Unit tests for the Contentful adapter against the in-process sim (assumptions CF1… in packages/sim/src/routes/contentful.ts). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentfulAdapter } from "./contentful.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const env = contentfulAdapter.ops.environment!;
const access = contentfulAdapter.ops.api_key_access!;
const provider = { space: "space1" };
const params = { name: "pr-42", source: "master" };
const KEY = "environment:pr-42";
const FAST = { SPONSON_CONTENTFUL_POLL_MS: "1" };

describe("contentful environment", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ contentful: { spaces: { space1: { environments: ["master", "staging"], api_keys: { key1: ["master"] } } }, readyPolls: 2 } });
  });
  afterEach(() => h.close());

  const actx = (e: NodeJS.ProcessEnv = {}) => h.actx("contentful", provider, { env: { ...h.env, ...FAST, ...e } });
  const envs = () => h.sim.state.contentful.spaces.space1!.environments;

  it("copies the source, waits until it is ready, reads back unchanged, destroys only the copy", async () => {
    expect(await env.read(actx(), params)).toBeNull();
    expect(env.diff(null, params)).toEqual([{ key: KEY, kind: "create", label: "Contentful environment pr-42", before: { state: "absent" }, after: { state: "literal", value: "copy of master" } }]);

    const r = await env.apply(actx(), { ...params, source: "staging" }, null);
    expect(r).toMatchObject({ created: [KEY], outputs: { environment_id: "pr-42", status: "ready" }, resources: [{ key: KEY, id: "pr-42" }] });
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "PUT", /^\/contentful\/spaces\/space1\/environments\/pr-42$/)).toBe(0);
    expect(envs()["pr-42"]).toMatchObject({ source: "staging", status: "ready" });

    const live = await env.read(actx(), params);
    expect(env.diff(live, params)).toEqual([{ key: KEY, kind: "unchanged", label: "Contentful environment pr-42" }]);
    const writes = h.sim.state.writes.length;
    expect((await env.apply(actx(), params, live)).created).toEqual([]);
    expect(h.sim.state.writes.length).toBe(writes);

    await env.destroy(actx(), r.resources);
    expect(Object.keys(envs())).toEqual(["master", "staging"]);
    await env.destroy(actx(), r.resources); // already gone is success (CF5)
    // An intent never located, and `master` whatever a ledger says, are never deleted.
    await env.destroy(actx(), [{ key: "environment:x", id: "", hash: "" }, { key: "environment:master", id: "master", hash: "" }]);
    expect(Object.keys(envs())).toEqual(["master", "staging"]);
  });

  it("a copy not ready in time is WAIT_TIMEOUT; the next plan shows it as an update to ready, and apply waits without writing", async () => {
    h.sim.state.contentful.readyPolls = 1000;
    await expect(env.apply(actx({ SPONSON_CONTENTFUL_READY_TIMEOUT_MS: "5" }), params, null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(h.intents.map((i) => i.keys)).toEqual([[KEY]]);
    const live = await env.read(actx(), params);
    expect(env.diff(live, params)).toEqual([{ key: KEY, kind: "update", label: "Contentful environment pr-42", before: { state: "literal", value: "inProgress" }, after: { state: "literal", value: "ready" } }]);
    envs()["pr-42"]!.pending = 0;
    const writes = h.sim.state.writes.length;
    const r = await env.apply(actx(), params, live);
    expect(r).toMatchObject({ created: [], outputs: { status: "ready" } });
    expect(h.sim.state.writes.length).toBe(writes);
  });

  it("a create whose answer was lost finds the environment (409) and waits for it, claiming nothing itself", async () => {
    envs()["pr-42"] = { id: "pr-42", name: "pr-42", source: "master", version: 1, status: "queued", pending: 0, createdBy: "api" };
    const r = await env.apply(actx(), params, null);
    expect(r).toMatchObject({ created: [], outputs: { status: "ready" } });
  });

  it("a failed copy is refused with what to do", async () => {
    h.sim.state.contentful.failing = ["pr-42"];
    await expect(env.apply(actx(), params, null)).rejects.toThrow(/copying environment pr-42 failed; delete it/);
  });

  it("refuses master, ids Contentful does not take, and a source that does not exist", async () => {
    await expect(env.apply(actx(), { name: "master" }, null)).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(env.apply(actx(), { name: "feat/x" }, null)).rejects.toThrow(/not an environment id/);
    await expect(env.apply(actx(), { name: "a".repeat(41) }, null)).rejects.toThrow(/not an environment id/);
    await expect(env.apply(actx(), { name: "pr-42", source: "nope" }, null)).rejects.toThrow(/`source` environment nope does not exist/);
    expect(h.sim.state.writes).toHaveLength(0);
  });

  it("needs the space and the token", async () => {
    await expect(env.read(h.actx("contentful", {}, { env: h.env }), params)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    const { CONTENTFUL_MANAGEMENT_TOKEN: _t, ...noToken } = h.env;
    await expect(env.read(h.actx("contentful", provider, { env: noToken }), params)).rejects.toThrow(/CONTENTFUL_MANAGEMENT_TOKEN/);
  });

  it("verifies the credential against the space, or the account without one", async () => {
    expect(await contentfulAdapter.verifyCredential!(actx())).toEqual({ request: "GET /spaces/space1/environments", reaches: "space space1" });
  });
});

describe("contentful api_key_access", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ contentful: { spaces: { space1: { environments: ["master", "pr-42"], api_keys: { key1: ["master"] } } } } });
  });
  afterEach(() => h.close());

  const actx = () => h.actx("contentful", provider, { env: { ...h.env, ...FAST } });
  const key1 = () => h.sim.state.contentful.spaces.space1!.apiKeys.key1!;
  const p = { api_key_id: "key1", environment: "pr-42" };
  const AKEY = "api_key:key1:environment:pr-42";

  it("adds the environment to the key with the version read, keeps the others, removes only its own on destroy", async () => {
    expect(access.lockOn!(p, provider)).toBe("contentful:space1:api_key:key1");
    expect(await access.read(actx(), p)).toBeNull();
    const r = await access.apply(actx(), p, null);
    expect(r).toMatchObject({ created: [AKEY], resources: [{ key: AKEY, id: "key1/pr-42" }] });
    expect(h.intents).toEqual([{ keys: [AKEY], writesBefore: 0 }]);
    expect(key1()).toMatchObject({ environments: ["master", "pr-42"], version: 2 });

    const live = await access.read(actx(), p);
    expect(access.diff(live, p)).toEqual([{ key: AKEY, kind: "unchanged", label: "Contentful API key key1 reading pr-42" }]);

    // Someone adds another environment by hand: destroy removes only this line's.
    key1().environments.push("staging");
    key1().version++;
    await access.destroy(actx(), r.resources);
    expect(key1().environments).toEqual(["master", "staging"]);
    await access.destroy(actx(), r.resources); // already removed: no write
    expect(key1().version).toBe(4);
  });

  it("a write that loses the version race (409) reads again and writes once more", async () => {
    const sim = h.sim.state.contentful;
    const original = key1();
    let looks = 0;
    // The second look at the key is the first PUT's: another writer moved its version on just before it.
    Object.defineProperty(sim.spaces.space1!.apiKeys, "key1", {
      configurable: true,
      get() {
        if (++looks === 2) original.version++;
        return original;
      },
    });
    await access.apply(actx(), p, null);
    expect(h.sim.state.writes.filter((w) => w.method === "PUT").length).toBe(2);
    expect(original.environments).toEqual(["master", "pr-42"]);
  });

  it("refuses a key that does not exist", async () => {
    await expect(access.read(actx(), { ...p, api_key_id: "nope" })).rejects.toThrow(/API key nope does not exist/);
  });
});
