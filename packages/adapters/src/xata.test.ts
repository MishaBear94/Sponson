/** Unit tests for the Xata adapter against the in-process sim (assumptions XA1… in packages/sim/src/routes/xata.ts). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { xataAdapter } from "./xata.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const op = xataAdapter.ops.branch!;
const provider = { organization: "acme", project: "app" };
const params = { name: "pr-42", parent_id: "br_main" };
const KEY = "branch:pr-42";
const FAST = { SPONSON_XATA_POLL_MS: "1" };

describe("xata branch", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const actx = (env: NodeJS.ProcessEnv = {}) => h.actx("xata", provider, { env: { ...h.env, ...FAST, ...env } });
  const branches = () => h.sim.state.xata.projects["acme/app"]!.branches;

  it("creates a child of the parent, waits until healthy, outputs its connection string, reads back unchanged, destroys only it", async () => {
    expect(await op.read(actx(), params)).toBeNull();
    expect(op.diff(null, params)).toEqual([{ key: KEY, kind: "create", label: "Xata branch pr-42", before: { state: "absent" }, after: { state: "literal", value: "child of br_main" } }]);

    const r = await op.apply(actx(), params, null);
    expect(r.created).toEqual([KEY]);
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", /^\/xata\/organizations\/acme\/projects\/app\/branches$/)).toBe(0);
    const made = branches().find((b) => b.name === "pr-42")!;
    expect(made).toMatchObject({ parentID: "br_main", pending: 0 });
    expect(r.outputs).toEqual({ branch_id: made.id, connection_string: expect.stringContaining(made.password) });

    // Later runs read the connection string again (XA6): dependents in any run get it.
    const live = await op.read(actx(), params);
    expect(live!.outputs).toEqual(r.outputs);
    expect(op.diff(live, params)).toEqual([{ key: KEY, kind: "unchanged", label: "Xata branch pr-42" }]);
    const writes = (await h.writes()).length;
    expect((await op.apply(actx(), params, live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(writes);

    await op.destroy(actx(), r.resources);
    expect(branches().map((b) => b.name)).toEqual(["main"]);
    await op.destroy(actx(), r.resources); // already gone is success
    await op.destroy(actx(), [{ key: "branch:main", id: "", hash: "" }]); // an unlocated intent deletes nothing
    expect(branches().map((b) => b.name)).toEqual(["main"]);
  });

  it("a branch not healthy in time is WAIT_TIMEOUT; the next run finds it by name", async () => {
    await h.close();
    h = await harness({ xata: { projects: { "acme/app": [{ id: "br_main", name: "main" }] }, readyPolls: 1000 } });
    await expect(op.apply(actx({ SPONSON_XATA_READY_TIMEOUT_MS: "5" }), params, null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    const live = await op.read(actx(), params);
    expect(live!.resources.map((x) => x.key)).toEqual([KEY]);
  });

  it("two branches with the line's name are refused, never guessed (XA3)", async () => {
    await h.close();
    h = await harness({ xata: { projects: { "acme/app": [{ id: "br_main", name: "main" }, { id: "br_a", name: "pr-42" }, { id: "br_b", name: "pr-42" }] } } });
    await expect(op.read(actx(), params)).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("an unknown parent is the provider's 404, and nothing is created", async () => {
    await expect(op.apply(actx(), { ...params, parent_id: "br_nope" }, null)).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    expect(branches()).toHaveLength(1);
  });

  it("needs the organization, the project and the key", async () => {
    await expect(op.read(h.actx("xata", { organization: "acme" }, { env: h.env }), params)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    const { XATA_API_KEY: _k, ...noKey } = h.env;
    await expect(op.read(h.actx("xata", provider, { env: noKey }), params)).rejects.toThrow(/XATA_API_KEY/);
  });
});
