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

  it("lists and addresses a collection at its other paths too (also_at)", async () => {
    sim = await startSim({ seed: { rest: { collections: { "/projects/p/databases": [] }, styles: { "/projects/p/databases": { also_at: ["/databases", "/all-databases"] } } } } });
    const created = await call("POST", "/projects/p/databases", { name: "app-pr-1" });
    const id = (created.body.data as { id: string }).id;
    expect((await call("GET", `/databases/${id}`)).body).toEqual({ data: { name: "app-pr-1", id } });
    expect((await call("GET", "/all-databases")).body).toEqual({ data: [{ name: "app-pr-1", id }], next_cursor: null });
    expect((await call("PATCH", `/databases/${id}`, { size: 2 })).status).toBe(200);
    expect((await call("DELETE", `/databases/${id}`)).body).toEqual({ id, deleted: true });
    expect(sim.state.rest.collections["/projects/p/databases"]).toEqual([]);
  });

  it("accepts a credential in any *-Key or *-Token header", async () => {
    sim = await startSim();
    expect((await call("GET", "/gates", undefined, { "x-auth-token": "t" })).status).toBe(200);
    expect((await call("GET", "/gates", undefined, { "x-postmark-server-key": "t" })).status).toBe(200);
    expect((await call("GET", "/gates", undefined, { "x-other": "t" })).status).toBe(401);
  });
});
