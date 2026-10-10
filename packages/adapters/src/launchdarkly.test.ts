/** Unit tests for the LaunchDarkly adapter against the in-process sim (packages/sim/src/routes/launchdarkly.ts). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingMarker, resolveParams, type ResolvedParams } from "@sponson/core";
import type { LaunchdarklySeed } from "@sponson/sim";
import { launchdarklyAdapter } from "./launchdarkly.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const op = launchdarklyAdapter.ops.flag_target!;
const provider = { project: "demo", environment: "preview" };
const FLAG = "new-checkout";
const KEY = `target:${FLAG}:user:pr-42`;
const PATCH_PATH = /^\/launchdarkly\/flags\/demo\/new-checkout$/;
const SEMANTIC = "application/json; domain-model=launchdarkly.semanticpatch";

function params(extra: Record<string, unknown> = {}, h?: Harness): ResolvedParams {
  return op.defaults!({ flag: FLAG, ...extra }, h?.ctx ?? { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: 42 }, scope: "pr-42" });
}

/** The sim's targets of the flag in `env`, as `kind:key → variation name`. */
function targets(h: Harness, env = "preview", flag = FLAG): Record<string, string | undefined> {
  const f = h.sim.state.launchdarkly.projects.demo!.flags[flag]!;
  return Object.fromEntries(f.environments[env]!.targets.map((t) => [`${t.contextKind}:${t.key}`, f.variations[t.variation]!.name]));
}

function seeded(extra: Partial<LaunchdarklySeed["projects"][string]> = {}, flag: NonNullable<LaunchdarklySeed["projects"][string]["flags"]>[string] = {}): Partial<{ launchdarkly: LaunchdarklySeed }> {
  return { launchdarkly: { projects: { demo: { environments: ["preview", "production"], flags: { [FLAG]: flag }, ...extra } } } };
}

describe("launchdarkly flag_target", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("defaults: the scope as the key, context kind user, variation true", () => {
    expect(params({}, h)).toEqual({ key: "pr-42", context_kind: "user", variation: true, flag: FLAG });
  });

  it("create, unchanged, move to another variation, destroy", async () => {
    const actx = h.actx("launchdarkly", provider);
    const p = params({}, h);
    expect(await op.read(actx, p)).toBeNull();
    expect(op.diff(null, p)).toEqual([{ key: KEY, kind: "create", label: `LaunchDarkly ${FLAG} → user pr-42`, before: { state: "absent" }, after: { state: "literal", value: "true" } }]);

    const r = await op.apply(actx, p, null);
    expect(r.created).toEqual([KEY]);
    expect(r.outputs).toMatchObject({ variation_name: "on", variation_value: "true" });
    // The intent was recorded before the patch was sent.
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "PATCH", PATCH_PATH)).toBe(0);
    expect(targets(h)).toEqual({ "user:pr-42": "on" });
    expect(targets(h, "production")).toEqual({});

    // apply; apply: the second performs zero writes.
    const live = await op.read(actx, p);
    expect(live?.resources).toEqual(r.resources);
    expect(op.diff(live, p)).toEqual([{ key: KEY, kind: "unchanged", label: `LaunchDarkly ${FLAG} → user pr-42` }]);
    const writes = (await h.writes()).length;
    expect((await op.apply(actx, p, live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(writes);

    // Serving "off" instead: one patch that removes and adds, so the key is never in two variations.
    const off = { ...p, variation: "off" };
    expect(op.diff(live, off)[0]).toMatchObject({ kind: "update", before: { state: "literal", value: "on (true)" }, after: { state: "literal", value: '"off"' } });
    const u = await op.apply(actx, off, live);
    expect(u.created).toEqual([]);
    expect(u.resources[0]!.hash).not.toBe(r.resources[0]!.hash);
    expect(u.resources[0]!.id).toBe(r.resources[0]!.id);
    expect(targets(h)).toEqual({ "user:pr-42": "off" });
    expect((await h.writes()).length).toBe(writes + 1);

    await op.destroy(actx, u.resources);
    expect(await op.read(actx, p)).toBeNull();
    expect(targets(h)).toEqual({});
    const after = (await h.writes()).length;
    await op.destroy(actx, u.resources); // already gone is success, and writes nothing
    expect((await h.writes()).length).toBe(after);
  });

  it("removes exactly its own target; the flag's other targets stay", async () => {
    await h.close();
    h = await harness(seeded({}, { targets: { preview: [{ key: "alice", variation: 0 }, { key: "pr-7", variation: 1 }, { contextKind: "org", key: "pr-42", variation: 0 }] } }));
    const actx = h.actx("launchdarkly", provider);
    const r = await op.apply(actx, params({}, h), null);
    expect(targets(h)).toEqual({ "user:alice": "on", "user:pr-7": "off", "org:pr-42": "on", "user:pr-42": "on" });
    await op.destroy(actx, r.resources);
    expect(targets(h)).toEqual({ "user:alice": "on", "user:pr-7": "off", "org:pr-42": "on" });
  });

  it("targets another context kind (listed in contextTargets) with a URL key", async () => {
    const actx = h.actx("launchdarkly", provider);
    const url = "https://app-git-feat-x.vercel.app";
    const p = params({ context_kind: "preview-url", key: url }, h);
    const r = await op.apply(actx, p, null);
    expect(r.created).toEqual([`target:${FLAG}:preview-url:${url}`]);
    expect(targets(h)).toEqual({ [`preview-url:${url}`]: "on" });
    expect(op.diff(await op.read(actx, p), p)[0]!.kind).toBe("unchanged");
    expect(await op.read(actx, params({ key: url }, h))).toBeNull(); // the same key as a user is another target
    await op.destroy(actx, r.resources);
    expect(targets(h)).toEqual({});
  });

  it("chooses the variation by name or by value, and refuses an unknown or ambiguous one at plan time", async () => {
    await h.close();
    const variations = [
      { value: "control", name: "Control" },
      { value: "treatment", name: "Treatment" },
      { value: 42, name: "answer" },
      { value: "42", name: "string" },
    ];
    h = await harness(seeded({}, { variations }));
    const actx = h.actx("launchdarkly", provider);
    await op.apply(actx, params({ variation: "Treatment" }, h), null);
    expect(targets(h)).toEqual({ "user:pr-42": "Treatment" });
    const byValue = params({ variation: "treatment" }, h);
    expect(op.diff(await op.read(actx, byValue), byValue)[0]!.kind).toBe("unchanged");
    await op.apply(actx, params({ variation: 42 }, h), await op.read(actx, byValue));
    expect(targets(h)).toEqual({ "user:pr-42": "answer" });
    await expect(op.read(actx, params({ variation: "missing" }, h))).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/no variation "missing".*Control \("control"\)/) });
    await expect(op.read(actx, params({ variation: "42" }, h))).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/several variations/) });
  });

  it("a target a human moved to another variation reads with a new hash and diffs as an update", async () => {
    const actx = h.actx("launchdarkly", provider);
    const p = params({}, h);
    const r = await op.apply(actx, p, null);
    await h.chaos({ drift: { "launchdarkly.target.new-checkout/preview/user/pr-42": "off" } });
    const live = await op.read(actx, p);
    expect(live?.resources[0]).toMatchObject({ key: KEY, id: r.resources[0]!.id });
    expect(live?.resources[0]!.hash).not.toBe(r.resources[0]!.hash);
    expect(op.diff(live, p)[0]).toMatchObject({ kind: "update", before: { state: "literal", value: "off (false)" } });
    await op.apply(actx, p, live);
    expect(targets(h)).toEqual({ "user:pr-42": "on" });
  });

  it("an existing target in the wanted variation (a lost answer, a stale read) is not added again", async () => {
    await h.close();
    h = await harness(seeded({}, { targets: { preview: [{ key: "pr-42", variation: 0 }] } }));
    const actx = h.actx("launchdarkly", provider);
    const r = await op.apply(actx, params({}, h), null); // live says absent; the fresh read says otherwise
    expect(r.created).toEqual([]);
    expect(h.intents).toEqual([]);
    expect(await h.writes()).toEqual([]);
  });

  it("a target a human made in another variation is moved, not claimed as created", async () => {
    await h.close();
    h = await harness(seeded({}, { targets: { preview: [{ key: "pr-42", variation: 1 }] } }));
    const r = await op.apply(h.actx("launchdarkly", provider), params({}, h), null);
    expect(r.created).toEqual([]);
    expect(targets(h)).toEqual({ "user:pr-42": "on" });
  });

  it("{ keep: true } leaves the variation alone and needs the target to exist", async () => {
    await h.close();
    h = await harness(seeded({}, { targets: { preview: [{ key: "pr-42", variation: 1 }] } }));
    const actx = h.actx("launchdarkly", provider);
    const kept = resolveParams(params({ variation: { keep: true } }, h), new Map()).params;
    const live = await op.read(actx, kept);
    expect(op.diff(live, kept)[0]!.kind).toBe("unchanged");
    expect((await op.apply(actx, kept, live)).outputs).toMatchObject({ variation_name: "off" });
    expect(await h.writes()).toEqual([]);
    expect(() => op.diff(null, kept)).toThrow(/keep/);
    const other = { ...kept, key: "nobody" };
    await expect(op.apply(actx, other, null)).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("a target key from a line not applied yet is pending: nothing read, a create shown", async () => {
    const p = params({ key: pendingMarker("env.preview_url") }, h);
    expect(await op.read(h.actx("launchdarkly", provider), p)).toBeNull();
    expect(op.diff(null, p)[0]).toMatchObject({ key: `target:${FLAG}:user:(pending)`, kind: "create" });
  });

  it("a concurrent change (409) is retried with a fresh read; a 502 on the patch is retried as idempotent", async () => {
    const actx = h.actx("launchdarkly", provider);
    await h.chaos({ fail_on: "PATCH /launchdarkly/flags/demo/new-checkout", fail_next: 1, status: 409 });
    await op.apply(actx, params({}, h), null);
    expect(targets(h)).toEqual({ "user:pr-42": "on" });
    await h.chaos({ fail_on: "PATCH /launchdarkly/flags/demo/new-checkout", fail_next: 1, status: 502 });
    await op.apply(actx, params({ variation: false }, h), null);
    expect(targets(h)).toEqual({ "user:pr-42": "off" });
  });

  it("an environment that requires approvals is refused with a message that says so", async () => {
    await h.close();
    h = await harness(seeded({ approvals: ["production"] }));
    const actx = h.actx("launchdarkly", { project: "demo", environment: "production" });
    await expect(op.apply(actx, params({}, h), null)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/requires approval/) });
  });

  it("names what is missing: the token, the project or environment, the flag, an environment, a param", async () => {
    const actx = h.actx("launchdarkly", provider);
    await expect(op.read({ ...actx, env: {} }, params({}, h))).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    await expect(op.read(h.actx("launchdarkly", { project: "demo" }), params({}, h))).rejects.toMatchObject({ code: "PLAN_INVALID" });
    await expect(op.read(actx, params({ flag: "nope" }, h))).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await expect(op.read(h.actx("launchdarkly", { project: "demo", environment: "staging" }), params({}, h))).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND", message: expect.stringMatching(/no environment staging/) });
    await expect(op.read(actx, { key: "x" })).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("destroy of a flag that is gone is success", async () => {
    await op.destroy(h.actx("launchdarkly", provider), [{ key: "target:deleted-flag:user:pr-42", id: "user:pr-42", hash: "x" }]);
    await expect(op.destroy(h.actx("launchdarkly", provider), [{ key: "item:x", id: "x", hash: "x" }])).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("listScope lists every individual target of the flag in the environment; adopt keeps their variations", async () => {
    await h.close();
    h = await harness(seeded({}, { targets: { preview: [{ key: "alice", variation: 0 }, { contextKind: "org", key: "acme:eu", variation: 1 }], production: [{ key: "bob", variation: 0 }] } }));
    const listed = await op.listScope!(h.actx("launchdarkly", provider), params({}, h));
    expect(listed.map((r) => r.key).sort()).toEqual([`target:${FLAG}:org:acme:eu`, `target:${FLAG}:user:alice`]);
    expect(op.adopt!(listed, h.ctx)).toEqual([
      { id: "flag_target", params: { flag: FLAG, key: "alice", context_kind: "user", variation: { keep: true } }, keys: [`target:${FLAG}:user:alice`] },
      { id: "flag_target", params: { flag: FLAG, key: "acme:eu", context_kind: "org", variation: { keep: true } }, keys: [`target:${FLAG}:org:acme:eu`] },
    ]);
    expect(op.adopt!([{ key: "other" }], h.ctx)).toEqual([]);
    expect(await op.listScope!(h.actx("launchdarkly", provider), { flag: pendingMarker("x.y") })).toEqual([]);
  });

  it("a response whose targets do not fit the flag is PROVIDER_RESPONSE", async () => {
    const env = h.sim.state.launchdarkly.projects.demo!.flags[FLAG]!.environments.preview!;
    env.targets.push({ contextKind: "user", key: "ghost", variation: 9, createdBy: "sim" });
    await expect(op.read(h.actx("launchdarkly", provider), params({}, h))).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
  });
});

describe("simulated LaunchDarkly (assumptions LD1, LD4, LD5)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const send = (headers: Record<string, string>, body: unknown) =>
    fetch(`${h.sim.url}/launchdarkly/flags/demo/${FLAG}`, { method: "PATCH", headers, body: JSON.stringify(body) });

  it("takes the token without Bearer, a semantic patch only with its media type, and adds a target once", async () => {
    const variationId = h.sim.state.launchdarkly.projects.demo!.flags[FLAG]!.variations[0]!._id;
    const add = { environmentKey: "preview", instructions: [{ kind: "addTargets", values: ["k"], variationId }] };
    expect((await send({ authorization: "Bearer api-x", "content-type": SEMANTIC }, add)).status).toBe(401);
    expect((await send({ authorization: "api-x", "content-type": "application/json" }, add)).status).toBe(400);
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, add)).status).toBe(200);
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, add)).status).toBe(200);
    expect(targets(h)).toEqual({ "user:k": "on" });
    // All or nothing: the second instruction is invalid, so the first is not applied either.
    const bad = { environmentKey: "preview", instructions: [{ kind: "removeTargets", values: ["k"], variationId }, { kind: "addTargets", values: ["k"], variationId: "nope" }] };
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, bad)).status).toBe(400);
    const other = h.sim.state.launchdarkly.projects.demo!.flags[FLAG]!.variations[1]!._id;
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, { environmentKey: "preview", instructions: [{ kind: "addTargets", values: ["k"], variationId: other }] })).status).toBe(400);
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, { environmentKey: "preview", instructions: [{ kind: "turnFlagOn" }] })).status).toBe(400);
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, { environmentKey: "nope", instructions: [] })).status).toBe(400);
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, { environmentKey: "preview", instructions: [] })).status).toBe(400);
    expect((await send({ authorization: "api-x", "content-type": SEMANTIC }, { environmentKey: "preview", instructions: [{ kind: "addTargets", values: [1], variationId }] })).status).toBe(400);
    expect(targets(h)).toEqual({ "user:k": "on" });
  });

  it("drift moves or deletes a target, and refuses one it does not know", async () => {
    await h.close();
    h = await harness(seeded({}, { targets: { preview: [{ key: "a/b", variation: 0 }] } }));
    await h.chaos({ drift: { "launchdarkly:demo.target.new-checkout/preview/user/a/b": "1" } });
    expect(targets(h)).toEqual({ "user:a/b": "off" });
    await h.chaos({ drift: { "launchdarkly.target.new-checkout/preview/user/a/b": "delete" } });
    expect(targets(h)).toEqual({});
    await expect(h.chaos({ drift: { "launchdarkly.target.new-checkout/preview/user/a/b": "on" } })).resolves.toMatchObject({ error: expect.stringMatching(/no such target/) });
  });
});
