/** The simulated Cloudflare Pages API: what it refuses, and the drift keys a scenario can use. */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAOS } from "../chaos.js";
import type { SimCore } from "../provider.js";
import { cloudflareSim, type CloudflareState } from "./cloudflare.js";

const core: SimCore = { chaos: { ...DEFAULT_CHAOS }, nextId: (p) => `${p}1` };
const PATH = "/accounts/acc/pages/projects/web";

function fresh(): CloudflareState {
  return cloudflareSim.reset(core, { accounts: { acc: { web: { preview: { A: "1", S: { type: "secret_text", value: "s" } }, production: { P: "p" } } } } });
}

function call(state: CloudflareState, method: string, path: string, body?: unknown) {
  return cloudflareSim.routes(core, state, { method, path, url: new URL(`http://sim.local${path}`), body });
}

describe("cloudflare sim", () => {
  it("answers the Cloudflare envelope; secrets come back without their value; unknown paths and projects are 404", () => {
    const state = fresh();
    const r = call(state, "GET", PATH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, result: { name: "web", subdomain: "web.pages.dev", deployment_configs: { preview: { env_vars: { A: { type: "plain_text", value: "1" }, S: { type: "secret_text", value: "" } } } } } });
    expect(call(state, "GET", "/accounts/acc/pages/projects/nope")).toMatchObject({ status: 404, body: { success: false, errors: [{ code: 8000007 }] } });
    expect(call(state, "PATCH", "/accounts/other/pages/projects/web", {}).status).toBe(404);
    expect(call(state, "GET", "/zones").status).toBe(404);
  });

  it("refuses malformed PATCH bodies and leaves the project unchanged", () => {
    const state = fresh();
    for (const body of [null, [], { deployment_configs: 1 }, { deployment_configs: { staging: {} } }, { deployment_configs: { preview: { env_vars: [] } } }, { deployment_configs: { preview: { env_vars: { "": null } } } }, { deployment_configs: { preview: { env_vars: { A: { type: "json", value: "x" } } } } }]) {
      expect(call(state, "PATCH", PATH, body).status, JSON.stringify(body)).toBe(400);
    }
    expect(call(state, "PATCH", PATH, { name: "web" }).status).toBe(200);
    expect(call(state, "PATCH", PATH, { deployment_configs: { preview: { env_vars: null }, production: {} } }).status).toBe(200);
    expect(state.accounts.acc!.projects.web!.deployment_configs.preview.env_vars.A).toEqual({ type: "plain_text", value: "1" });
  });

  it("drift: delete, set with a type, edit keeping the type, limited to one project; unknown keys and projects", () => {
    const state = fresh();
    const drift = (key: string, value: string) => cloudflareSim.drift(core, state, { key, rest: key.replace(/^cloudflare(:[^.]+)?\./, ""), value, ...(key.startsWith("cloudflare:") ? { only: key.slice(11, key.indexOf(".")) } : {}) });
    const vars = () => state.accounts.acc!.projects.web!.deployment_configs;
    expect(drift("cloudflare.pages_env.preview.A", "delete")).toBe(true);
    expect(drift("cloudflare.pages_env.preview.S", "edited")).toBe(true);
    expect(drift("cloudflare:web.pages_env.production.P", "secret:hidden")).toBe(true);
    expect(drift("cloudflare.pages_env.preview.N", "plain:new")).toBe(true);
    expect(drift("cloudflare.pages_env.preview.M", "made")).toBe(true);
    expect(vars().preview.env_vars).toEqual({ S: { type: "secret_text", value: "edited" }, N: { type: "plain_text", value: "new" }, M: { type: "plain_text", value: "made" } });
    expect(vars().production.env_vars.P).toEqual({ type: "secret_text", value: "hidden" });
    expect(drift("cloudflare.item.x", "1")).toBe(false);
    expect(() => drift("cloudflare:nope.pages_env.preview.A", "1")).toThrow(/no Pages project named nope/);
    expect(cloudflareSim.reset(core, undefined)).toEqual({ accounts: {} });
  });
});
