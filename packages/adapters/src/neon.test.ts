import { pendingMarker } from "@sponson/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { neonAdapter } from "./neon.js";
import { harness, type Harness } from "./testing.js";

const op = neonAdapter.ops.branch!;

describe("neon branch", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const params = () => op.defaults!({}, h.ctx);

  it("defaults name and parent from ctx", () => {
    expect(params()).toEqual({ parent: "main", name: "sponson/preview/pr-42" });
  });

  it("create → read → unchanged → destroy → 404 is fine", async () => {
    const actx = h.actx("neon");
    expect(await op.read(actx, params())).toBeNull();
    expect(op.diff(null, params())).toEqual([expect.objectContaining({ kind: "create", key: "branch:sponson/preview/pr-42", after: "sponson/preview/pr-42" })]);

    const result = await op.apply(actx, params(), null);
    expect(result.created).toEqual(["branch:sponson/preview/pr-42"]);
    expect(result.outputs.branch_id).toMatch(/^br-/);
    expect(result.outputs.host).toMatch(/\.sim\.neon\.tech$/);
    expect(String(result.outputs.connection_string)).toMatch(/^postgres:\/\/neondb_owner:pw_br-\d+@/);

    const live = await op.read(actx, params());
    expect(live?.resources).toEqual(result.resources);
    expect(live?.outputs).toEqual(result.outputs);
    // An unchanged diff carries only its label; before/after would render as "Neon branch x → x".
    expect(op.diff(live, params())).toEqual([{ key: "branch:sponson/preview/pr-42", kind: "unchanged", label: "Neon branch sponson/preview/pr-42" }]);
    expect(op.diff(live, { ...params(), parent: "other" })[0]?.kind).toBe("unchanged");

    const before = (await h.writes()).length;
    const again = await op.apply(actx, params(), live);
    expect(again.created).toEqual([]);
    expect((await h.writes()).length).toBe(before);

    await op.destroy(actx, result.resources);
    expect(await op.read(actx, params())).toBeNull();
    await expect(op.destroy(actx, result.resources)).resolves.toBeUndefined();
  });

  it("fails clearly when the parent does not exist", async () => {
    await expect(op.apply(h.actx("neon"), { ...params(), parent: "nope" }, null)).rejects.toThrow(/parent branch `nope` not found/);
  });

  it("listScope reports only sponson/ branches", async () => {
    const actx = h.actx("neon");
    await op.apply(actx, params(), null);
    const scope = await op.listScope!(actx, params());
    expect(scope.map((r) => r.key)).toEqual(["branch:sponson/preview/pr-42"]);
  });

  it("pending name diffs as create and apply refuses it", async () => {
    const p = { ...params(), name: pendingMarker("x.name") };
    expect(op.diff(null, p)).toEqual([expect.objectContaining({ kind: "create", after: "(pending ← x.name)" })]);
    await expect(op.apply(h.actx("neon"), p, null)).rejects.toThrow(/pending/);
  });

  it("names the missing env var and provider key", async () => {
    await expect(op.read({ ...h.actx("neon"), env: {} }, params())).rejects.toThrow(/NEON_API_KEY/);
    await expect(op.read(h.actx("neon", {}), params())).rejects.toThrow(/providers\.neon\.project/);
  });

  it("an empty token counts as missing", async () => {
    await expect(op.read({ ...h.actx("neon"), env: { ...h.env, NEON_API_KEY: "" } }, params())).rejects.toThrow(/NEON_API_KEY/);
  });
});
