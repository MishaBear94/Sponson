/** The simulated Netlify's refusals and drift keys, called directly (the adapter's tests cover the happy paths). */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAOS } from "../chaos.js";
import type { SimCore } from "../provider.js";
import { netlifySim, type NetlifyState } from "./netlify.js";

function setup(chaos: Partial<typeof DEFAULT_CHAOS> = {}): { core: SimCore; state: NetlifyState } {
  let n = 0;
  const core: SimCore = { chaos: { ...DEFAULT_CHAOS, ...chaos }, nextId: (p) => `${p}${++n}` };
  const state = netlifySim.reset(core, {
    sites: {
      s1: {
        name: "one",
        account: "acme",
        envs: [{ key: "A", values: [{ context: "branch", context_parameter: "feat/x", value: "a" }, { context: "production", value: "p" }] }],
        pushes: [{ sha: "c1", branch: "main" }, { sha: "c2", branch: "feat/x" }],
      },
    },
  });
  return { core, state };
}

function call(s: { core: SimCore; state: NetlifyState }, method: string, path: string, body?: unknown) {
  const url = new URL(`http://sim.local${path}`);
  return netlifySim.routes(s.core, s.state, { method, path: url.pathname, url, body });
}

describe("netlify sim", () => {
  it("scopes variables to a site of the account in the path, by id or slug", () => {
    const s = setup();
    expect(call(s, "GET", "/accounts/acme/env?site_id=s1").status).toBe(200);
    expect(call(s, "GET", "/accounts/acct_acme/env?site_id=s1").status).toBe(200);
    expect(call(s, "GET", "/accounts/other/env?site_id=s1").status).toBe(404);
    expect(call(s, "GET", "/accounts/acme/env").status).toBe(404);
    expect(call(s, "GET", "/sites/nope").status).toBe(404);
    expect(call(s, "GET", "/nope").status).toBe(404);
  });

  it("refuses bad creates and writes nothing", () => {
    const s = setup();
    const post = (body: unknown) => call(s, "POST", "/accounts/acme/env?site_id=s1", body);
    expect(post({ key: "B" }).status).toBe(400);
    expect(post([{ key: "B" }]).status).toBe(400);
    expect(post([{ key: "A", values: [] }]).status).toBe(400);
    expect(post([{ key: "B", values: [{ context: "nope", value: "x" }] }]).status).toBe(400);
    expect(post([{ key: "B", values: [{ context: "branch", value: "x" }] }]).status).toBe(400);
    expect(post([{ key: "B", values: [{ context: "all", value: "x" }, { context: "dev", value: "y" }] }]).status).toBe(400);
    expect(post([{ key: "B", values: [{ context: "dev", value: "x" }, { context: "dev", value: "y" }] }]).status).toBe(400);
    expect(post([{ key: "B", values: [] }, { key: "B", values: [] }]).status).toBe(400);
    expect(post([null]).status).toBe(400);
    expect(s.state.sites.s1!.envs.map((e) => e.key)).toEqual(["A"]);
  });

  it("refuses a PATCH that is not a value, or that would put `all` next to context values", () => {
    const s = setup();
    expect(call(s, "PATCH", "/accounts/acme/env/A?site_id=s1", "x").status).toBe(400);
    expect(call(s, "PATCH", "/accounts/acme/env/A?site_id=s1", { context: "all", value: "x" }).status).toBe(400);
    expect(call(s, "PATCH", "/accounts/acme/env/Z?site_id=s1", { context: "dev", value: "x" }).status).toBe(404);
    expect(call(s, "DELETE", "/accounts/acme/env/Z?site_id=s1").status).toBe(404);
    expect(call(s, "DELETE", "/accounts/acme/env/A/value/nope?site_id=s1").status).toBe(404);
    expect(call(s, "GET", "/accounts/acme/env/Z?site_id=s1").status).toBe(404);
    expect(call(s, "DELETE", "/accounts/acme/env/A?site_id=s1").status).toBe(204);
  });

  it("drift: a new value, delete, recreate; a key matching nothing is an error", () => {
    const s = setup();
    const a = () => s.state.sites.s1!.envs[0]!.values;
    expect(netlifySim.drift(s.core, s.state, { key: "k", rest: "env.branch@feat/x.A", value: "edited" })).toBe(true);
    expect(a()[0]!.value).toBe("edited");
    const id = a()[1]!.id;
    netlifySim.drift(s.core, s.state, { key: "k", rest: "env.production.A", value: "recreate" });
    expect(a().find((v) => v.context === "production")!.id).not.toBe(id);
    netlifySim.drift(s.core, s.state, { key: "k", rest: "env.production.A", value: "delete", only: "s1" });
    expect(a().map((v) => v.context)).toEqual(["branch"]);
    expect(() => netlifySim.drift(s.core, s.state, { key: "k", rest: "env.dev.A", value: "x" })).toThrow(/no value/);
    expect(() => netlifySim.drift(s.core, s.state, { key: "k", rest: "env.A", value: "x" })).toThrow(/bad drift key/);
    expect(netlifySim.drift(s.core, s.state, { key: "k", rest: "item.A", value: "x" })).toBe(false);
  });

  it("builds pushes once each (main as production), pages the list, and a build needs a known branch", () => {
    const s = setup({ deploy_ms: 50 });
    const list = call(s, "GET", "/sites/s1/deploys?per_page=1&page=2").body as Array<{ context: string; state: string }>;
    expect(list).toHaveLength(1);
    const all = call(s, "GET", "/sites/s1/deploys").body as Array<{ context: string; state: string }>;
    expect(all.map((d) => d.context).sort()).toEqual(["branch-deploy", "production"]);
    expect(all.every((d) => d.state === "building")).toBe(true);
    expect(call(s, "POST", "/sites/s1/builds?branch=unknown").status).toBe(422);
    expect(call(s, "POST", "/sites/nope/builds").status).toBe(404);
    expect(call(s, "GET", "/sites/nope/deploys").status).toBe(404);
    expect(call(s, "POST", "/sites/s1/builds").status).toBe(200);
  });

  it("chaos deploy never builds nothing; fail builds a deploy that errors", () => {
    const never = setup({ deploy: "never" });
    expect(call(never, "GET", "/sites/s1/deploys").body).toEqual([]);
    const fail = setup({ deploy: "fail" });
    expect((call(fail, "GET", "/sites/s1/deploys").body as Array<{ state: string }>).map((d) => d.state)).toEqual(["error", "error"]);
  });

  it("an empty seed has no sites; a secret's values are not shown except in dev", () => {
    expect(netlifySim.reset({ chaos: { ...DEFAULT_CHAOS }, nextId: (p) => p }, undefined)).toEqual({ sites: {} });
    const s = setup();
    s.state.sites.s1!.envs[0]!.is_secret = true;
    s.state.sites.s1!.envs[0]!.values.push({ id: "d", context: "dev", value: "visible" });
    const [v] = call(s, "GET", "/accounts/acme/env?site_id=s1").body as Array<{ values: Array<{ context: string; value?: string }> }>;
    expect(v!.values.map((x) => x.value)).toEqual([undefined, undefined, "visible"]);
  });
});
