import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clerkAdapter } from "./clerk.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const op = clerkAdapter.ops.redirect_allow!;
const params = { url: "https://pr-42.example.app/callback" };
const KEY = `redirect:${params.url}`;

describe("clerk redirect_allow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("create, unchanged, destroy", async () => {
    const actx = h.actx("clerk");
    expect(await op.read(actx, params)).toBeNull();
    expect(op.diff(null, params)).toEqual([{ key: KEY, kind: "create", label: "Clerk redirect", before: { state: "absent" }, after: { state: "literal", value: params.url } }]);

    const r = await op.apply(actx, params, null);
    expect(r.created).toEqual([KEY]);
    expect(r.outputs.id).toMatch(/^ru_/);
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", /^\/clerk\/redirect_urls$/)).toBe(0);

    const live = await op.read(actx, params);
    expect(live?.outputs).toEqual({ id: r.outputs.id });
    expect(op.diff(live, params)).toEqual([{ key: KEY, kind: "unchanged", label: "Clerk redirect" }]);
    const writes = (await h.writes()).length;
    await op.apply(actx, params, live);
    expect((await h.writes()).length).toBe(writes);

    await op.destroy(actx, r.resources);
    expect(await op.read(actx, params)).toBeNull();
    await op.destroy(actx, r.resources); // 404 is success
  });

  it("a duplicate (422 'already exists') is re-read and returned as existing, not created", async () => {
    const actx = h.actx("clerk");
    expect(await op.read(actx, params)).toBeNull();
    // Someone (or our own earlier, lost request) registers the URL between our read and our write.
    await fetch(`${h.sim.url}/clerk/redirect_urls`, { method: "POST", body: JSON.stringify(params), headers: { authorization: "Bearer other", "content-type": "application/json" } });
    const r = await op.apply(actx, params, null);
    expect(r.created).toEqual([]);
    expect(h.intents.map((i) => i.keys)).toEqual([[KEY]]); // intended, so the engine can claim it if the intent was ours
    expect(r.resources.map((x) => x.key)).toEqual([KEY]);
    expect(r.outputs.id).toMatch(/^ru_/);
    expect(h.sim.state.clerk.redirect_urls).toHaveLength(1);
  });

  it("reads the paginated { data, total_count } envelope across pages", async () => {
    await h.close();
    h = await harness({ clerk: { redirect_urls: ["https://a", "https://b", "https://c", params.url, "https://e"] }, chaos: { page_size: 2 } });
    const actx = h.actx("clerk");
    const live = await op.read(actx, params);
    expect(live?.resources.map((r) => r.key)).toEqual([KEY]);
    expect((await op.listScope!(actx, params)).map((r) => r.key)).toHaveLength(5);
  });

  it("a GET that answers 502 once is retried", async () => {
    await h.chaos({ fail_on: "GET /clerk/redirect_urls", fail_next: 1, status: 502 });
    expect(await op.read(h.actx("clerk"), params)).toBeNull();
    expect(h.sim.state.chaos.fail_next).toBe(0);
  });

  it("listScope includes seeded (unmanaged) urls", async () => {
    await h.close();
    h = await harness({ clerk: { redirect_urls: ["https://seed.example.app"] } });
    const scope = await op.listScope!(h.actx("clerk"), params);
    expect(scope.map((r) => r.key)).toEqual(["redirect:https://seed.example.app"]);
  });

  it("names the missing env var", async () => {
    await expect(op.read({ ...h.actx("clerk"), env: {} }, params)).rejects.toThrow(/CLERK_SECRET_KEY/);
  });

  it("a missing url is PARAM_INVALID", async () => {
    await expect(op.read(h.actx("clerk"), {})).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });
});
