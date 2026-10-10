/** Unit tests for the Algolia adapter against the in-process sim (assumptions AL1… in packages/sim/src/routes/algolia.ts). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { algoliaAdapter } from "./algolia.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const op = algoliaAdapter.ops.index!;
const provider = { application_id: "APP123" };
const params = { name: "products_pr-42", copy_from: "products" };
const KEY = "index:products_pr-42";
const FAST = { SPONSON_ALGOLIA_POLL_MS: "1" };

describe("algolia index", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const actx = (env: NodeJS.ProcessEnv = {}) => h.actx("algolia", provider, { env: { ...h.env, ...FAST, ...env } });

  it("copies the template, waits for the task to be published, reads back unchanged, destroys only the copy", async () => {
    expect(await op.read(actx(), params)).toBeNull();
    expect(op.diff(null, params)).toEqual([{ key: KEY, kind: "create", label: "Algolia index products_pr-42", before: { state: "absent" }, after: { state: "literal", value: "copy of products" } }]);

    const r = await op.apply(actx(), params, null);
    expect(r).toMatchObject({ created: [KEY], outputs: { name: "products_pr-42" }, resources: [{ key: KEY, id: "products_pr-42" }] });
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", /^\/algolia\/1\/indexes\/products\/operation$/)).toBe(0);
    // The copy is there once apply returns: the task was polled until published.
    expect(h.sim.state.algolia.indices["products_pr-42"]).toMatchObject({ entries: 3, settings: { searchableAttributes: ["name"] } });

    const live = await op.read(actx(), params);
    expect(op.diff(live, params)).toEqual([{ key: KEY, kind: "unchanged", label: "Algolia index products_pr-42" }]);
    const writes = (await h.writes()).length;
    expect((await op.apply(actx(), params, live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(writes);

    await op.destroy(actx(), r.resources);
    expect(Object.keys(h.sim.state.algolia.indices)).toEqual(["products"]);
    await op.destroy(actx(), r.resources); // already gone is success (AL6)
    // An intent whose answer was lost has no id: the key names the index.
    await op.destroy(actx(), [{ key: KEY, id: "", hash: "" }]);
  });

  it("copies only the scope it is given", async () => {
    await op.apply(actx(), { ...params, scope: ["settings"] }, null);
    expect(h.sim.state.algolia.indices["products_pr-42"]).toMatchObject({ entries: 0, settings: { searchableAttributes: ["name"] } });
    await expect(op.apply(actx(), { ...params, name: "x", scope: ["records"] }, null)).rejects.toThrow(/`scope` must be/);
  });

  it("refuses a template that does not exist (a copy would make an empty index), and an index copied onto itself", async () => {
    await expect(op.apply(actx(), { ...params, copy_from: "nope" }, null)).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(op.apply(actx(), { name: "products", copy_from: "products" }, null)).rejects.toThrow(/same index/);
    expect(h.sim.state.writes).toHaveLength(0);
  });

  it("a task that is not published in time is WAIT_TIMEOUT; the next run finds the copy", async () => {
    await h.close();
    h = await harness({ algolia: { indices: { products: { entries: 2 } }, taskPolls: 1000 } });
    await expect(op.apply(actx({ SPONSON_ALGOLIA_TASK_TIMEOUT_MS: "5" }), params, null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(h.intents.map((i) => i.keys)).toEqual([[KEY]]);
    h.sim.state.algolia.taskPolls = 0;
    for (const t of Object.values(h.sim.state.algolia.tasks)) t.pending = 0;
    await op.apply(actx(), params, null);
    expect(h.sim.state.algolia.indices["products_pr-42"]).toMatchObject({ entries: 2 });
  });

  it("needs the application id and the key", async () => {
    await expect(op.read(h.actx("algolia", {}, { env: h.env }), params)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    const { ALGOLIA_API_KEY: _k, ...noKey } = h.env;
    await expect(op.read(h.actx("algolia", provider, { env: noKey }), params)).rejects.toThrow(/ALGOLIA_API_KEY/);
  });
});
