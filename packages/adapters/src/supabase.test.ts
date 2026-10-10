/** Unit tests for the Supabase adapter against the in-process sim. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPABASE_DEMO_PROJECT, newSupabaseBranch, supabaseConnectionString } from "@sponson/sim";
import { supabaseAdapter } from "./supabase.js";
import { pendingMarker } from "@sponson/core";
import { harness, recordingProxy, writeIndex, type Harness } from "./testing.js";

const branchOp = supabaseAdapter.ops.branch!;
const redirectOp = supabaseAdapter.ops.auth_redirect!;
const P = SUPABASE_DEMO_PROJECT;
const provider = { project: P };
const NAME = "sponson-preview-pr-42";
const KEY = `branch:${NAME}`;
const ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: 42 }, scope: "pr-42" };

describe("supabase branch", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const params = () => branchOp.defaults!({}, ctx);
  const project = () => h.sim.state.supabase.projects[P]!;

  it("defaults the name per scope", () => {
    expect(params()).toEqual({ name: NAME });
    expect(branchOp.defaults!({ name: "mine" }, ctx)).toEqual({ name: "mine" });
  });

  it("create (intent first), outputs, unchanged, destroy", async () => {
    const actx = h.actx("supabase", provider);
    expect(await branchOp.read(actx, params())).toBeNull();
    expect(branchOp.diff(null, params())).toEqual([{ key: KEY, kind: "create", label: `Supabase branch ${NAME}`, before: { state: "absent" }, after: { state: "literal", value: NAME } }]);

    const r = await branchOp.apply(actx, params(), null);
    expect(r.created).toEqual([KEY]);
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    expect(writeIndex(h, "POST", new RegExp(`^/supabase/projects/${P}/branches$`))).toBe(0);
    const b = project().branches.find((x) => x.name === NAME)!;
    expect(r.resources).toEqual([{ key: KEY, id: b.project_ref, hash: expect.any(String), label: `Supabase branch ${NAME}` }]);
    expect(r.outputs).toEqual({ project_ref: b.project_ref, api_url: `https://${b.project_ref}.supabase.co`, db_host: `db.${b.project_ref}.supabase.co`, connection_string: supabaseConnectionString(b) });

    // apply; apply: the second performs zero writes.
    const live = await branchOp.read(actx, params());
    expect(live).toEqual({ resources: r.resources, outputs: r.outputs });
    expect(branchOp.diff(live, params())).toEqual([{ key: KEY, kind: "unchanged", label: `Supabase branch ${NAME}` }]);
    const writes = (await h.writes()).length;
    expect((await branchOp.apply(actx, params(), live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(writes);

    await branchOp.destroy(actx, r.resources);
    expect(await branchOp.read(actx, params())).toBeNull();
    await branchOp.destroy(actx, r.resources); // already gone is success
  });

  it("waits until the new branch is ACTIVE_HEALTHY before returning its outputs", async () => {
    await h.chaos({ supabase_ready_ms: 300 });
    const actx = h.actx("supabase", provider);
    const t0 = Date.now();
    const r = await branchOp.apply(actx, params(), null);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.outputs.connection_string).toMatch(/^postgresql:\/\/postgres:/);
  });

  it("read while the branch is coming up reports the ref and URL only; a timed-out wait fails, the next apply finishes it", async () => {
    await h.chaos({ supabase_ready_ms: 400 });
    const actx = h.actx("supabase", provider);
    const short = { ...actx, env: { ...actx.env, SPONSON_SUPABASE_TIMEOUT_MS: "50" } };
    await expect(branchOp.apply(short, params(), null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    const live = await branchOp.read(actx, params());
    expect(Object.keys(live!.outputs).sort()).toEqual(["api_url", "project_ref"]);
    const writes = (await h.writes()).length;
    const r = await branchOp.apply(actx, params(), live);
    expect(r.created).toEqual([]);
    expect(r.outputs.connection_string).toBeDefined();
    expect((await h.writes()).length).toBe(writes);
  });

  it("a branch that fails to come up is reported, not waited for", async () => {
    const actx = h.actx("supabase", provider);
    const r = await branchOp.apply(actx, params(), null);
    const proxied = await fetchDetailStatus(h, String(r.outputs.project_ref), "INIT_FAILED");
    try {
      await expect(branchOp.apply({ ...actx, env: { ...actx.env, SUPABASE_API_URL: proxied.url } }, params(), { resources: r.resources, outputs: {} })).rejects.toThrow(/INIT_FAILED/);
    } finally {
      await proxied.close();
    }
  });

  it("a name that already exists is re-read and returned as existing, not created", async () => {
    const actx = h.actx("supabase", provider);
    // Someone (or our own earlier, lost request) creates it between our read and our write.
    project().branches.push(newSupabaseBranch(h.sim.state, P, NAME, "sim"));
    const r = await branchOp.apply(actx, params(), null);
    expect(r.created).toEqual([]);
    expect(h.intents.map((i) => i.keys)).toEqual([[KEY]]);
    expect(r.resources.map((x) => x.key)).toEqual([KEY]);
    expect(project().branches.filter((b) => b.name === NAME)).toHaveLength(1);
  });

  it("a refusal that is not a duplicate is reported", async () => {
    await h.chaos({ fail_on: `POST /supabase/projects/${P}/branches`, fail_next: 1, status: 400 });
    await expect(branchOp.apply(h.actx("supabase", provider), params(), null)).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
  });

  it("never manages the project's default branch", async () => {
    const actx = h.actx("supabase", provider);
    await expect(branchOp.read(actx, { name: "main" })).rejects.toMatchObject({ code: "PARAM_INVALID" });
    expect(await branchOp.listScope!(actx, params())).toEqual([]);
    // Even a ledger naming the parent project cannot make destroy delete it.
    await branchOp.destroy(actx, [{ key: "branch:main", id: P, hash: "x" }]);
    expect(project().branches.some((b) => b.is_default)).toBe(true);
  });

  it("listScope reports every preview branch; adopt names each", async () => {
    await h.close();
    h = await harness({ supabase: { projects: { [P]: { branches: [{ name: "feature-a" }, { name: "feature-b" }] } } } });
    const found = await branchOp.listScope!(h.actx("supabase", provider), params());
    expect(found.map((r) => r.key)).toEqual(["branch:feature-a", "branch:feature-b"]);
    expect(branchOp.adopt!(found, ctx)).toEqual([
      { id: "db-feature-a", params: { name: "feature-a" }, keys: ["branch:feature-a"] },
      { id: "db-feature-b", params: { name: "feature-b" }, keys: ["branch:feature-b"] },
    ]);
  });

  it("a GET that answers 502 once is retried", async () => {
    await h.chaos({ fail_on: `GET /supabase/projects/${P}/branches`, fail_next: 1, status: 502 });
    expect(await branchOp.read(h.actx("supabase", provider), params())).toBeNull();
    expect(h.sim.state.chaos.fail_next).toBe(0);
  });

  it("a detail without database credentials is a PROVIDER_RESPONSE, not a broken connection string", async () => {
    const actx = h.actx("supabase", provider);
    const r = await branchOp.apply(actx, params(), null);
    const proxied = await fetchDetailStatus(h, String(r.outputs.project_ref), "ACTIVE_HEALTHY", true);
    try {
      await expect(branchOp.read({ ...actx, env: { ...actx.env, SUPABASE_API_URL: proxied.url } }, params())).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
    } finally {
      await proxied.close();
    }
  });

  it("pending names diff as a pending create and read nothing", async () => {
    const pending = { name: pendingMarker("x.y") };
    expect(await branchOp.read(h.actx("supabase", provider), pending)).toBeNull();
    expect(branchOp.diff(null, pending)[0]).toMatchObject({ key: "branch:(pending)", kind: "create" });
  });

  it("names what is missing: the token, the project, a param", async () => {
    await expect(branchOp.read({ ...h.actx("supabase", provider), env: {} }, params())).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    await expect(branchOp.read(h.actx("supabase", {}), params())).rejects.toMatchObject({ code: "PLAN_INVALID" });
    await expect(branchOp.read(h.actx("supabase", provider), {})).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });
});

describe("supabase auth_redirect", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ supabase: { projects: { [P]: { uri_allow_list: "http://localhost:3000/**, https://app.example.com/cb" } } } });
  });
  afterEach(() => h.close());

  const URL1 = "https://pr-42.preview.example.com/auth/callback";
  const RKEY = `redirect:${URL1}`;
  const list = () => h.sim.state.supabase.projects[P]!.auth.uri_allow_list;

  it("adds one entry, leaves the others as written, re-applies without writes, removes only its own", async () => {
    const actx = h.actx("supabase", provider);
    expect(await redirectOp.read(actx, { url: URL1 })).toBeNull();
    expect(redirectOp.diff(null, { url: URL1 })).toEqual([{ key: RKEY, kind: "create", label: "Supabase Auth redirect", before: { state: "absent" }, after: { state: "literal", value: URL1 } }]);

    const r = await redirectOp.apply(actx, { url: URL1 }, null);
    expect(r.created).toEqual([RKEY]);
    expect(h.intents).toEqual([{ keys: [RKEY], writesBefore: 0 }]);
    expect(list()).toBe(`http://localhost:3000/**, https://app.example.com/cb,${URL1}`);
    // The write is the whole field, alone, as a PATCH.
    const w = (await h.writes()).find((x) => x.method === "PATCH")!;
    expect(w.path).toBe(`/supabase/projects/${P}/config/auth`);

    const live = await redirectOp.read(actx, { url: URL1 });
    expect(live).toEqual({ resources: r.resources, outputs: { url: URL1 } });
    expect(redirectOp.diff(live, { url: URL1 })[0]!.kind).toBe("unchanged");
    const writes = (await h.writes()).length;
    expect((await redirectOp.apply(actx, { url: URL1 }, live)).created).toEqual([]);
    expect((await h.writes()).length).toBe(writes);

    await redirectOp.destroy(actx, r.resources);
    expect(list()).toBe("http://localhost:3000/**,https://app.example.com/cb");
    const after = (await h.writes()).length;
    await redirectOp.destroy(actx, r.resources); // already gone is success, and writes nothing
    expect((await h.writes()).length).toBe(after);
    await redirectOp.destroy(actx, []);
  });

  it("an empty (null) allow-list gets just the URL", async () => {
    await h.close();
    h = await harness({ supabase: { projects: { [P]: { uri_allow_list: null } } } });
    await redirectOp.apply(h.actx("supabase", provider), { url: URL1 }, null);
    expect(list()).toBe(URL1);
  });

  it("a URL already listed is claimed, not written", async () => {
    await h.close();
    h = await harness({ supabase: { projects: { [P]: { uri_allow_list: URL1 } } } });
    const r = await redirectOp.apply(h.actx("supabase", provider), { url: URL1 }, null);
    expect(r.created).toEqual([]);
    expect(await h.writes()).toHaveLength(0);
  });

  it("a write lost to a concurrent writer is noticed by the re-read and repeated", async () => {
    const actx = h.actx("supabase", provider);
    // Another writer overwrites the list right after our first PATCH lands.
    let patched = 0;
    const proxy = await recordingProxy(`${h.sim.url}/supabase`, (req, body) => {
      if (req.method === "PATCH") {
        patched++;
        if (patched === 1) h.sim.state.supabase.projects[P]!.auth.uri_allow_list = "http://localhost:3000/**";
      }
      return body;
    });
    try {
      const r = await redirectOp.apply({ ...actx, env: { ...actx.env, SUPABASE_API_URL: proxy.url } }, { url: URL1 }, null);
      expect(r.created).toEqual([RKEY]);
      expect(patched).toBe(2);
      expect(list()).toBe(`http://localhost:3000/**,${URL1}`);
    } finally {
      await proxy.close();
    }
  });

  it("gives up with PROVIDER_CONFLICT when every write is overwritten", async () => {
    const actx = h.actx("supabase", provider);
    const proxy = await recordingProxy(`${h.sim.url}/supabase`, (req, body) => {
      if (req.method === "PATCH") h.sim.state.supabase.projects[P]!.auth.uri_allow_list = "";
      return body;
    });
    try {
      await expect(redirectOp.apply({ ...actx, env: { ...actx.env, SUPABASE_API_URL: proxy.url } }, { url: URL1 }, null)).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
      h.sim.state.supabase.projects[P]!.auth.uri_allow_list = URL1;
      const proxy2 = await recordingProxy(`${h.sim.url}/supabase`, (req, body) => {
        if (req.method === "PATCH") h.sim.state.supabase.projects[P]!.auth.uri_allow_list = URL1;
        return body;
      });
      try {
        await expect(redirectOp.destroy({ ...actx, env: { ...actx.env, SUPABASE_API_URL: proxy2.url } }, [{ key: RKEY, id: `${P}:${URL1}`, hash: "x" }])).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
      } finally {
        await proxy2.close();
      }
    } finally {
      await proxy.close();
    }
  });

  it("a PATCH that answers 502 is retried: replacing the whole field is idempotent", async () => {
    await h.chaos({ fail_on: `PATCH /supabase/projects/${P}/config/auth`, fail_next: 1, status: 502 });
    const r = await redirectOp.apply(h.actx("supabase", provider), { url: URL1 }, null);
    expect(r.created).toEqual([RKEY]);
    expect(h.sim.state.chaos.fail_next).toBe(0);
  });

  it("refuses a URL the comma-separated list cannot hold", async () => {
    const actx = h.actx("supabase", provider);
    await expect(redirectOp.read(actx, { url: "https://a.example.com,https://b.example.com" })).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(redirectOp.read(actx, { url: " https://a.example.com" })).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("a malformed auth config is PROVIDER_RESPONSE", async () => {
    const proxy = await recordingProxy(`${h.sim.url}/supabase`, () => ({ uri_allow_list: 42 }));
    try {
      const actx = h.actx("supabase", provider);
      await expect(redirectOp.read({ ...actx, env: { ...actx.env, SUPABASE_API_URL: proxy.url } }, { url: URL1 })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE" });
    } finally {
      await proxy.close();
    }
  });

  it("pending URLs diff as a pending create and read nothing", async () => {
    const pending = { url: pendingMarker("env.preview_url") };
    expect(await redirectOp.read(h.actx("supabase", provider), pending)).toBeNull();
    expect(redirectOp.diff(null, pending)[0]).toMatchObject({ key: "redirect:(pending)", kind: "create" });
  });

  it("listScope reports every entry; adopt makes a line per URL", async () => {
    const found = await redirectOp.listScope!(h.actx("supabase", provider), { url: URL1 });
    expect(found.map((r) => r.key)).toEqual(["redirect:http://localhost:3000/**", "redirect:https://app.example.com/cb"]);
    expect(redirectOp.adopt!(found, ctx)).toEqual([
      { id: "auth_redirect", params: { url: "http://localhost:3000/**" }, keys: ["redirect:http://localhost:3000/**"] },
      { id: "auth_redirect", params: { url: "https://app.example.com/cb" }, keys: ["redirect:https://app.example.com/cb"] },
    ]);
  });

  it("`project` targets another project's allow-list (a branch's own), keyed by it; a pending project reads nothing", async () => {
    const actx = h.actx("supabase", provider);
    const b = await branchOp.apply(actx, { name: "feature-a" }, null);
    const ref = String(b.outputs.project_ref);
    const params = { url: URL1, project: ref };
    const key = `redirect:${ref}:${URL1}`;
    expect(redirectOp.diff(null, params)[0]).toMatchObject({ key, kind: "create" });
    expect(redirectOp.diff(null, { url: URL1, project: pendingMarker("db.project_ref") })[0]).toMatchObject({ key: "redirect:(pending)" });
    expect(await redirectOp.read(actx, { url: URL1, project: pendingMarker("db.project_ref") })).toBeNull();

    const r = await redirectOp.apply(actx, params, null);
    expect(r.created).toEqual([key]);
    expect(r.resources[0]!.id).toBe(`${ref}:${URL1}`);
    expect(await redirectOp.read(actx, params)).toEqual({ resources: r.resources, outputs: { url: URL1 } });
    // The parent's list is untouched.
    expect(list()).toBe("http://localhost:3000/**, https://app.example.com/cb");
    expect(await redirectOp.read(actx, { url: URL1 })).toBeNull();

    // The branch (and with it its allow-list) is deleted first: removing the entry is already done.
    await branchOp.destroy(actx, b.resources);
    await redirectOp.destroy(actx, r.resources);
  });

  it("locks the allow-list it edits (ADR 0019): the project's, or the line's own project; never before it is known", () => {
    const lockOn = redirectOp.lockOn!;
    expect(lockOn({ url: URL1 }, provider)).toBe(`supabase:${P}:auth-uri-allow-list`);
    expect(lockOn({ url: URL1, project: "" }, provider)).toBe(`supabase:${P}:auth-uri-allow-list`);
    expect(lockOn({ url: URL1, project: "branchrefabc" }, provider)).toBe("supabase:branchrefabc:auth-uri-allow-list");
    expect(lockOn({ url: URL1, project: pendingMarker("db.project_ref") }, provider)).toBeNull();
    expect(lockOn({ url: URL1 }, {})).toBeNull();
    expect(branchOp.lockOn).toBeUndefined();
  });
});

/**
 * A proxy in front of the sim whose GET /branches/:ref answers with `status` (and, with `noCredentials`, no
 * db_user/db_pass), for states the sim does not produce by itself.
 */
async function fetchDetailStatus(h: Harness, ref: string, status: string, noCredentials = false) {
  return recordingProxy(`${h.sim.url}/supabase`, (req, body) => {
    if (req.method !== "GET" || req.path !== `/branches/${ref}`) return body;
    const d: Record<string, unknown> = { ...(body as Record<string, unknown>), status };
    if (noCredentials) {
      delete d.db_user;
      delete d.db_pass;
    }
    return d;
  });
}
