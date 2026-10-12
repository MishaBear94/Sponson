/** The generic REST sim's per-collection styles (assumption R2 in routes/rest.ts), which the recipe tests rely on. */
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "./index.js";

const headers = { authorization: "Bearer t", "content-type": "application/json" };

describe("rest sim styles", () => {
  let sim: SimHandle;
  afterEach(() => sim.close());

  const call = async (method: string, path: string, body?: unknown, h: Record<string, string> = headers) => {
    const r = await fetch(`${sim.url}/rest${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it("answers in the collection's envelopes, with its id field and cursor", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/dbs": [{ Name: "seeded" }] }, styles: { "/dbs": { list_path: "/result/items", item_path: "/database", next_path: "/result/next", id_field: "Name", id_from: "name" } } } } });
    const created = await call("POST", "/dbs", { name: "app-pr-1", group: "g" });
    expect(created).toEqual({ status: 201, body: { database: { name: "app-pr-1", group: "g", Name: "app-pr-1" } } });
    expect((await call("POST", "/dbs", { name: "app-pr-1" })).status).toBe(409);
    expect((await call("GET", "/dbs/app-pr-1")).body).toEqual({ database: { name: "app-pr-1", group: "g", Name: "app-pr-1" } });
    expect((await call("PATCH", "/dbs/app-pr-1", { group: "h", Name: "renamed" })).body).toEqual({ database: { name: "app-pr-1", group: "h", Name: "app-pr-1" } });
    expect((await call("PUT", "/dbs/app-pr-1", { group: "i" })).body).toEqual({ database: { group: "i", Name: "app-pr-1" } });
    await fetch(`${sim.url}/_chaos`, { method: "POST", headers, body: JSON.stringify({ page_size: 1 }) });
    expect((await call("GET", "/dbs")).body).toEqual({ result: { items: [{ Name: "seeded" }], next: "1" } });
    expect((await call("DELETE", "/dbs/app-pr-1")).body).toEqual({ id: "app-pr-1", deleted: true });
    sim.state.applyDrift("rest.items./dbs.seeded", "recreate");
    expect(sim.state.rest.collections["/dbs"]![0]!.Name).toMatch(/^it_/);
  });

  it("answers bare objects and lists, without paging, with integer ids", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/hooks": [] }, styles: { "/hooks": { list_path: "", item_path: "", next_path: null, numeric_ids: true } } } } });
    await fetch(`${sim.url}/_chaos`, { method: "POST", headers, body: JSON.stringify({ page_size: 1 }) });
    const a = await call("POST", "/hooks", { url: "https://a" });
    await call("POST", "/hooks", { url: "https://b" });
    expect(typeof a.body.id).toBe("number");
    expect((await call("GET", `/hooks/${String(a.body.id)}`)).body).toEqual({ url: "https://a", id: a.body.id });
    expect(((await call("GET", "/hooks")).body as unknown as unknown[]).length).toBe(2);
  });

  it("creates an object with a PUT at a client-chosen key in a known collection; elsewhere a PUT to nothing is 404", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/services/srv-1/env-vars": [] }, styles: { "/services/srv-1/env-vars": { item_path: "", list_path: "", next_path: null, id_field: "key" } } } } });
    expect(await call("PUT", "/services/srv-1/env-vars/API_URL", { value: "https://a" })).toEqual({ status: 200, body: { value: "https://a", key: "API_URL" } });
    expect((await call("PUT", "/services/srv-1/env-vars/API_URL", { value: "https://b" })).body).toEqual({ value: "https://b", key: "API_URL" });
    expect((await call("GET", "/services/srv-1/env-vars/API_URL")).body).toEqual({ value: "https://b", key: "API_URL" });
    expect(sim.state.rest.collections["/services/srv-1/env-vars"]).toHaveLength(1);
    expect((await call("PUT", "/services/srv-2/env-vars/API_URL", { value: "x" })).status).toBe(404);
  });

  it("a create may choose its id with a query parameter (`id_query`), and a delete may name the object in its path", async () => {
    const coll = "/sites/demo/channels";
    sim = await startSim({ seed: { rest: { collections: { [coll]: [] }, styles: { [coll]: { item_path: "", list_path: "/channels", next_path: null, id_field: "name", id_query: "channelId" } }, deletes: { "/sites/demo/channels/{id}/delete": { collection: coll, ids: "" } } } } });
    expect(await call("POST", `${coll}?channelId=pr-42`, { ttl: "86400s" })).toEqual({ status: 201, body: { ttl: "86400s", name: "pr-42" } });
    expect((await call("POST", `${coll}?channelId=pr-42`, {})).status).toBe(409);
    expect((await call("GET", `${coll}/pr-42`)).body).toEqual({ ttl: "86400s", name: "pr-42" });
    // Without the query parameter the sim assigns the id, as before.
    expect(((await call("POST", coll, {})).body.name as string)).toMatch(/^it_/);
    expect(await call("POST", `${coll}/pr-42/delete`, {})).toEqual({ status: 200, body: { deleted: ["pr-42"] } });
    expect((await call("POST", `${coll}/pr-42/delete`, {})).status).toBe(404);
    expect((await call("GET", `${coll}/pr-42`)).status).toBe(404);
  });

  it("an alias of a collection lists it and addresses its objects too", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/projects/p/databases": [] }, aliases: { "/databases": "/projects/p/databases", "/all-databases": "/projects/p/databases" } } } });
    const created = await call("POST", "/projects/p/databases", { name: "app-pr-1" });
    const id = (created.body.data as { id: string }).id;
    expect((await call("GET", `/databases/${id}`)).body).toEqual({ data: { name: "app-pr-1", id } });
    expect((await call("GET", "/all-databases")).body).toEqual({ data: [{ name: "app-pr-1", id }], next_cursor: null });
    expect((await call("PATCH", `/databases/${id}`, { size: 2 })).status).toBe(200);
    expect((await call("DELETE", `/databases/${id}`)).body).toEqual({ id, deleted: true });
    expect(sim.state.rest.collections["/projects/p/databases"]).toEqual([]);
  });

  it("stores header_fields from a create's headers, and upserts by chosen id on a POST to <collection>/<suffix>", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/schedules": [] }, styles: { "/schedules": { item_path: "", list_path: "", next_path: null, id_field: "scheduleId", header_fields: { "X-Cron": "cron", "x-schedule-id": "scheduleId" }, suffix_field: "destination" } } } } });
    const h = { ...headers, "x-cron": "*/5 * * * *", "x-schedule-id": "s1" };
    expect((await call("POST", "/schedules/https://a.example/api", { ping: 1 }, h)).body).toEqual({ ping: 1, cron: "*/5 * * * *", scheduleId: "s1", destination: "https://a.example/api" });
    await call("POST", "/schedules/https://b.example/api", {}, { ...h, "x-cron": "0 * * * *" });
    expect(sim.state.rest.collections["/schedules"]).toEqual([{ ping: 1, cron: "0 * * * *", scheduleId: "s1", destination: "https://b.example/api" }]);
    expect((await call("GET", "/schedules/s1")).body).toMatchObject({ cron: "0 * * * *" });
    expect((await call("POST", "/schedules", { name: "plain" }, { ...headers, "x-cron": "1 * * * *" })).body).toMatchObject({ name: "plain", cron: "1 * * * *" });
  });

  it("types form values, shows once fields only in the create's answer, and updates by POST to the object (R4, R6)", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/webhook_endpoints": [] }, styles: { "/webhook_endpoints": { list_path: "/data", item_path: "", next_path: null, form_types: true, once_fields: ["secret"] } } } } });
    const form = { authorization: "Bearer t", "content-type": "application/x-www-form-urlencoded" };
    const post = async (path: string, body: string) => (await fetch(`${sim.url}/rest${path}`, { method: "POST", headers: form, body })).json() as Promise<Record<string, unknown>>;
    const created = await post("/webhook_endpoints", "url=https%3A%2F%2Fa&enabled_events[0]=x&disabled=false&n=3&metadata[k]=v");
    expect(created).toMatchObject({ url: "https://a", enabled_events: ["x"], disabled: false, n: 3, metadata: { k: "v" }, secret: expect.stringMatching(/^secret_sim_/) });
    const id = String(created.id);
    expect((await call("GET", `/webhook_endpoints/${id}`)).body).not.toHaveProperty("secret");
    expect(await post(`/webhook_endpoints/${id}`, "url=https%3A%2F%2Fb&disabled=true")).toMatchObject({ id, url: "https://b", disabled: true });
    expect(sim.state.rest.collections["/webhook_endpoints"]![0]).not.toHaveProperty("secret");
  });

  it("lists at an alias and names objects by a query parameter (R3)", async () => {
    const coll = "/projects/p/environments/e/redirect_urls";
    sim = await startSim({ seed: { rest: { collections: { [coll]: [] }, styles: { [coll]: { list_path: "/redirect_urls", item_path: "/redirect_url", next_path: null, id_field: "url", item_query: "url" } }, aliases: { [`${coll}/all`]: coll } } } });
    await call("POST", coll, { url: "https://a/cb", valid_types: [{ type: "LOGIN", is_default: false }] });
    expect((await call("GET", `${coll}/all`)).body).toEqual({ redirect_urls: [{ url: "https://a/cb", valid_types: [{ type: "LOGIN", is_default: false }] }] });
    const q = `${coll}?url=${encodeURIComponent("https://a/cb")}`;
    expect((await call("GET", q)).body).toEqual({ redirect_url: { url: "https://a/cb", valid_types: [{ type: "LOGIN", is_default: false }] } });
    expect((await call("PUT", q, { valid_types: [] })).body).toEqual({ redirect_url: { valid_types: [], url: "https://a/cb" } });
    expect((await call("GET", `${coll}?url=nope`)).status).toBe(404);
    expect((await call("DELETE", q)).status).toBe(200);
    expect(sim.state.rest.collections[coll]).toEqual([]);
  });

  it("accepts a credential in any *-Key or *-Token header, or bare in Authorization", async () => {
    sim = await startSim();
    expect((await call("GET", "/gates", undefined, { "x-auth-token": "t" })).status).toBe(200);
    expect((await call("GET", "/gates", undefined, { "x-postmark-server-key": "t" })).status).toBe(200);
    expect((await call("GET", "/gates", undefined, { authorization: "user:abc123" })).status).toBe(200);
    expect((await call("GET", "/gates", undefined, { "x-other": "t" })).status).toBe(401);
    expect((await call("GET", "/gates", undefined, { authorization: "Bearer" })).status).toBe(401);
    expect((await call("GET", "/gates", undefined, { authorization: "two words" })).status).toBe(401);
  });

  it("adds a create posted to an alias to its collection, and answers a styled object in its envelope", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/gates/g/rules": [] }, aliases: { "/gates/g/rule": "/gates/g/rules" }, objects: { "/features/f": { rules: [] } }, styles: { "/features/f": { item_path: "/feature" } } } } });
    expect((await call("POST", "/gates/g/rule", { name: "a" })).status).toBe(201);
    expect(sim.state.rest.collections["/gates/g/rules"]).toEqual([{ name: "a", id: expect.stringMatching(/^it_/) }]);
    expect((await call("GET", "/features/f")).body).toEqual({ feature: { rules: [] } });
    await call("POST", "/features/f", { rules: [{ id: "r1" }] });
    expect((await call("GET", "/features/f")).body).toEqual({ feature: { rules: [{ id: "r1" }] } });
  });

  it("accepts a credential in a header the seed declares, and only there", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/markers": [] }, auth_headers: ["X-Honeycomb-Team"] } } });
    expect((await call("GET", "/markers", undefined, { "x-honeycomb-team": "t" })).status).toBe(200);
    expect((await call("GET", "/markers", undefined, { "x-honeycomb-team": " " })).status).toBe(401);
    expect((await call("GET", "/markers", undefined, { "x-other": "t" })).status).toBe(401);
  });

  it("ignores a trailing slash, and lists a collection under its aliases", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/releases/": [] }, styles: { "/releases/": { id_field: "version", item_path: "" } }, aliases: { "/hooks/all": "/hooks" } } } });
    const created = await call("POST", "/releases/", { version: "1.0" });
    expect(created).toEqual({ status: 201, body: { version: "1.0" } });
    expect((await call("GET", "/releases/1.0/")).body).toEqual({ version: "1.0" });
    expect(Object.keys(sim.state.rest.collections)).toContain("/releases");
    await call("POST", "/hooks/", { url: "https://a" });
    expect(((await call("GET", "/hooks/all")).body.data as unknown[]).length).toBe(1);
    expect(sim.state.rest.collections["/hooks"]).toHaveLength(1);
  });
});
