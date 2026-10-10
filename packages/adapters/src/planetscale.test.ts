/** Unit tests for the PlanetScale adapter against the in-process sim (assumptions PS1… in packages/sim/src/routes/planetscale.ts). */
import { pendingMarker, resolveParams } from "@sponson/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planetscaleAdapter } from "./planetscale.js";
import { harness, writeIndex, type Harness } from "./testing.js";

const branchOp = planetscaleAdapter.ops.branch!;
const passwordOp = planetscaleAdapter.ops.password!;
const BASE = "/planetscale/organizations/acme/databases/app";
const NAME = "sponson-preview-pr-42";
const BRANCH_KEY = `branch:${NAME}`;
const PW_KEY = `password:${NAME}/${NAME}`;

/** Sim writes that took effect (refused ones are logged too, as failed). */
function effective(h: Harness) {
  return h.sim.state.writes.filter((w) => !w.failed);
}

function db(h: Harness) {
  return h.sim.state.planetscale.organizations.acme!.databases.app!;
}

describe("planetscale branch", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const params = () => branchOp.defaults!({}, h.ctx);

  it("defaults: parent main, a name of lowercase letters, digits and dashes", () => {
    expect(params()).toEqual({ parent: "main", name: NAME });
    expect(branchOp.defaults!({}, { ...h.ctx, scope: "branch-Feat/X_y" }).name).toBe("sponson-preview-branch-feat-x-y");
    expect(branchOp.defaults!({ name: "mine" }, h.ctx).name).toBe("mine");
  });

  it("create (waiting until ready) → read → unchanged with zero writes → destroy → already gone is fine", async () => {
    await h.chaos({ planetscale_ready_ms: 40 });
    const actx = h.actx("planetscale");
    expect(await branchOp.read(actx, params())).toBeNull();
    expect(branchOp.diff(null, params())).toEqual([{ key: BRANCH_KEY, kind: "create", label: `PlanetScale branch ${NAME}`, before: { state: "absent" }, after: { state: "literal", value: NAME } }]);

    const started = Date.now();
    const r = await branchOp.apply(actx, params(), null);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30); // it waited for `ready` (PS4)
    expect(r.created).toEqual([BRANCH_KEY]);
    expect(r.outputs).toEqual({ name: NAME, branch_id: expect.stringMatching(/^psbr_/) });
    expect(db(h).branches.find((b) => b.name === NAME)).toMatchObject({ parent_branch: "main", createdBy: "api" });
    expect(h.intents).toEqual([{ keys: [BRANCH_KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", new RegExp(`^${BASE}/branches$`))).toBe(0);

    const live = await branchOp.read(actx, params());
    expect(live).toEqual({ resources: r.resources, outputs: r.outputs });
    expect(branchOp.diff(live, params())).toEqual([{ key: BRANCH_KEY, kind: "unchanged", label: `PlanetScale branch ${NAME}` }]);
    expect(branchOp.diff(live, { ...params(), parent: "other" })[0]!.kind).toBe("unchanged");
    const writes = h.sim.state.writes.length;
    expect((await branchOp.apply(actx, params(), live)).created).toEqual([]);
    expect(h.sim.state.writes.length).toBe(writes);

    await branchOp.destroy(actx, r.resources);
    expect(await branchOp.read(actx, params())).toBeNull();
    await expect(branchOp.destroy(actx, r.resources)).resolves.toBeUndefined();
  });

  it("sends the service token as `Authorization: <id>:<token>` (PS1); the sim refuses a bearer token", async () => {
    const bearer = await fetch(`${h.sim.url}${BASE}/branches`, { headers: { authorization: "Bearer tok_planetscale" } });
    expect(bearer.status).toBe(401);
    // The adapter's own requests pass, so its header has the right form.
    expect(await branchOp.read(h.actx("planetscale"), params())).toBeNull();
  });

  it("a name that already exists (422, our lost answer or someone else's) is found by name and returned as not created", async () => {
    const actx = h.actx("planetscale");
    await branchOp.apply(actx, params(), null);
    const again = await branchOp.apply(actx, params(), null); // stale `live`: the create meets the existing branch
    expect(again.created).toEqual([]);
    expect(again.resources.map((r) => r.key)).toEqual([BRANCH_KEY]);
    expect(db(h).branches.filter((b) => b.name === NAME)).toHaveLength(1);
    expect(h.intents.map((i) => i.keys)).toEqual([[BRANCH_KEY], [BRANCH_KEY]]);
  });

  it("a create whose answer is lost throws, and the branch is there to be found by name", async () => {
    await h.chaos({ drop_response_next: 1, fail_on: `POST ${BASE}/branches` });
    const actx = h.actx("planetscale");
    await expect(branchOp.apply(actx, params(), null)).rejects.toMatchObject({ code: "PROVIDER_TRANSIENT" });
    expect(h.intents.map((i) => i.keys)).toEqual([[BRANCH_KEY]]);
    expect((await branchOp.read(actx, params()))?.resources.map((r) => r.key)).toEqual([BRANCH_KEY]);
  });

  it("fails clearly when the parent does not exist, before announcing or writing anything", async () => {
    await expect(branchOp.apply(h.actx("planetscale"), { ...params(), parent: "nope" }, null)).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/parent branch `nope` not found in database app/) });
    expect(h.intents).toEqual([]);
    expect(h.sim.state.writes).toEqual([]);
  });

  it("gives up waiting with WAIT_TIMEOUT when the branch does not become ready in time", async () => {
    await h.chaos({ planetscale_ready_ms: 60_000 });
    const actx = h.actx("planetscale", undefined, { env: { ...h.env, SPONSON_PLANETSCALE_READY_TIMEOUT_MS: "30" } });
    await expect(branchOp.apply(actx, params(), null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT", message: expect.stringMatching(/not ready after 30ms/) });
  });

  it("destroy leaves a branch of the same name that someone else re-created (different id) alone", async () => {
    const actx = h.actx("planetscale");
    const r = await branchOp.apply(actx, params(), null);
    await h.chaos({ drift: { [`planetscale.branch.${NAME}`]: "recreate" } });
    await branchOp.destroy(actx, r.resources);
    expect(db(h).branches.some((b) => b.name === NAME)).toBe(true);
  });

  it("listScope reports every development branch, on any page, and never the production one", async () => {
    await h.close();
    const dev = ["a", "b", "c", "d"].map((name) => ({ name, parent: "main" }));
    h = await harness({ planetscale: { organizations: { acme: { app: [{ name: "main", production: true }, ...dev] } } }, chaos: { page_size: 2 } });
    const scope = await branchOp.listScope!(h.actx("planetscale"), params());
    expect(scope.map((r) => r.key)).toEqual(["branch:a", "branch:b", "branch:c", "branch:d"]);
  });

  it("names what is missing: either half of the service token, the organization, the database", async () => {
    const without = (name: string) => {
      const env = { ...h.env };
      delete env[name];
      return h.actx("planetscale", undefined, { env });
    };
    await expect(branchOp.read(without("PLANETSCALE_SERVICE_TOKEN_ID"), params())).rejects.toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringMatching(/PLANETSCALE_SERVICE_TOKEN_ID/) });
    await expect(branchOp.read(without("PLANETSCALE_SERVICE_TOKEN"), params())).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    await expect(branchOp.read(h.actx("planetscale", { database: "app" }), params())).rejects.toMatchObject({ code: "PLAN_INVALID", message: expect.stringMatching(/organization/) });
    await expect(branchOp.read(h.actx("planetscale", { organization: "acme" }), params())).rejects.toMatchObject({ code: "PLAN_INVALID", message: expect.stringMatching(/database/) });
  });

  it("a pending name diffs as create and is not read", async () => {
    const p = { ...params(), name: pendingMarker("x.name") };
    expect(await branchOp.read(h.actx("planetscale"), p)).toBeNull();
    expect(branchOp.diff(null, p)).toEqual([expect.objectContaining({ kind: "create", after: { state: "pending", ref: "x.name" } })]);
  });

  it("adopt: one line per branch, naming it", () => {
    expect(branchOp.adopt!([{ key: "branch:feature-x" }], h.ctx)).toEqual([{ id: "db-feature-x", params: { name: "feature-x" }, keys: ["branch:feature-x"] }]);
  });
});

describe("planetscale password", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await branchOp.apply(h.actx("planetscale"), branchOp.defaults!({}, h.ctx), null);
    h.intents.length = 0;
  });
  afterEach(() => h.close());

  const params = () => passwordOp.defaults!({ branch: NAME }, h.ctx);

  it("declares its plaintext outputs sensitive and once-only", () => {
    expect(passwordOp.outputs.password).toEqual({ available: "immediate", sensitive: true, once: true });
    expect(passwordOp.outputs.connection_string).toEqual({ available: "immediate", sensitive: true, once: true });
    expect(params()).toEqual({ branch: NAME, name: NAME, role: "admin" });
  });

  it("create returns the plaintext once; read never does; a second apply writes nothing", async () => {
    const actx = h.actx("planetscale");
    expect(await passwordOp.read(actx, params())).toBeNull();
    expect(passwordOp.diff(null, params())).toEqual([{ key: PW_KEY, kind: "create", label: `PlanetScale password ${NAME} on branch ${NAME}`, before: { state: "absent" }, after: { state: "literal", value: "admin" } }]);

    const start = h.sim.state.writes.length;
    const r = await passwordOp.apply(actx, params(), null);
    expect(r.created).toEqual([PW_KEY]);
    expect(h.intents).toEqual([{ keys: [PW_KEY], writesBefore: start }]);
    const pw = db(h).branches.find((b) => b.name === NAME)!.passwords[0]!;
    expect(r.outputs).toEqual({
      id: pw.id,
      username: pw.username,
      host: "aws.connect.psdb.sim",
      role: "admin",
      password: pw.plainText,
      connection_string: `mysql://${pw.username}:${pw.plainText}@aws.connect.psdb.sim/app?ssl={"rejectUnauthorized":true}`,
    });

    const live = await passwordOp.read(actx, params());
    expect(live).toEqual({ resources: r.resources, outputs: { id: pw.id, username: pw.username, host: "aws.connect.psdb.sim", role: "admin" } });
    expect(JSON.stringify(live)).not.toContain(pw.plainText);
    expect(passwordOp.diff(live, params())).toEqual([{ key: PW_KEY, kind: "unchanged", label: `PlanetScale password ${NAME} on branch ${NAME}` }]);
    const writes = h.sim.state.writes.length;
    expect(await passwordOp.apply(actx, params(), live)).toEqual({ resources: live!.resources, outputs: live!.outputs, created: [] });
    expect(h.sim.state.writes.length).toBe(writes);

    await passwordOp.destroy(actx, r.resources);
    expect(await passwordOp.read(actx, params())).toBeNull();
    await expect(passwordOp.destroy(actx, r.resources)).resolves.toBeUndefined();
  });

  it("connection_params replaces the query of the connection string (Prisma: sslaccept=strict)", async () => {
    const r = await passwordOp.apply(h.actx("planetscale"), { ...params(), connection_params: "sslaccept=strict" }, null);
    expect(String(r.outputs.connection_string)).toMatch(/@aws\.connect\.psdb\.sim\/app\?sslaccept=strict$/);
  });

  it("waits for a branch an earlier run left provisioning before creating the password (PS12)", async () => {
    await h.chaos({ planetscale_ready_ms: 40 });
    await fetch(`${h.sim.url}${BASE}/branches`, { method: "POST", body: JSON.stringify({ name: "slow", parent_branch: "main" }), headers: { authorization: "id:tok", "content-type": "application/json" } });
    const r = await passwordOp.apply(h.actx("planetscale"), { ...params(), branch: "slow" }, null);
    expect(r.created).toEqual([`password:slow/${NAME}`]);
    expect(h.sim.state.writes.filter((w) => w.method === "POST" && w.path.endsWith("/passwords"))).toHaveLength(1);
    expect(effective(h).filter((w) => w.path.endsWith("/passwords"))).toHaveLength(1);
  });

  it("a role change is refused at diff time and never replaces the password", async () => {
    const actx = h.actx("planetscale");
    await passwordOp.apply(actx, params(), null);
    const live = await passwordOp.read(actx, params());
    const writes = h.sim.state.writes.length;
    expect(() => passwordOp.diff(live, { ...params(), role: "reader" })).toThrow(/role admin.*new `name`/);
    await expect(passwordOp.apply(actx, { ...params(), role: "reader" }, live)).rejects.toMatchObject({ code: "PARAM_INVALID", details: { param: "role" } });
    expect(h.sim.state.writes.length).toBe(writes);
  });

  it("two passwords of the same name are a conflict, not a guess (PS9)", async () => {
    const actx = h.actx("planetscale");
    await passwordOp.apply(actx, params(), null);
    await passwordOp.apply(actx, params(), null); // stale `live`: the sim accepts a duplicate name
    await expect(passwordOp.read(actx, params())).rejects.toMatchObject({ code: "PROVIDER_CONFLICT", message: expect.stringMatching(/2 passwords named/) });
  });

  it("a missing branch: read finds nothing, apply names it before writing", async () => {
    const actx = h.actx("planetscale");
    const p = { ...params(), branch: "gone" };
    expect(await passwordOp.read(actx, p)).toBeNull();
    const writes = h.sim.state.writes.length;
    await expect(passwordOp.apply(actx, p, null)).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/branch `gone` not found/) });
    expect(h.sim.state.writes.length).toBe(writes);
    expect(h.intents).toEqual([]);
  });

  it("finds its password on any page of the list", async () => {
    const branch = db(h).branches.find((b) => b.name === NAME)!;
    for (const n of ["a", "b", "c"]) branch.passwords.push({ id: `x-${n}`, name: n, role: "reader", username: n, plainText: n, createdAt: 0, createdBy: "sim" });
    await h.chaos({ page_size: 2 });
    const actx = h.actx("planetscale");
    await passwordOp.apply(actx, params(), null);
    expect((await passwordOp.read(actx, params()))?.resources.map((r) => r.key)).toEqual([PW_KEY]);
  });

  it("a pending branch reference diffs as create and is not read", async () => {
    const p = resolveParams({ branch: { from: "db.name" }, name: NAME, role: "admin" }, new Map()).params;
    expect(await passwordOp.read(h.actx("planetscale"), p)).toBeNull();
    expect(passwordOp.diff(null, p)).toEqual([expect.objectContaining({ kind: "create" })]);
    await expect(passwordOp.apply(h.actx("planetscale"), p, null)).rejects.toThrow(/pending/);
  });
});
