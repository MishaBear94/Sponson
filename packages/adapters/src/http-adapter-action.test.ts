/**
 * `http.action` (ADR 0022) against the REST sim's logged endpoints (R9): parsing, where each request goes and with
 * which credential, the idempotency key, success criteria, outputs, and the undo kept in the record id.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isSponsonError, resolveParams, type LiveState } from "@sponson/core";
import { httpAdapter } from "./http-adapter.js";
import { actionIdentity, parseAction } from "./http-adapter-action.js";
import { harness, type Harness } from "./testing.js";

const action = httpAdapter.ops.action!;
const API = { base_url: "https://api.example.test/v1", base_url_env: "REST_API_URL", auth: { bearer_env: "REST_API_TOKEN" }, headers: { "X-Team": "acme" } };
const HASH = "a".repeat(64);
const live = (id = ""): LiveState => ({ resources: [{ key: "action:purge", id, hash: HASH }], outputs: {} });
const resolved = (p: Record<string, unknown>) => resolveParams(p, new Map(), new Map()).params;

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (isSponsonError(e)) return `${e.code}: ${e.message}`;
    throw e;
  }
  return "(no error)";
}

const PURGE = {
  api: "demo",
  trigger: { sha: "abc" },
  vars: { zone: "z1" },
  request: { method: "POST", path: "/zones/{zone}/purge", body: { everything: true }, idempotency_key: true },
  expect: { "/result/ok": true },
  outputs: { purge_id: "/result/id" },
  undo: { method: "DELETE", path: "/zones/{zone}/purges/{purge_id}" },
};

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("http.action parsing", () => {
  it("needs a trigger and exactly one target; `url` lines take no api, `path` lines need one", () => {
    expect(codeOf(() => parseAction({ ...PURGE, trigger: {} }))).toMatch(/^PARAM_INVALID: .*`trigger` is required/);
    expect(codeOf(() => parseAction({ ...PURGE, request: { path: "/x", url: "https://a.test" } }))).toMatch(/needs exactly one of `path`/);
    expect(codeOf(() => parseAction({ trigger: { a: 1 }, request: { path: "/x" } }))).toMatch(/`api` is required for a `path` or `graphql` request/);
    expect(codeOf(() => parseAction({ api: "demo", trigger: { a: 1 }, request: { url: "https://a.test/x" } }))).toMatch(/a `url` request is sent without the API's credential, so the line takes no `api`/);
    expect(codeOf(() => parseAction({ trigger: { a: 1 }, request: { url: "ftp://a.test" } }))).toMatch(/must be an absolute http\(s\) URL/);
    // A reference is checked once it resolves.
    expect(() => parseAction(resolved({ trigger: { a: 1 }, request: { url: { from: "web.preview_url" } } }))).not.toThrow();
  });

  it("refuses sensitive outputs, unknown keys, an undo with an idempotency key and undeclared placeholders", () => {
    expect(codeOf(() => parseAction({ ...PURGE, outputs: { token: { path: "/t", sensitive: true } } }))).toMatch(/an action's outputs are never sensitive/);
    expect(codeOf(() => parseAction({ ...PURGE, fields: {} }))).toMatch(/`fields` is not a parameter of http.action/);
    expect(codeOf(() => parseAction({ ...PURGE, undo: { path: "/x", idempotency_key: true } }))).toMatch(/`undo.idempotency_key` does not apply/);
    expect(codeOf(() => parseAction({ ...PURGE, undo: { path: "/x/{nope}" } }))).toMatch(/`undo.path` uses `\{nope\}`, which is not declared in `vars` or `outputs`/);
    expect(codeOf(() => parseAction({ ...PURGE, request: { path: "/x/{purge_id}" } }))).toMatch(/`request.path` uses `\{purge_id\}`, which is not declared in `vars`/);
    expect(codeOf(() => parseAction({ ...PURGE, request: { method: "GET", path: "/x", body: {} } }))).toMatch(/cannot be sent with GET/);
    expect(codeOf(() => parseAction({ ...PURGE, ok_status: [200] }))).toMatch(/`ok_status` must be a list of HTTP statuses 400–499/);
  });

  it("uses the API block for `path` lines and none for `url` lines; declares its outputs; knows its trigger once resolved", () => {
    expect(action.providerFor!({ demo: API }, PURGE)).toEqual(API);
    expect(action.providerFor!({ demo: API }, { trigger: { a: 1 }, request: { method: "PUT", url: "https://app.test/api/inngest" } })).toEqual({});
    expect(action.outputsFor!(PURGE)).toEqual({ purge_id: { available: "immediate" } });
    expect(action.action!(PURGE, {} as never)).toEqual({ trigger: { sha: "abc" }, label: "demo POST /zones/z1/purge" });
    expect(action.action!(resolved({ ...PURGE, trigger: { url: { from: "web.preview_url" } } }), {} as never)).toBeNull();
    expect(actionIdentity(parseAction(PURGE))).toEqual({ key: "action:<line id>", id: 'UNDO {"method":"DELETE","path":"/zones/{zone}/purges/{purge_id}"}' });
    expect(actionIdentity(parseAction({ ...PURGE, undo: undefined })).id).toBe("FORGET");
  });
});

describe("http.action requests", () => {
  it("sends the request with the API's credential and headers and an idempotency key per action and trigger; records the undo", async () => {
    h = await harness({ rest: { endpoints: { "/zones/z1/purge": { reply: { result: { ok: true, id: "p1" } } }, "/zones/z1/purges/p1": {} } } });
    const actx = h.actx("http", API);
    const r = await action.apply(actx, PURGE, live());
    expect(r).toEqual({ resources: [{ key: "action:purge", id: 'UNDO {"headers":{},"method":"DELETE","path":"/zones/z1/purges/p1"}', hash: HASH, label: "demo POST /zones/z1/purge" }], outputs: { purge_id: "p1" }, created: [] });
    const [call] = h.sim.state.rest.calls;
    expect(call).toMatchObject({ method: "POST", path: "/zones/z1/purge", body: { everything: true }, headers: { authorization: `Bearer ${h.env.REST_API_TOKEN}`, "x-team": "acme" } });
    const key = call!.headers["idempotency-key"];
    expect(key).toMatch(/^sponson-[0-9a-f]{40}$/);
    // The same action and trigger (a run sent again after a crash) sends the same key; another trigger another one.
    await action.apply(actx, PURGE, live());
    await action.apply(actx, PURGE, { ...live(), resources: [{ key: "action:purge", id: "", hash: "b".repeat(64) }] });
    expect(h.sim.state.rest.calls.map((c) => c.headers["idempotency-key"])).toEqual([key, key, expect.not.stringMatching(key!)]);

    await action.destroy(actx, r.resources);
    expect(h.sim.state.rest.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/zones/z1/purges/p1" });
    // Already undone: a 404 is what destroy wanted.
    await expect(action.destroy(actx, [{ key: "k", id: 'UNDO {"headers":{},"method":"DELETE","path":"/gone"}', hash: "" }])).resolves.toBeUndefined();
    await expect(action.destroy(actx, [{ key: "k", id: "FORGET", hash: "" }])).resolves.toBeUndefined();
  });

  it("sends a `url` request with no credential and no API headers, and the line's own headers", async () => {
    h = await harness({ rest: { endpoints: { "/api/inngest": { public: true, reply: { message: "Successfully registered", modified: true } } } } });
    const line = { trigger: { url: "x" }, request: { method: "PUT", url: `${h.sim.url}/rest/api/inngest`, headers: { "x-vercel-protection-bypass": "bypass-secret-value" } }, outputs: { modified: "/modified" } };
    const r = await action.apply(h.actx("http", {}), line, live());
    expect(r.outputs).toEqual({ modified: true });
    expect(r.resources[0]!.id).toBe("FORGET");
    const [call] = h.sim.state.rest.calls;
    expect(call!.method).toBe("PUT");
    expect(call!.headers.authorization).toBeUndefined();
    expect(call!.headers["x-vercel-protection-bypass"]).toBe("bypass-secret-value");
  });

  it("fails on an answer that misses `expect` or an error status, and succeeds on a listed `ok_status`", async () => {
    h = await harness({ rest: { endpoints: { "/purge": { reply: { result: { ok: false } } }, "/busy": { status: 409, reply: { error: "already purged" } }, "/down": { status: 500 } } } });
    const actx = h.actx("http", API);
    const line = (path: string, extra: Record<string, unknown> = {}) => ({ api: "demo", trigger: { a: 1 }, request: { path }, expect: { "/result/ok": true }, ...extra });
    await expect(action.apply(actx, line("/purge"), live())).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: expect.stringMatching(/the answer has false at \/result\/ok, expected true/) });
    await expect(action.apply(actx, line("/busy"), live())).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
    const ok = await action.apply(actx, line("/busy", { ok_status: [409], expect: {} }), live());
    expect(ok.outputs).toEqual({});
    await expect(action.apply(actx, { ...line("/down"), expect: {} }, live())).rejects.toMatchObject({ code: "PROVIDER_TRANSIENT" });
  });

  it("never keeps a secret in the undo it records, and never runs outside the engine's action path", async () => {
    h = await harness({ rest: { endpoints: { "/notify": {} } } });
    const actx = h.actx("http", API, { redact: (t) => t.split("s3cr3t-value").join("****") });
    const line = { api: "demo", trigger: { a: 1 }, request: { path: "/notify" }, undo: { path: "/notify", body: { token: "s3cr3t-value" } } };
    await expect(action.apply(actx, line, live())).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/`undo` may not hold a secret/) });
    await expect(action.apply(actx, line, null)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await action.read(actx, line)).toBeNull();
    expect(action.diff(null, line)).toEqual([]);
  });

  it("sends a GraphQL request to the API's endpoint and reads its data", async () => {
    h = await harness({ rest: { endpoints: { "/graphql": { reply: { data: { purgeCache: { id: "g1" } } } } } } });
    const actx = h.actx("http", { ...API, base_url_env: undefined, base_url: `${h.sim.url}/rest/graphql` });
    const line = { api: "demo", trigger: { a: 1 }, request: { graphql: { query: "mutation($z: ID!) { purgeCache(zone: $z) { id } }", variables: { z: "z1" } } }, outputs: { purge: "/purgeCache/id" } };
    const r = await action.apply(actx, line, live());
    expect(r.outputs).toEqual({ purge: "g1" });
    expect(h.sim.state.rest.calls[0]).toMatchObject({ method: "POST", path: "/graphql", body: { query: line.request.graphql.query, variables: { z: "z1" } } });
  });
});
