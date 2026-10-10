import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveParams, type LiveState, type OpSpec } from "@sponson/core";
import { httpAdapter } from "./http-adapter.js";
import { harness, recordingProxy, writeIndex, type Harness } from "./testing.js";

const resource = httpAdapter.ops.resource!;
const listItem = httpAdapter.ops.list_item!;

/** The block `providerFor` narrows `providers.http.demo` to, pointed at the sim by REST_API_URL. */
const API = { base_url: "https://api.example.test/v1", base_url_env: "REST_API_URL", auth: { bearer_env: "REST_API_TOKEN" } };

/** Params as the engine hands them over: references replaced by markers (nothing resolved). */
function resolved(params: Record<string, unknown>): Record<string, unknown> {
  return resolveParams(params, new Map(), new Map()).params;
}

const GATE = {
  api: "demo",
  find: { path: "/gates", list_path: "/data", match: { name: "new_checkout" } },
  read: { path: "/gates/{id}" },
  create: { path: "/gates" },
  update: { method: "PATCH" },
  item_path: "/data",
  fields: { description: "New checkout", enabled: true },
  outputs: { gate_name: "/name" },
};
const GATE_KEY = "/gates[name=new_checkout]";

async function readApply(h: Harness, op: OpSpec, params: Record<string, unknown>, provider: Record<string, unknown> = API) {
  const actx = h.actx("http", provider);
  const live = await op.read(actx, params);
  const diffs = op.diff(live, params);
  const result = await op.apply(actx, params, live);
  return { live, diffs, result };
}

describe("http.resource", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("creates by natural key, announces the intent before the create, reads it back unchanged, updates, destroys", async () => {
    const actx = h.actx("http", API);
    expect(await resource.read(actx, GATE)).toBeNull();
    expect(resource.diff(null, GATE)).toEqual([{ key: GATE_KEY, kind: "create", label: `demo ${GATE_KEY}`, before: { state: "absent" }, after: { state: "literal", value: '{"description":"New checkout","enabled":true}' } }]);

    const r = await resource.apply(actx, GATE, null);
    expect(r.created).toEqual([GATE_KEY]);
    expect(r.resources[0]!.id).toMatch(/^DELETE \/gates\/it_\d+$/);
    expect(r.outputs).toEqual({ id: expect.stringMatching(/^it_/), gate_name: "new_checkout" });
    expect(h.intents).toEqual([{ keys: [GATE_KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", /^\/rest\/gates$/)).toBe(0);
    expect(h.sim.state.rest.collections["/gates"]).toEqual([{ id: r.outputs.id, name: "new_checkout", description: "New checkout", enabled: true }]);

    // apply; apply: the second performs zero writes.
    const again = await readApply(h, resource, GATE);
    expect(again.diffs.map((d) => d.kind)).toEqual(["unchanged"]);
    expect(again.live!.resources[0]!.hash).toBe(r.resources[0]!.hash);
    expect(again.result.created).toEqual([]);
    expect(h.sim.state.writes).toHaveLength(1);

    const changed = { ...GATE, fields: { ...GATE.fields, enabled: false } };
    const u = await readApply(h, resource, changed);
    expect(u.diffs[0]).toMatchObject({ kind: "update", before: { state: "literal", value: '{"description":"New checkout","enabled":true}' }, after: { value: '{"description":"New checkout","enabled":false}' } });
    expect(u.result.created).toEqual([]);
    expect(h.sim.state.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /rest/gates", `PATCH /rest/gates/${r.outputs.id}`]);
    expect((await resource.read(actx, changed))!.resources[0]!.hash).toBe(u.result.resources[0]!.hash);

    await resource.destroy(actx, u.result.resources);
    expect(h.sim.state.rest.collections["/gates"]).toEqual([]);
    await resource.destroy(actx, u.result.resources); // 404 is success
    expect(await resource.read(actx, GATE)).toBeNull();
  });

  it("locates by a URL that names the object (a client-chosen id), without find", async () => {
    const flag = { api: "demo", read: { path: "/flags/dark-mode" }, create: { path: "/flags", body: { id: "dark-mode" } }, item_path: "/data", fields: { on: false } };
    const actx = h.actx("http", API);
    expect(await resource.read(actx, flag)).toBeNull();
    const r = await resource.apply(actx, flag, null);
    expect(r.resources[0]).toMatchObject({ key: "/flags/dark-mode", id: "DELETE /flags/dark-mode" });
    expect(r.outputs).toEqual({ id: "dark-mode" });
    await resource.destroy(actx, r.resources);
    expect(h.sim.state.rest.collections["/flags"]).toEqual([]);
  });

  it("drift: a console edit of a declared field changes the hash; an undeclared field does not; a deleted object reads as missing", async () => {
    const actx = h.actx("http", API);
    const r = await resource.apply(actx, GATE, null);
    await h.chaos({ drift: { "rest.items./gates.new_checkout.owner": '"someone"' } });
    expect((await resource.read(actx, GATE))!.resources[0]!.hash).toBe(r.resources[0]!.hash);
    await h.chaos({ drift: { "rest.items./gates.new_checkout.enabled": "false" } });
    const live = await resource.read(actx, GATE);
    expect(live!.resources[0]!.hash).not.toBe(r.resources[0]!.hash);
    expect(resource.diff(live, GATE)[0]!.kind).toBe("update");
    await h.chaos({ drift: { "rest.items./gates.new_checkout": "recreate" } });
    expect((await resource.read(actx, GATE))!.resources[0]!.id).not.toBe(r.resources[0]!.id); // replaced: a new record id
    await h.chaos({ drift: { "rest.items./gates.new_checkout": "delete" } });
    expect(await resource.read(actx, GATE)).toBeNull();
  });

  it("follows cursor pages to find the object", async () => {
    await h.close();
    const gates = Array.from({ length: 7 }, (_, i) => ({ name: `g${i}`, description: "x", enabled: true }));
    h = await harness({ rest: { collections: { "/gates": [...gates, { name: "new_checkout", description: "New checkout", enabled: true }] } }, chaos: { page_size: 3 } });
    const paged = { ...GATE, find: { ...GATE.find, next: "/next_cursor" } };
    expect((await resource.read(h.actx("http", API), paged))?.resources[0]?.key).toBe(GATE_KEY);
    expect(await resource.read(h.actx("http", API), GATE)).toBeNull(); // without `next`, only the first page is seen
  });

  it("a create refused as existing (409) is located and returned as not created", async () => {
    await fetch(`${h.sim.url}/rest/gates`, { method: "POST", body: JSON.stringify({ name: "new_checkout", description: "New checkout", enabled: true }), headers: { authorization: "Bearer other", "content-type": "application/json" } });
    const r = await resource.apply(h.actx("http", API), GATE, null);
    expect(r.created).toEqual([]);
    expect(h.intents.map((i) => i.keys)).toEqual([[GATE_KEY]]);
    expect(h.sim.state.rest.collections["/gates"]).toHaveLength(1);
  });

  it("a once-only output comes from the create that made the object, never from a read, an update or a create refused as existing", async () => {
    // The sim echoes the token on every read; a real provider shows it only once. Either way only the create may return it.
    const KEY = { ...GATE, create: { path: "/gates", body: { token: "tok_once_value_0042" } }, outputs: { token: { path: "/token", sensitive: true, once: true } } };
    const actx = h.actx("http", API);
    const r = await resource.apply(actx, KEY, null);
    expect(r.created).toEqual([GATE_KEY]);
    expect(r.outputs.token).toBe("tok_once_value_0042");

    const again = await readApply(h, resource, KEY);
    expect(again.live!.outputs).not.toHaveProperty("token");
    expect(again.result.outputs).not.toHaveProperty("token");
    const changed = await readApply(h, resource, { ...KEY, fields: { ...GATE.fields, enabled: false } });
    expect(changed.diffs[0]!.kind).toBe("update");
    expect(changed.result.outputs).not.toHaveProperty("token");

    // Lost answer, retried: the provider says it exists, so this call revealed nothing.
    const retried = await resource.apply(actx, KEY, null);
    expect(retried.created).toEqual([]);
    expect(retried.outputs).not.toHaveProperty("token");
  });

  it("create.locate: a create answered with the parent (not the object) is located with find afterwards", async () => {
    await h.close();
    // As Statsig answers an added rule: with the whole gate, whose own id must not be taken for the rule's.
    h = await harness({ rest: { collections: { "/gates/g/rules": [] }, aliases: { "/gates/g/rule": "/gates/g/rules" } } });
    const rule = { api: "demo", find: { path: "/gates/g/rules", list_path: "/data", match: { name: "pr-42" } }, create: { path: "/gates/g/rule", locate: true }, delete: { path: "/gates/g/rules/{id}" }, item_path: "/data", fields: { passPercentage: 100 } };
    const r = await resource.apply(h.actx("http", API), rule, null);
    const [made] = h.sim.state.rest.collections["/gates/g/rules"]!;
    expect(r.resources[0]!.id).toBe(`DELETE /gates/g/rules/${String(made!.id)}`);
    expect(h.sim.state.writes.map((w) => w.method)).toEqual(["POST"]);
    expect(() => resource.diff(null, { ...rule, create: { path: "/x", locate: "yes" } })).toThrow(/`create.locate` must be true or false/);
  });

  it("exists_status and gone_status classify a provider's own statuses", async () => {
    // A provider that answers a duplicate create with 400 and a deleted object with 410.
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const deviate = (req.method === "POST" && req.url === "/gates") || req.method === "DELETE";
        if (deviate) {
          res.writeHead(req.method === "POST" ? 400 : 410, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: req.method === "POST" ? "name taken" : "gone" }));
        }
        void fetch(`${h.sim.url}/rest${req.url}`, { headers: { authorization: "Bearer t" } }).then(async (up) => {
          res.writeHead(up.status, { "content-type": "application/json" });
          res.end(await up.text());
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fetch(`${h.sim.url}/rest/gates`, { method: "POST", body: JSON.stringify({ name: "new_checkout", description: "New checkout", enabled: true }), headers: { authorization: "Bearer other", "content-type": "application/json" } });
      const env = { ...h.env, REST_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const actx = h.actx("http", API, { env });
      await expect(resource.apply(actx, GATE, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
      const statuses = { ...GATE, exists_status: [400], gone_status: [410] };
      const r = await resource.apply(actx, statuses, null);
      expect(r.created).toEqual([]);
      expect(r.resources[0]!.id).toMatch(/ gone=410$/);
      await resource.destroy(actx, r.resources); // 410 is gone
      const undeclared = r.resources.map((x) => ({ ...x, id: x.id.replace(/ gone=410$/, "") }));
      await expect(resource.destroy(actx, undeclared)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    } finally {
      server.close();
    }
  });

  it("destroy: keep leaves the object in place", async () => {
    const actx = h.actx("http", API);
    const r = await resource.apply(actx, { ...GATE, destroy: "keep" }, null);
    expect(r.resources[0]!.id).toMatch(/^KEEP \/gates\//);
    await resource.destroy(actx, r.resources);
    expect(h.sim.state.rest.collections["/gates"]).toHaveLength(1);
  });

  it("PUT updates send the identifying fields and kept fields back", async () => {
    const actx = h.actx("http", API);
    await resource.apply(actx, GATE, null);
    const put = resolved({ ...GATE, update: { method: "PUT" }, fields: { description: { keep: true }, enabled: false } });
    const { diffs } = await readApply(h, resource, put);
    expect(diffs[0]!.kind).toBe("update");
    expect(h.sim.state.rest.collections["/gates"]![0]).toMatchObject({ name: "new_checkout", description: "New checkout", enabled: false });
  });

  it("`{ keep: true }` is unchanged when the object exists and PARAM_INVALID when it does not", async () => {
    const kept = resolved({ ...GATE, fields: { description: { keep: true }, enabled: true } });
    expect(() => resource.diff(null, kept)).toThrow(expect.objectContaining({ code: "PARAM_INVALID" }) as Error);
    await expect(resource.apply(h.actx("http", API), kept, null)).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await resource.apply(h.actx("http", API), GATE, null);
    const { diffs } = await readApply(h, resource, kept);
    expect(diffs.map((d) => d.kind)).toEqual(["unchanged"]);
    expect(h.sim.state.writes).toHaveLength(1);
  });

  it("a field change without an `update` request is PARAM_INVALID at plan time", async () => {
    const { update: _omit, ...noUpdate } = GATE;
    await resource.apply(h.actx("http", API), noUpdate, null);
    const live = await resource.read(h.actx("http", API), noUpdate);
    expect(() => resource.diff(live, { ...noUpdate, fields: { ...GATE.fields, enabled: false } })).toThrow(/declares no `update`/);
  });

  it("pending references: no key, nothing read, shown as pending; apply refuses them and writes nothing", async () => {
    const params = resolved({ ...GATE, find: { ...GATE.find, match: { name: { from: "app.name" } } } });
    expect(await resource.read(h.actx("http", API), params)).toBeNull();
    expect(resource.diff(null, params)).toEqual([{ key: "(pending)", kind: "create", label: "demo object", before: { state: "absent" }, after: { state: "pending", ref: "app.name" } }]);
    const field = resolved({ ...GATE, fields: { description: { from: "app.description" } } });
    expect(resource.diff(null, field)[0]!.after).toEqual({ state: "pending", ref: "app.description" });
    await expect(resource.apply(h.actx("http", API), field, null)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(h.sim.state.writes).toHaveLength(0);
  });

  it("a secret field is sent, and never appears in records or outputs (only its hash)", async () => {
    const secret = "whsec_live_1234567890abcdef";
    const hook = { api: "demo", find: { path: "/hooks", list_path: "/data", match: { url: "https://pr-42.example.app/hook" } }, create: { path: "/hooks", body: { signing: secret } }, item_path: "/data", delete: { path: "/hooks/{id}" }, fields: { events: ["push"] } };
    const r = await resource.apply(h.actx("http", API), hook, null);
    expect(h.sim.state.rest.collections["/hooks"]![0]!.signing).toBe(secret);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(await resource.read(h.actx("http", API), hook))).not.toContain(secret);
  });

  it("idempotency_key makes a create whose connection dropped safe to retry", async () => {
    const proxy = await recordingProxy(`${h.sim.url}/rest`);
    try {
      await h.chaos({ drop_response_next: 1, fail_on: "POST /rest/gates" });
      const actx = h.actx("http", API, { env: { ...h.env, REST_API_URL: proxy.url } });
      await expect(resource.apply(actx, GATE, null)).rejects.toMatchObject({ code: "PROVIDER_TRANSIENT" });
      await h.chaos({ drop_response_next: 1, fail_on: "POST /rest/flags" });
      const flag = { api: "demo", find: { path: "/flags", list_path: "/data", match: { name: "f" } }, create: { path: "/flags", idempotency_key: true }, item_path: "/data", delete: { path: "/flags/{id}" } };
      // The first attempt is performed and its answer lost; the retry with the same key is refused as a duplicate
      // by the sim (it has no idempotency store), and the existing object is claimed instead.
      const r = await resource.apply(actx, flag, null);
      expect(r.resources).toHaveLength(1);
      expect(h.sim.state.rest.collections["/flags"]).toHaveLength(1);
      expect(proxy.log.filter((x) => x.method === "POST" && x.path === "/flags")).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it("form encoding reaches the provider as declared, and reads back unchanged", async () => {
    const actx = h.actx("http", { ...API, encoding: "form" });
    const hook = { api: "demo", find: { path: "/hooks", list_path: "/data", match: { url: "https://pr-42.example.app/hook" } }, create: { path: "/hooks" }, item_path: "/data", delete: { path: "/hooks/{id}" }, fields: { enabled_events: ["charge.succeeded", "invoice.paid"], mode: "test" } };
    await resource.apply(actx, hook, null);
    expect(h.sim.state.rest.collections["/hooks"]![0]).toMatchObject({ url: "https://pr-42.example.app/hook", enabled_events: ["charge.succeeded", "invoice.paid"], mode: "test" });
    expect((await readApply(h, resource, hook, { ...API, encoding: "form" })).diffs[0]!.kind).toBe("unchanged");
  });

  it("header and Basic credentials are sent, and masked in error text", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `bad request; you sent ${String(req.headers["x-api-key"] ?? req.headers.authorization)}` }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const header = { base_url: url, auth: { header: "X-Api-Key", value_env: "DEMO_API_KEY" }, headers: { "X-Api-Version": "2024-06-01" } };
      const err = await resource.read(h.actx("http", header, { env: { ...h.env, DEMO_API_KEY: "key-0123456789" } }), GATE).then(() => new Error("expected a failure"), (e: unknown) => e as Error);
      expect(seen["x-api-key"]).toBe("key-0123456789");
      expect(seen["x-api-version"]).toBe("2024-06-01");
      expect(err.message).toContain("you sent ****");
      expect(err.message).not.toContain("key-0123456789");

      const basic = { base_url: url, auth: { basic: { user_env: "DEMO_USER", password_env: "DEMO_PASSWORD" } } };
      const err2 = await resource.read(h.actx("http", basic, { env: { ...h.env, DEMO_USER: "acct_1", DEMO_PASSWORD: "pw-0123456789" } }), GATE).then(() => new Error("expected a failure"), (e: unknown) => e as Error);
      expect(seen.authorization).toBe(`Basic ${Buffer.from("acct_1:pw-0123456789").toString("base64")}`);
      expect(err2.message).not.toContain(Buffer.from("acct_1:pw-0123456789").toString("base64"));

      // Per-request headers: an Idempotency-Key derived from the key, the commit and the body; a vendor media type.
      const actx = h.actx("http", header, { env: { ...h.env, DEMO_API_KEY: "key-0123456789" } });
      const create = { ...GATE, create: { path: "/gates", idempotency_key: true, content_type: "application/vnd.demo+json" } };
      await expect(resource.apply(actx, create, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
      const first = seen["idempotency-key"];
      expect(first).toMatch(/^sponson-[0-9a-f]{40}$/);
      expect(seen["content-type"]).toBe("application/vnd.demo+json");
      await expect(resource.apply(actx, create, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
      expect(seen["idempotency-key"]).toBe(first);
      await expect(resource.apply(actx, { ...create, fields: { enabled: false } }, null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
      expect(seen["idempotency-key"]).not.toBe(first);
    } finally {
      server.close();
    }
  });

  it("unexpected answers are PROVIDER_RESPONSE naming the param; a record id that is not a request is INTERNAL", async () => {
    const actx = h.actx("http", API);
    await expect(resource.read(actx, { ...GATE, find: { ...GATE.find, list_path: "/items" } })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", details: { param: "find.list_path" } });
    const r = await resource.apply(actx, GATE, null);
    await expect(resource.read(actx, { ...GATE, item_path: "/missing" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", details: { param: "item_path" } });
    await expect(resource.read(actx, { ...GATE, read: undefined, update: { path: "/gates/{id}" }, delete: { path: "/gates/{id}" }, id_path: "/uid" })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", details: { param: "id_path" } });
    await expect(resource.destroy(actx, [{ ...r.resources[0]!, id: "it_1" }])).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(listItem.destroy(actx, [{ ...r.resources[0]!, id: "{" }])).rejects.toMatchObject({ code: "INTERNAL" });
    await resource.destroy(actx, [{ ...r.resources[0]!, id: "" }]); // an intent never located: nothing to do
    expect(h.sim.state.rest.collections["/gates"]).toHaveLength(1);
  });

  it("a POST delete (an archive endpoint) is sent as declared", async () => {
    const actx = h.actx("http", API);
    const archived = { ...GATE, delete: { method: "POST", path: "/apps/demo" } };
    const r = await resource.apply(actx, archived, null);
    expect(r.resources[0]!.id).toBe("POST /apps/demo");
    await resource.destroy(actx, r.resources);
    expect(h.sim.state.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /rest/gates", "POST /rest/apps/demo"]);
  });

  it("works with the sim's X-Api-Key credential end to end", async () => {
    const r = await resource.apply(h.actx("http", { ...API, auth: { header: "X-Api-Key", value_env: "REST_API_TOKEN" } }), GATE, null);
    expect(r.created).toEqual([GATE_KEY]);
  });
});

describe("http: malformed specs name the field", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no api", { ...GATE, api: undefined }, /`api` is required/],
    ["no create", { ...GATE, create: undefined }, /`create` is required/],
    ["neither read nor find", { ...GATE, read: undefined, find: undefined }, /needs `read`/],
    ["{id} without find", { ...GATE, find: undefined }, /only be located with `find`/],
    ["unknown param", { ...GATE, filds: {} }, /`filds` is not a parameter of http.resource/],
    ["bad method", { ...GATE, create: { path: "/x", method: "GET" } }, /`create.method` must be one of/],
    ["relative path", { ...GATE, create: { path: "x" } }, /`create.path` must be a path/],
    ["undeclared placeholder", { ...GATE, create: { path: "/projects/{project}/gates" } }, /uses `\{project\}`/],
    ["bad pointer", { ...GATE, id_path: "id" }, /`id_path` must be a JSON pointer/],
    ["outputs.id", { ...GATE, outputs: { id: "/id" } }, /`outputs.id` is reserved/],
    ["empty match", { ...GATE, find: { path: "/x", match: {} } }, /`find.match` must name/],
    ["bad destroy", { ...GATE, destroy: "archive" }, /`destroy` must be/],
    ["bad statuses", { ...GATE, gone_status: [200] }, /`gone_status` must be/],
  ];
  it.each(cases)("http.resource: %s", (_why, params, message) => {
    expect(() => resource.diff(null, params)).toThrow(message);
    try {
      resource.diff(null, params);
    } catch (e) {
      expect(e).toMatchObject({ code: "PARAM_INVALID" });
    }
  });

  const ITEM = { api: "demo", parent: { path: "/apps/demo" }, list_path: "/allowed_origins", item: "https://a.example" };
  const listCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no parent", { ...ITEM, parent: undefined }, /`parent` is required/],
    ["no list_path", { ...ITEM, list_path: undefined }, /`list_path` is required/],
    ["a list as item", { ...ITEM, item: ["a"] }, /`item` must be/],
    ["map item without key_field", { ...ITEM, item: { url: "x" } }, /`key_field` must be/],
    ["key_field on a scalar", { ...ITEM, key_field: "url" }, /`key_field` applies only/],
    ["bad send", { ...ITEM, parent: { path: "/apps/demo", send: "all" } }, /`parent.send` must be/],
    ["empty send list", { ...ITEM, parent: { path: "/apps/demo", send: [] } }, /`parent.send` must be/],
    ["bad parent.item_path", { ...ITEM, parent: { path: "/apps/demo", item_path: "app" } }, /`parent.item_path` must be a JSON pointer/],
    ["map without value", { ...ITEM, shape: "map", list_path: "/env_vars" }, /`value` is required/],
    ["value on an array", { ...ITEM, value: 1 }, /`value` does not apply/],
    ["bad shape", { ...ITEM, shape: "set" }, /`shape` must be/],
  ];
  it.each(listCases)("http.list_item: %s", (_why, params, message) => {
    expect(() => listItem.diff(null, params)).toThrow(message);
  });

  it("the provider block: unknown API and literal or non-credential variable names are PLAN_INVALID", () => {
    const providerFor = resource.providerFor!;
    expect(() => providerFor({ demo: API }, { ...GATE, api: "nope" })).toThrow(/no API `nope` is configured \(known: demo\)/);
    expect(() => providerFor({ demo: { ...API, auth: { bearer_env: "sk_live_abc" } } }, GATE)).toThrow(/must end in TOKEN/);
    expect(() => providerFor({ demo: { ...API, auth: { bearer_env: "sk live" } } }, GATE)).toThrow(/NAME of an environment variable/);
    expect(() => providerFor({ demo: { ...API, auth: { token: "x" } } }, GATE)).toThrow(/must be one of/);
    expect(() => providerFor({ demo: { ...API, headers: { Authorization: "x" } } }, GATE)).toThrow(/is set by Sponson/);
    expect(() => providerFor({ demo: { ...API, base_url: "api.example.test" } }, GATE)).toThrow(/`base_url` must be an http\(s\) URL/);
    expect(() => providerFor({ demo: { ...API, encoding: "xml" } }, GATE)).toThrow(/`json`/);
    expect(() => providerFor({ demo: { ...API, retries: 3 } }, GATE)).toThrow(/unknown key `retries`/);
    expect(providerFor({ demo: API, other: { base_url: "https://x.test" } }, GATE)).toEqual(API);
    expect(() => providerFor({ demo: { ...API, production: "yes" } }, GATE)).toThrow(/production: must be true/);
    // An API block marked production makes every line through it need approval.
    const ctx = { env: "preview", git: { branch: "b", sha: "s", short_sha: "s" }, pr: { number: null }, scope: "branch-b" };
    expect(resource.writesEnvironment!(GATE, ctx, providerFor({ demo: { ...API, production: true } }, GATE))).toBe("production");
    expect(listItem.writesEnvironment!(GATE, ctx, { ...API, production: true })).toBe("production");
    expect(resource.writesEnvironment!(GATE, ctx, API)).toBeNull();
    expect(resource.writesEnvironment!(GATE, ctx)).toBeNull();
    try {
      providerFor({ demo: API }, { ...GATE, api: "nope" });
    } catch (e) {
      expect(e).toMatchObject({ code: "PLAN_INVALID" });
    }
  });

  it("declares the outputs a line names, with their sensitivity", () => {
    expect(resource.outputsFor!({ ...GATE, outputs: { gate_name: "/name", signing_secret: { path: "/secret", sensitive: true }, token: { path: "/token", sensitive: true, once: true } } })).toEqual({
      id: { available: "immediate" },
      gate_name: { available: "immediate" },
      signing_secret: { available: "immediate", sensitive: true },
      token: { available: "immediate", sensitive: true, once: true },
    });
  });

  it("a once-only output must be sensitive, and its flags booleans", () => {
    expect(() => resource.outputsFor!({ ...GATE, outputs: { token: { path: "/token", once: true } } })).toThrow(/`outputs\.token` is `once`.*must be `sensitive: true` too/);
    expect(() => resource.outputsFor!({ ...GATE, outputs: { token: { path: "/token", sensitive: "yes" } } })).toThrow(/`outputs\.token\.sensitive` must be true or false/);
  });
});

describe("http.list_item", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const ORIGIN = { api: "demo", parent: { path: "/apps/demo" }, list_path: "/allowed_origins", item: "https://pr-42.example.app" };
  const ORIGIN_KEY = "/apps/demo#/allowed_origins=https://pr-42.example.app";

  it("locks the parent object (ADR 0019), named by the base URL without credentials and the filled parent path", () => {
    const lockOn = listItem.lockOn!;
    expect(lockOn(ORIGIN, API)).toBe("http:https://api.example.test/v1/apps/demo");
    // Every collection of one parent shares its lock; the read path does not name another object.
    expect(lockOn({ ...ORIGIN, list_path: "/callbacks", parent: { path: "/apps/demo", read_path: "/apps/demo?fields=all" } }, API)).toBe("http:https://api.example.test/v1/apps/demo");
    const withVars = { ...ORIGIN, parent: { path: "/clients/{client}" }, vars: { client: "abc 123" } };
    expect(lockOn(withVars, { ...API, base_url: "https://user:pa55word@tenant.example.test/api/v2/?x=1#f" })).toBe("http:https://tenant.example.test/api/v2/clients/abc%20123");
    expect(lockOn({ ...withVars, vars: { client: resolved({ c: { from: "app.id" } }).c } }, API)).toBeNull();
    expect(resource.lockOn).toBeUndefined();
  });

  it("adds by read-modify-write after the intent, is idempotent, removes, and removing twice writes nothing", async () => {
    await h.chaos({ drift: { "rest.objects./apps/demo.allowed_origins": "add:https://prod.example.app" } });
    const actx = h.actx("http", API);
    expect(await listItem.read(actx, ORIGIN)).toBeNull();
    expect(listItem.diff(null, ORIGIN)).toEqual([{ key: ORIGIN_KEY, kind: "create", label: "demo /apps/demo/allowed_origins item https://pr-42.example.app", before: { state: "absent" }, after: { state: "literal", value: "https://pr-42.example.app" } }]);
    const r = await listItem.apply(actx, ORIGIN, null);
    expect(r.created).toEqual([ORIGIN_KEY]);
    expect(h.intents).toEqual([{ keys: [ORIGIN_KEY], writesBefore: 0 }]);
    expect(h.sim.state.rest.objects["/apps/demo"]!.allowed_origins).toEqual(["https://prod.example.app", "https://pr-42.example.app"]);

    const again = await readApply(h, listItem, ORIGIN);
    expect(again.diffs.map((d) => d.kind)).toEqual(["unchanged"]);
    expect(again.result.created).toEqual([]);
    expect(h.sim.state.writes).toHaveLength(1);

    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/apps/demo"]!.allowed_origins).toEqual(["https://prod.example.app"]);
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.writes).toHaveLength(2);
  });

  it("map items: identified by key_field, updated in place, kept fields left alone", async () => {
    const rule = { api: "demo", parent: { path: "/apps/demo", method: "PUT", send: "parent" }, list_path: "/rules", key_field: "name", item: { name: "pr-42", allow: "https://pr-42.example.app", priority: 10 } };
    const actx = h.actx("http", API);
    await listItem.apply(actx, rule, null);
    expect(h.sim.state.rest.objects["/apps/demo"]).toMatchObject({ name: "demo app", rules: [{ name: "pr-42", allow: "https://pr-42.example.app", priority: 10 }] });
    await h.chaos({ drift: { "rest.objects./apps/demo.name": '"renamed in the console"' } });
    const changed = resolved({ ...rule, item: { name: "pr-42", allow: "https://pr-42.example.app", priority: { keep: true }, note: "x" } });
    const u = await readApply(h, listItem, changed);
    expect(u.diffs[0]!.kind).toBe("update");
    expect(h.sim.state.rest.objects["/apps/demo"]).toMatchObject({ name: "renamed in the console", rules: [{ name: "pr-42", allow: "https://pr-42.example.app", priority: 10, note: "x" }] });
    expect((await readApply(h, listItem, changed)).diffs[0]!.kind).toBe("unchanged");
  });

  it("delimited strings: one value in a comma-separated list", async () => {
    await h.chaos({ drift: { "rest.objects./apps/demo.uri_allow_list": '"https://prod.example.app, http://localhost:3000"' } });
    const uri = { api: "demo", parent: { path: "/apps/demo" }, list_path: "/uri_allow_list", shape: "delimited", item: "https://pr-42.example.app/**" };
    const actx = h.actx("http", API);
    const r = await listItem.apply(actx, uri, null);
    expect(h.sim.state.rest.objects["/apps/demo"]!.uri_allow_list).toBe("https://prod.example.app,http://localhost:3000,https://pr-42.example.app/**");
    expect((await readApply(h, listItem, uri)).diffs[0]!.kind).toBe("unchanged");
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/apps/demo"]!.uri_allow_list).toBe("https://prod.example.app,http://localhost:3000");
  });

  it("keyed maps: one entry, written as a merge patch; null deletes it", async () => {
    await h.chaos({ drift: { "rest.objects./apps/demo.env_vars": '{"SHARED":{"value":"1"}}' } });
    const v = { api: "demo", parent: { path: "/apps/demo" }, list_path: "/env_vars", shape: "map", item: "API_URL", value: { type: "plain_text", value: "https://pr-42.example.app/api" } };
    const actx = h.actx("http", API);
    const r = await listItem.apply(actx, v, null);
    expect(h.sim.state.rest.objects["/apps/demo"]!.env_vars).toEqual({ SHARED: { value: "1" }, API_URL: { type: "plain_text", value: "https://pr-42.example.app/api" } });
    const u = await readApply(h, listItem, { ...v, value: { type: "plain_text", value: "https://pr-43.example.app/api" } });
    expect(u.diffs[0]!.kind).toBe("update");
    expect((h.sim.state.rest.objects["/apps/demo"]!.env_vars as Record<string, unknown>).API_URL).toEqual({ type: "plain_text", value: "https://pr-43.example.app/api" });
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/apps/demo"]!.env_vars).toEqual({ SHARED: { value: "1" } });
  });

  it("keyed maps at the root of the parent (config vars)", async () => {
    await h.close();
    h = await harness({ rest: { objects: { "/apps/demo/config-vars": { LOG_LEVEL: "info" } } } });
    const v = { api: "demo", parent: { path: "/apps/demo/config-vars" }, list_path: "", shape: "map", item: "API_URL", value: "https://pr-42.example.app" };
    const actx = h.actx("http", API);
    const r = await listItem.apply(actx, v, null);
    expect(h.sim.state.rest.objects["/apps/demo/config-vars"]).toEqual({ LOG_LEVEL: "info", API_URL: "https://pr-42.example.app" });
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/apps/demo/config-vars"]).toEqual({ LOG_LEVEL: "info" });
  });

  it("drift: an item removed in the console reads as missing; listScope reports every item", async () => {
    const actx = h.actx("http", API);
    await listItem.apply(actx, ORIGIN, null);
    await h.chaos({ drift: { "rest.objects./apps/demo.allowed_origins": "add:https://someone-else.example.app" } });
    expect((await listItem.listScope!(actx, ORIGIN)).map((r) => r.key)).toEqual([ORIGIN_KEY, "/apps/demo#/allowed_origins=https://someone-else.example.app"]);
    await h.chaos({ drift: { "rest.objects./apps/demo.allowed_origins": "remove:https://pr-42.example.app" } });
    expect(await listItem.read(actx, ORIGIN)).toBeNull();
  });

  it("re-reads after writing: an item a concurrent writer dropped is written again; one that never lands is PROVIDER_CONFLICT", async () => {
    let hide = 1;
    // The read right after our first write misses the item, as if another writer replaced the list in between.
    const proxy = await recordingProxy(`${h.sim.url}/rest`, (req, body) => {
      const wrote = proxy.log.some((x) => x.method === "PATCH");
      if (req.method !== "GET" || !wrote || hide <= 0) return body;
      hide--;
      return { ...(body as Record<string, unknown>), allowed_origins: [] };
    });
    try {
      const actx = h.actx("http", API, { env: { ...h.env, REST_API_URL: proxy.url } });
      const r = await listItem.apply(actx, ORIGIN, null);
      expect(r.created).toEqual([ORIGIN_KEY]);
      expect(proxy.log.filter((x) => x.method === "PATCH")).toHaveLength(2);
      expect(h.intents).toHaveLength(1);
      hide = 100;
      await expect(listItem.apply(actx, { ...ORIGIN, item: "https://pr-43.example.app" }, null)).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
    } finally {
      await proxy.close();
    }
  });

  it("a write whose connection dropped is retried (it replaces the list, so it is idempotent)", async () => {
    await h.chaos({ drop_response_next: 1, fail_on: "PATCH /rest/apps/demo" });
    await listItem.apply(h.actx("http", API), ORIGIN, null);
    expect(h.sim.state.rest.objects["/apps/demo"]!.allowed_origins).toEqual(["https://pr-42.example.app"]);
  });

  it("pending items are not read and are shown as pending; destroy: keep leaves the item", async () => {
    const pending = resolved({ ...ORIGIN, item: { from: "web.preview_url" } });
    expect(await listItem.read(h.actx("http", API), pending)).toBeNull();
    expect(listItem.diff(null, pending)[0]).toMatchObject({ key: "(pending)", after: { state: "pending", ref: "web.preview_url" } });
    const actx = h.actx("http", API);
    const r = await listItem.apply(actx, { ...ORIGIN, destroy: "keep" }, null);
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/apps/demo"]!.allowed_origins).toEqual(["https://pr-42.example.app"]);
  });

  it("parent.item_path reads the parent out of its envelope; send: a list sends those fields back with the list", async () => {
    await h.close();
    // As GrowthBook reads `{ feature: {...} }` and takes `{ rules }`; as ConfigCat's PUT resets what it is not sent.
    h = await harness({ rest: { objects: { "/features/f": { id: "f", owner: "x", defaultValue: "false", rules: [{ id: "r1", description: "prod" }] } }, styles: { "/features/f": { item_path: "/feature" } } } });
    const actx = h.actx("http", API);
    const rule = { api: "demo", parent: { path: "/features/f", method: "PUT", item_path: "/feature", send: ["defaultValue", "/missing/field"] }, list_path: "/rules", key_field: "description", item: { description: "pr-42", value: "true" } };
    expect(await listItem.read(actx, rule)).toBeNull();
    const r = await listItem.apply(actx, rule, null);
    expect(r.created).toHaveLength(1);
    expect(h.sim.state.rest.objects["/features/f"]).toEqual({ defaultValue: "false", rules: [{ id: "r1", description: "prod" }, { description: "pr-42", value: "true" }] });
    expect((await readApply(h, listItem, rule)).diffs[0]!.kind).toBe("unchanged");
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/features/f"]).toEqual({ defaultValue: "false", rules: [{ id: "r1", description: "prod" }] });
    await expect(listItem.read(actx, { ...rule, parent: { path: "/features/f", item_path: "/nope" } })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: expect.stringMatching(/no object at `parent.item_path` \/nope/) });
  });

  it("map items may be identified by a pointer into the item (a condition's value)", async () => {
    const group = { api: "demo", parent: { path: "/apps/demo" }, list_path: "/rules", key_field: "/properties/0/value/0", item: { properties: [{ key: "host", value: ["pr-42.example.app"] }], rollout_percentage: 100 } };
    const actx = h.actx("http", API);
    const r = await listItem.apply(actx, group, null);
    expect(r.resources[0]!.key).toBe("/apps/demo#/rules=pr-42.example.app");
    expect((await readApply(h, listItem, group)).diffs[0]!.kind).toBe("unchanged");
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.rest.objects["/apps/demo"]!.rules).toEqual([]);
  });

  it("the live state passed to diff and apply is the one read returned", async () => {
    const actx = h.actx("http", API);
    await listItem.apply(actx, ORIGIN, null);
    const live = (await listItem.read(actx, ORIGIN)) as LiveState;
    // A copy (as a caller that serialised the state would pass) still diffs, without the live value to show.
    expect(listItem.diff({ ...live }, ORIGIN)[0]!.kind).toBe("unchanged");
  });
});
