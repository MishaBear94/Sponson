/** Unit tests for the `manual` adapter (ADR 0021): params, rendering, and the verify request against the sim. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingMarker, resolveParams } from "@sponson/core";
import { manualAdapter } from "./manual.js";
import { harness, type Harness } from "./testing.js";

const step = manualAdapter.ops.step!;
const ctx = { env: "preview", git: { branch: "feat/x", sha: "abc", short_sha: "abc" }, pr: { number: 42 }, scope: "pr-42" };
const API = { base_url: "https://api.example.test/v1", base_url_env: "REST_API_URL", auth: { bearer_env: "REST_API_TOKEN" } };
const BASE = { title: "Allow {url}", vars: { url: "https://pr-42.example.app" }, instructions: "Add {url}/cb to the client.", undo: "Remove {url}/cb." };

describe("manual.step: the step", () => {
  it("renders title, instructions and undo from vars; the key is the title, the hash covers what a person is asked to do", () => {
    const s = step.manual!(BASE, ctx)!;
    expect(s).toMatchObject({ key: "step:Allow https://pr-42.example.app", title: "Allow https://pr-42.example.app", instructions: "Add https://pr-42.example.app/cb to the client.", undo: "Remove https://pr-42.example.app/cb.", observable: false });
    expect(step.manual!({ ...BASE, undo: "Something else." }, ctx)!.hash).toBe(s.hash);
    expect(step.manual!({ ...BASE, instructions: "Add {url}/callback." }, ctx)!.hash).not.toBe(s.hash);
    expect(step.manual!({ title: "T", instructions: "I", vars: { n: 3 } }, ctx)).toMatchObject({ key: "step:T", observable: false });
    expect(step.manual!({ ...BASE, verify: { api: "app", path: "/apps/x" } }, ctx)!.observable).toBe(true);
  });

  it("is null while any value it shows is pending, so the line waits", () => {
    const pending = pendingMarker("web.preview_url");
    expect(step.manual!({ ...BASE, vars: { url: pending } }, ctx)).toBeNull();
    expect(step.manual!({ ...BASE, instructions: pending }, ctx)).toBeNull();
    expect(step.manual!({ title: "T", instructions: "I", undo: pending }, ctx)).toBeNull();
    expect(step.diff(null, { ...BASE, vars: { url: pending } })).toEqual([{ key: "step:(pending)", kind: "create", label: "manual step", before: { state: "absent" }, after: { state: "pending" } }]);
  });

  it("diff: create until read sees it, then unchanged", () => {
    const s = step.manual!(BASE, ctx)!;
    expect(step.diff(null, BASE)[0]).toMatchObject({ key: s.key, kind: "create", after: { state: "literal", value: s.title } });
    expect(step.diff({ resources: [{ key: s.key, id: "manual", hash: s.hash }], outputs: {} }, BASE)[0]).toMatchObject({ kind: "unchanged" });
  });

  it("refuses what a person cannot be shown: unknown params and placeholders, blank or non-text fields, multi-line titles, secrets, keep", () => {
    const bad = (p: Record<string, unknown>) => () => step.manual!(p, ctx);
    expect(bad({ ...BASE, extra: 1 })).toThrow(/`extra` is not a parameter of manual.step/);
    expect(bad({ instructions: "I" })).toThrow(/`title` is required/);
    expect(bad({ title: "T" })).toThrow(/`instructions` is required/);
    expect(bad({ title: " ", instructions: "I" })).toThrow(/must not be blank/);
    expect(bad({ title: "T", instructions: 3 })).toThrow(/must be text/);
    expect(bad({ title: "T {nope}", instructions: "I" })).toThrow(/uses `\{nope\}`, which is not declared in `vars`/);
    expect(bad({ title: "T", instructions: "I", vars: [] })).toThrow(/`vars` must be a map/);
    expect(bad({ title: "T {o}", instructions: "I", vars: { o: { a: 1 } } })).toThrow(/must be a single value/);
    expect(bad({ title: "one\ntwo", instructions: "I" })).toThrow(/one line/);
    expect(bad({ title: "T", instructions: "I", verify: "yes" })).toThrow(/`verify` must be a map/);
    expect(bad({ title: "T", instructions: "I", verify: { api: "a", path: "/x", method: "POST" } })).toThrow(/`verify.method` is not a verify key/);
    expect(bad({ title: "T", instructions: "I", verify: { path: "/x" } })).toThrow(/`verify.api` is required/);
    expect(bad({ title: "T", instructions: "I", verify: { api: "a", path: "x" } })).toThrow(/`verify.path` must be a path/);
    expect(bad({ title: "T", instructions: "I", verify: { api: "a", path: "/x", match: { status: 1 } } })).toThrow(/JSON pointers/);
    expect(bad({ title: "T", instructions: "I", verify: { api: "a", path: "/x", absent_status: [200] } })).toThrow(/400–599/);
    expect(bad({ title: "T", instructions: "I", verify: { api: "a", path: "/x/{id}" } })).toThrow(/`verify.path` uses `\{id\}`/);
    // Before resolution (`defaults`, at prepare): references are allowed where text goes, secrets and keep nowhere.
    expect(step.defaults!({ ...BASE, instructions: { from: "doc.text" }, vars: { url: { from: "web.preview_url" } } }, ctx)).toMatchObject({ title: "Allow {url}" });
    expect(() => step.defaults!({ ...BASE, vars: { url: { secret: "env://X" } } }, ctx)).toThrow(/`vars.url` is a secret reference/);
    expect(() => step.defaults!({ ...BASE, instructions: { keep: true } }, ctx)).toThrow(/`instructions` is `\{ keep: true \}`/);
  });

  it("is never applied or destroyed by the adapter: the engine records it", async () => {
    await expect(step.apply({} as never, BASE, null)).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(step.destroy({} as never, [])).resolves.toBeUndefined();
    expect(manualAdapter.about?.credentialEnv).toMatch(/none/);
  });

  it("providerFor: the verify request's API block under providers.manual, checked; nothing without verify", () => {
    const providerFor = step.providerFor!;
    expect(providerFor({ app: API }, BASE)).toEqual({});
    expect(providerFor({ app: API }, { ...BASE, verify: { api: "app", path: "/x" } })).toEqual(API);
    expect(providerFor({ dns: { base_url: "https://dns.google" } }, { ...BASE, verify: { api: "dns", path: "/resolve" } })).toEqual({ base_url: "https://dns.google" });
    expect(() => providerFor({}, { ...BASE, verify: { api: "app", path: "/x" } })).toThrow(expect.objectContaining({ code: "PLAN_INVALID", message: expect.stringMatching(/no API `app` is configured/) }));
    expect(() => providerFor({ app: { ...API, auth: { token: "x" } } }, { ...BASE, verify: { api: "app", path: "/x" } })).toThrow(/must be one of/);
  });
});

describe("manual.step: verify against the sim", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ rest: { objects: { "/apps/demo": { name: "demo", webhook_url: "https://old.example.app" } } } } as never);
  });
  afterEach(() => h.close());

  const params = (match: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ title: "Webhook of {app}", instructions: "Set it.", vars: { app: "demo" }, verify: { api: "app", path: "/apps/{app}", match, ...extra } });

  it("is done only when the GET answers and every match holds; 404 and absent_status mean not yet; reads never write", async () => {
    const actx = h.actx("manual", API);
    expect(await step.read(actx, params({ "/webhook_url": "https://pr-42.example.app" }))).toBeNull();
    const done = await step.read(actx, params({ "/webhook_url": "https://old.example.app", "/name": "demo" }));
    expect(done).toMatchObject({ resources: [{ key: "step:Webhook of demo", id: "manual", label: "manual step: Webhook of demo" }], outputs: {} });
    expect(await step.read(actx, params({}))).not.toBeNull();
    expect(await step.read(actx, { ...params({}), vars: { app: "nope" } })).toBeNull();
    expect(await step.read(actx, { ...params({}), vars: { app: pendingMarker("x.y") } })).toBeNull();
    expect(await step.read(actx, BASE)).toBeNull();
    await h.chaos({ fail_next: 1, status: 410, fail_on: "GET /rest/apps/*" });
    expect(await step.read(actx, params({}, { absent_status: [410] }))).toBeNull();
    await h.chaos({ fail_next: 1, status: 400, fail_on: "GET /rest/apps/*" });
    await expect(step.read(actx, params({}))).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/^manual: GET/) });
    expect(h.sim.state.writes).toHaveLength(0);
  });

  it("a block without `auth` sends no credential (a public endpoint)", async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Status: 0, Answer: [{ data: "cname.vercel-dns.com." }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const actx = h.actx("manual", { base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      const p = resolveParams({ title: "CNAME", instructions: "Add it.", verify: { api: "dns", path: "/resolve?name=pr-42.example.com&type=CNAME", match: { "/Answer/0/data": "cname.vercel-dns.com." } } }, new Map(), new Map()).params;
      expect(await step.read(actx, p)).not.toBeNull();
      expect(seen).toEqual([undefined]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
