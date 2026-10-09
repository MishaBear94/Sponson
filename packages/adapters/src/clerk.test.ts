import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clerkAdapter } from "./clerk.js";
import { harness, type Harness } from "./testing.js";

const op = clerkAdapter.ops.redirect_allow!;
const params = { url: "https://pr-42.example.app/callback" };

describe("clerk redirect_allow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("create, unchanged, destroy", async () => {
    const actx = h.actx("clerk");
    expect(await op.read(actx, params)).toBeNull();
    expect(op.diff(null, params)).toEqual([{ key: `redirect:${params.url}`, kind: "create", label: "Clerk redirect", after: params.url }]);

    const r = await op.apply(actx, params, null);
    expect(r.created).toEqual([`redirect:${params.url}`]);
    expect(r.outputs.id).toMatch(/^ru_/);

    const live = await op.read(actx, params);
    expect(live?.outputs).toEqual({ id: r.outputs.id });
    expect(op.diff(live, params)[0]?.kind).toBe("unchanged");
    const writes = (await h.writes()).length;
    await op.apply(actx, params, live);
    expect((await h.writes()).length).toBe(writes);

    await op.destroy(actx, r.resources);
    expect(await op.read(actx, params)).toBeNull();
    await op.destroy(actx, r.resources); // 404 is success
  });

  it("treats a duplicate (422) on a retry race as existing and adopted, not as a failure", async () => {
    const actx = h.actx("clerk");
    expect(await op.read(actx, params)).toBeNull();
    // Someone else registers the URL between our read and our write.
    await fetch(`${h.sim.url}/clerk/redirect_urls`, { method: "POST", body: JSON.stringify(params), headers: { authorization: "Bearer other", "content-type": "application/json" } });
    const r = await op.apply(actx, params, null);
    expect(r.created).toEqual([]);
    expect(r.resources.map((x) => x.key)).toEqual([`redirect:${params.url}`]);
    expect(r.outputs.id).toMatch(/^ru_/);
    expect(h.sim.state.clerk.redirect_urls).toHaveLength(1);
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
});
