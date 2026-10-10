import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SponsonError, pendingMarker } from "@sponson/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { neonAdapter } from "./neon.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const op = neonAdapter.ops.branch!;
const CREATE = /^\/neon\/projects\/[^/]+\/branches$/;

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
    expect(op.diff(null, params())).toEqual([
      { key: "branch:sponson/preview/pr-42", kind: "create", label: "Neon branch sponson/preview/pr-42", before: { state: "absent" }, after: { state: "literal", value: "sponson/preview/pr-42" } },
    ]);

    const result = await op.apply(actx, params(), null);
    expect(result.created).toEqual(["branch:sponson/preview/pr-42"]);
    expect(result.outputs.branch_id).toMatch(/^br-/);
    expect(result.outputs.host).toMatch(/\.sim\.neon\.tech$/);
    expect(String(result.outputs.connection_string)).toMatch(/^postgres:\/\/neondb_owner:pw_br-\d+@/);

    const live = await op.read(actx, params());
    expect(live?.resources).toEqual(result.resources);
    expect(live?.outputs).toEqual(result.outputs);
    // An unchanged diff carries only its label.
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

  it("reads the connection string for the branch's own database and owner role, not hard-coded defaults", async () => {
    // An older project: its database and role are not named like a new project's `neondb` / `neondb_owner`.
    h.sim.state.neon.projects.proj_demo!.branches[0]!.database = { name: "app", owner_name: "alex" };
    const actx = h.actx("neon");
    const r = await op.apply(actx, params(), null);
    expect(String(r.outputs.connection_string)).toMatch(/^postgres:\/\/alex:pw_br-\d+@.*\/app$/);
    const live = await op.read(actx, params());
    expect(live?.outputs).toEqual(r.outputs);
  });

  it("announces the key with intend() before the create request", async () => {
    const r = await op.apply(h.actx("neon"), params(), null);
    expect(h.intents).toEqual([{ keys: r.created, writesBefore: 0 }]);
    expect(writeIndex(h, "POST", CREATE)).toBe(0);
  });

  it("does not intend or write when intend() itself fails", async () => {
    const actx = h.actx("neon", undefined, {
      intend: async () => {
        throw new Error("ledger unavailable");
      },
    });
    await expect(op.apply(actx, params(), null)).rejects.toThrow(/ledger unavailable/);
    expect(h.sim.state.writes).toEqual([]);
  });

  it("409 'already exists' (e.g. our own lost response) is re-read and returned as not created", async () => {
    const actx = h.actx("neon");
    // Exists already, but our read missed it (stale live passed in).
    await op.apply(actx, params(), null);
    const r = await op.apply(actx, params(), null);
    expect(r.created).toEqual([]);
    expect(r.resources.map((x) => x.key)).toEqual(["branch:sponson/preview/pr-42"]);
    expect(r.outputs.connection_string).toMatch(/^postgres:/);
    expect(h.sim.state.neon.projects.proj_demo!.branches.filter((b) => b.name === "sponson/preview/pr-42")).toHaveLength(1);
  });

  it("finds the branch and the parent on any page of the branch list", async () => {
    await h.close();
    h = await harness({
      neon: { projects: { proj_demo: { branches: [{ name: "main" }, { name: "dev", parent: "main" }, { name: "staging", parent: "main" }, { name: "qa", parent: "main" }, { name: "base", parent: "main" }] } } },
      chaos: { page_size: 2 },
    });
    const actx = h.actx("neon");
    const p = { ...params(), parent: "base" };
    await op.apply(actx, p, null);
    const live = await op.read(actx, p);
    expect(live).not.toBeNull();
    expect(op.diff(live, p)[0]?.kind).toBe("unchanged");
    expect(h.sim.state.writes.filter((w) => !w.failed)).toHaveLength(1);
  });

  it("waits out 423 Locked while the previous create's operations run", async () => {
    // A window wide enough that the second create lands in it even on a loaded machine, and a backoff (50ms base,
    // 4 retries: at least 375ms in all) that outlasts it.
    await h.chaos({ neon_op_ms: 200 });
    const actx = h.actx("neon", undefined, { env: { ...h.env, SPONSON_HTTP_RETRY_BASE_MS: "50" } });
    await op.apply(actx, params(), null);
    const r = await op.apply(actx, { ...params(), name: "sponson/preview/pr-42-analytics" }, null);
    expect(r.created).toEqual(["branch:sponson/preview/pr-42-analytics"]);
    expect(h.sim.state.neon.projects.proj_demo!.branches).toHaveLength(3);
    const posts = h.sim.state.writes.filter((w) => w.method === "POST");
    expect(posts.filter((w) => !w.failed)).toHaveLength(2);
    expect(posts.filter((w) => w.failed).length).toBeGreaterThan(0); // the 423s that were waited out
  });

  it("fails clearly when the parent does not exist", async () => {
    const e = await op.apply(h.actx("neon"), { ...params(), parent: "nope" }, null).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SponsonError);
    expect(e).toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/parent branch `nope` not found/) });
  });

  it("listScope reports every branch but the project's default one", async () => {
    await h.close();
    h = await harness({ neon: { projects: { proj_demo: { branches: [{ name: "main" }, { name: "dev", parent: "main" }] } } } });
    const actx = h.actx("neon");
    await op.apply(actx, params(), null);
    const scope = await op.listScope!(actx, params());
    expect(scope.map((r) => r.key).sort()).toEqual(["branch:dev", "branch:sponson/preview/pr-42"]);
  });

  it("pending name diffs as create and apply refuses it", async () => {
    const p = { ...params(), name: pendingMarker("x.name") };
    expect(op.diff(null, p)).toEqual([expect.objectContaining({ kind: "create", after: { state: "pending", ref: "x.name" } })]);
    await expect(op.apply(h.actx("neon"), p, null)).rejects.toThrow(/pending/);
  });

  it("an unexpected list shape is PROVIDER_RESPONSE naming neon and the endpoint, not a TypeError", async () => {
    const server = createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const e = await op.read(h.actx("neon", undefined, { env: { ...h.env, NEON_API_URL: url } }), params()).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: "PROVIDER_RESPONSE", message: "neon: GET /projects/proj_demo/branches → 200: expected `branches` to be an array, got undefined" });
    } finally {
      server.close();
    }
  });

  it("names the missing env var and provider key", async () => {
    await expect(op.read({ ...h.actx("neon"), env: {} }, params())).rejects.toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringMatching(/NEON_API_KEY/) });
    await expect(op.read(h.actx("neon", {}), params())).rejects.toThrow(/providers\.neon\.project/);
  });

  it("an empty token counts as missing", async () => {
    await expect(op.read({ ...h.actx("neon"), env: { ...h.env, NEON_API_KEY: "" } }, params())).rejects.toThrow(/NEON_API_KEY/);
  });
});

describe("neon branch adopt", () => {
  it("one line per branch, naming it", () => {
    const ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: null }, scope: "branch-feat-x" };
    expect(neonAdapter.ops.branch!.adopt!([{ key: "branch:preview/old" }, { key: "branch:x" }], ctx)).toEqual([
      { id: "db-preview/old", params: { name: "preview/old" }, keys: ["branch:preview/old"] },
      { id: "db-x", params: { name: "x" }, keys: ["branch:x"] },
    ]);
  });
});
