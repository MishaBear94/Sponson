/** Unit tests for the Cloudflare adapter (`pages_env`) against the in-process sim. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveParams, type AdapterContext, type Ctx, type ResolvedParams } from "@sponson/core";
import { cloudflareAdapter } from "./cloudflare.js";
import { harness, recordingProxy, writeIndex, type Harness } from "./testing.js";

const op = cloudflareAdapter.ops.pages_env!;
const provider = { account: "acc_demo", project: "demo" };
const PROJECT_PATH = /^\/cloudflare\/accounts\/acc_demo\/pages\/projects\/demo$/;

function params(p: ResolvedParams, ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: 42 }, scope: "pr-42" }): ResolvedParams {
  return op.defaults!(p, ctx);
}

describe("cloudflare pages_env", () => {
  let h: Harness;
  let actx: AdapterContext;
  const vars = (env: "preview" | "production" = "preview") => h.sim.state.cloudflare.accounts.acc_demo!.projects.demo!.deployment_configs[env].env_vars;

  beforeEach(async () => {
    h = await harness({ cloudflare: { accounts: { acc_demo: { demo: { preview: { HUMAN: "keep me", HUMAN_SECRET: { type: "secret_text", value: "s3" } } } } } } });
    actx = h.actx("cloudflare", provider);
  });
  afterEach(() => h.close());

  it("create, apply again without writes, update, destroy only what it wrote", async () => {
    const p = params({ vars: { API_URL: "https://api.example.com" }, secrets: { TOKEN: "t1" } });
    expect(p.target).toBe("preview");
    expect(await op.read(actx, p)).toBeNull();
    expect(op.diff(null, p)).toEqual([
      { key: "env:preview:API_URL", kind: "create", label: "API_URL (Pages preview)", before: { state: "absent" }, after: { state: "literal", value: "https://api.example.com" } },
      { key: "env:preview:TOKEN", kind: "create", label: "TOKEN (Pages preview, secret)", before: { state: "absent" }, after: { state: "sensitive" } },
    ]);

    const r = await op.apply(actx, p, null);
    expect(r.created).toEqual(["env:preview:API_URL", "env:preview:TOKEN"]);
    // The intent was recorded before the write was sent; one PATCH carries both.
    expect(h.intents).toEqual([{ keys: r.created, writesBefore: 0 }]);
    expect(writeIndex(h, "PATCH", PROJECT_PATH)).toBe(0);
    expect(h.sim.state.writes).toHaveLength(1);
    expect(vars()).toEqual({
      HUMAN: { type: "plain_text", value: "keep me" },
      HUMAN_SECRET: { type: "secret_text", value: "s3" },
      API_URL: { type: "plain_text", value: "https://api.example.com" },
      TOKEN: { type: "secret_text", value: "t1" },
    });

    const live = await op.read(actx, p);
    expect(live?.resources.map((x) => x.hash)).toEqual(r.resources.map((x) => x.hash));
    expect(op.diff(live, p).map((d) => d.kind)).toEqual(["unchanged", "unchanged"]);
    const writes = h.sim.state.writes.length;
    expect((await op.apply(actx, p, live)).created).toEqual([]);
    expect(h.sim.state.writes.length).toBe(writes);

    const changed = params({ vars: { API_URL: "https://v2.example.com" }, secrets: { TOKEN: "t1" } });
    expect(op.diff(live, changed)[0]).toMatchObject({ kind: "update", before: { state: "sensitive" }, after: { state: "literal", value: "https://v2.example.com" } });
    const u = await op.apply(actx, changed, live);
    expect(u.created).toEqual([]);
    expect(vars().API_URL).toEqual({ type: "plain_text", value: "https://v2.example.com" });

    await op.destroy(actx, u.resources);
    expect(vars()).toEqual({ HUMAN: { type: "plain_text", value: "keep me" }, HUMAN_SECRET: { type: "secret_text", value: "s3" } });
    const after = h.sim.state.writes.length;
    await op.destroy(actx, u.resources); // already gone is success, and writes nothing
    expect(h.sim.state.writes.length).toBe(after);
  });

  it("the PATCH names only the managed keys; a key it deletes is sent as null", async () => {
    const sent: unknown[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (init?.method === "PATCH") sent.push(JSON.parse(String(init.body)));
      return real(input, init);
    });
    try {
      const r = await op.apply(actx, params({ vars: { A: "1" } }), null);
      await op.destroy(actx, r.resources);
    } finally {
      spy.mockRestore();
    }
    expect(sent).toEqual([
      { deployment_configs: { preview: { env_vars: { A: { type: "plain_text", value: "1" } } } } },
      { deployment_configs: { preview: { env_vars: { A: null } } } },
    ]);
  });

  it("a secret is compared by presence and type: a new value is not written unless rewrite_secrets is set", async () => {
    const p = params({ secrets: { TOKEN: "t1" } });
    const live0 = await op.read(actx, p);
    await op.apply(actx, p, live0);
    const live = await op.read(actx, p);
    const rotated = params({ secrets: { TOKEN: "t2" } });
    expect(op.diff(live, rotated)[0]!.kind).toBe("unchanged");
    const writes = h.sim.state.writes.length;
    await op.apply(actx, rotated, live);
    expect(h.sim.state.writes.length).toBe(writes);
    expect(vars().TOKEN!.value).toBe("t1");

    const rewrite = params({ secrets: { TOKEN: "t2" }, rewrite_secrets: true });
    expect(op.diff(live, rewrite)[0]).toMatchObject({ kind: "update", before: { state: "sensitive" }, after: { state: "sensitive" } });
    const r = await op.apply(actx, rewrite, live);
    expect(vars().TOKEN).toEqual({ type: "secret_text", value: "t2" });
    // Same hash as before: the ledger sees no drift from a rewrite.
    expect(r.resources[0]!.hash).toBe(live!.resources[0]!.hash);
  });

  it("the API never returns a secret's value, and a dashboard edit of one is invisible; a type change is not", async () => {
    const res = await fetch(`${h.sim.url}/cloudflare/accounts/acc_demo/pages/projects/demo`, { headers: { authorization: "Bearer x" } });
    const body = (await res.json()) as { result: { deployment_configs: { preview: { env_vars: Record<string, unknown> } } } };
    expect(body.result.deployment_configs.preview.env_vars.HUMAN_SECRET).toEqual({ type: "secret_text", value: "" });

    const p = params({ vars: { A: "1" }, secrets: { S: "x" } });
    await op.apply(actx, p, null);
    const recorded = (await op.read(actx, p))!.resources.map((r) => r.hash);
    await h.chaos({ drift: { "cloudflare.pages_env.preview.S": "edited" } });
    expect((await op.read(actx, p))!.resources.map((r) => r.hash)).toEqual(recorded);
    await h.chaos({ drift: { "cloudflare.pages_env.preview.S": "plain:visible", "cloudflare.pages_env.preview.A": "2" } });
    const drifted = await op.read(actx, p);
    expect(drifted!.resources.map((r) => r.hash)).not.toContain(recorded[0]);
    expect(drifted!.resources.map((r) => r.hash)).not.toContain(recorded[1]);
    expect(op.diff(drifted, p).map((d) => d.kind)).toEqual(["update", "update"]);
  });

  it("refuses to go on when a variable it did not send disappeared after the PATCH", async () => {
    let gets = 0;
    const proxy = await recordingProxy(h.sim.url, (req, body) => {
      if (req.method !== "GET" || ++gets < 2) return body;
      const b = body as { result: { deployment_configs: { preview: { env_vars: Record<string, unknown> } } } };
      delete b.result.deployment_configs.preview.env_vars.HUMAN;
      return b;
    });
    try {
      const viaProxy = h.actx("cloudflare", provider, { env: { ...h.env, CLOUDFLARE_API_URL: `${proxy.url}/cloudflare` } });
      await expect(op.apply(viaProxy, params({ vars: { A: "1" } }), null)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE", message: /no longer has HUMAN/, details: { lost: ["HUMAN"] } });
    } finally {
      await proxy.close();
    }
  });

  it("a PATCH that answers 502 once is retried (it sets state, so it is idempotent)", async () => {
    await h.chaos({ fail_on: "PATCH /cloudflare/accounts/acc_demo/pages/projects/demo", fail_next: 1, status: 502 });
    await op.apply(actx, params({ vars: { A: "1" } }), null);
    expect(vars().A).toEqual({ type: "plain_text", value: "1" });
    expect(h.sim.state.chaos.fail_next).toBe(0);
  });

  it("writes production only from a production run, and defaults the target from the run", async () => {
    const prodCtx = { env: "production", git: { branch: "main", sha: "abc", short_sha: "abc" }, pr: { number: null }, scope: "production" };
    const p = params({ vars: { A: "1" } }, prodCtx);
    expect(p.target).toBe("production");
    expect(op.writesEnvironment!(p, prodCtx)).toBe("production");
    await expect(op.read(actx, p)).rejects.toMatchObject({ code: "PARAM_INVALID", message: /--env production/ });
    await expect(op.apply(actx, p, null)).rejects.toMatchObject({ code: "PARAM_INVALID" });
    const prod = h.actx("cloudflare", provider, { ctx: prodCtx });
    await op.apply(prod, p, null);
    expect(vars("production").A).toEqual({ type: "plain_text", value: "1" });
    expect(vars().A).toBeUndefined();
    await expect(op.read(h.actx("cloudflare", provider, { ctx: { ...prodCtx, env: "staging" } }), params({ vars: { A: "1" } }, { ...prodCtx, env: "staging" }))).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("{ keep: true } is unchanged when the variable exists and leaves its value alone", async () => {
    const kept = params(resolveParams({ vars: { HUMAN: { keep: true } }, secrets: { HUMAN_SECRET: { keep: true } } }, new Map()).params);
    const live = await op.read(actx, kept);
    expect(op.diff(live, kept).map((d) => d.kind)).toEqual(["unchanged", "unchanged"]);
    await op.apply(actx, kept, live);
    expect(h.sim.state.writes).toHaveLength(0);
    expect(() => op.diff(null, kept)).toThrow(/keep/);
  });

  it("listScope reports every variable of the environment; adopt splits them into vars and secrets, values never copied", async () => {
    const listed = await op.listScope!(actx, params({}));
    expect(listed.map((r) => r.key).sort()).toEqual(["env:preview:HUMAN", "env:preview:HUMAN_SECRET"]);
    const ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: null }, scope: "branch-feat-x" };
    expect(op.adopt!(listed, ctx)).toEqual([
      { id: "pages-env-preview", params: { target: "preview", vars: { HUMAN: { keep: true } }, secrets: { HUMAN_SECRET: { keep: true } } }, keys: listed.map((r) => r.key) },
    ]);
  });

  it("locks the environment's env_vars map of the project (ADR 0019); no identity without the provider block", () => {
    expect(op.lockOn!(params({ vars: { A: "1" } }), provider)).toBe("cloudflare:acc_demo:pages:demo:preview:env");
    expect(op.lockOn!({ target: "production" }, provider)).toBe("cloudflare:acc_demo:pages:demo:production:env");
    expect(op.lockOn!({}, provider)).toBe("cloudflare:acc_demo:pages:demo:preview:env");
    expect(op.lockOn!({}, { project: "demo" })).toBeNull();
    expect(op.lockOn!({}, { account: "acc_demo", project: "" })).toBeNull();
  });

  it("names what is wrong: the token, the provider block, the params, an unknown project", async () => {
    const p = params({ vars: { A: "1" } });
    await expect(op.read({ ...actx, env: {} }, p)).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
    await expect(op.read(h.actx("cloudflare", { project: "demo" }), p)).rejects.toMatchObject({ code: "PLAN_INVALID", message: /account/ });
    await expect(op.read(h.actx("cloudflare", { account: "acc_demo" }), p)).rejects.toMatchObject({ code: "PLAN_INVALID", message: /project/ });
    await expect(op.read(actx, params({ vars: { A: "1" }, secrets: { A: "2" } }))).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(op.read(actx, params({ vars: ["A"] }))).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(op.read(actx, params({ target: "staging" }))).rejects.toMatchObject({ code: "PARAM_INVALID" });
    await expect(op.read(actx, params({ rewrite_secrets: "yes" }))).rejects.toMatchObject({ code: "PARAM_INVALID" });
    const missing = h.actx("cloudflare", { account: "acc_demo", project: "nope" });
    await expect(op.read(missing, p)).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await op.destroy(missing, [{ key: "env:preview:A", id: "A", hash: "" }]); // a project already gone is success
  });
});
