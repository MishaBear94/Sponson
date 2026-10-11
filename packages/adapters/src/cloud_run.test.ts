/** Unit tests for the Cloud Run adapter against the in-process sim (assumptions CR1… in packages/sim/src/routes/cloud_run.ts). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingMarker, type ResolvedParams } from "@sponson/core";
import { createCloudRunAdapter } from "./cloud_run.js";
import { harness, recordingProxy, writeIndex, type Harness } from "./testing.js";

const TOKEN = "ya29.cloud-run-unit-token-0042";
const calls: Array<{ file: string; args: string[] }> = [];
const adapter = createCloudRunAdapter({
  exec: async (file, args) => {
    calls.push({ file, args });
    return `${TOKEN}\n`;
  },
});
const op = adapter.ops.revision!;
const PROVIDER = { project: "demo-project", region: "us-central1" };
const FAST = { SPONSON_CLOUD_RUN_POLL_MS: "1" };
const KEY = "revision:web:pr-42";
const PRODUCTION = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "web-00001-abc", percent: 100 };

/** The seeded service sends its traffic to LATEST, so the lines here allow pinning it (`pin_latest`). */
const params = (env: Record<string, unknown> = { API_URL: "https://api-pr-42.example.com" }): ResolvedParams => ({ service: "web", tag: "pr-42", image: "us-docker.pkg.dev/demo-project/web/app:abc1234", env, pin_latest: true });

describe("cloud_run revision", () => {
  let h: Harness;
  beforeEach(async () => {
    calls.length = 0;
    h = await harness({ cloud_run: { services: [{ name: "web", env: { NODE_ENV: "production", DATABASE_URL: "postgres://prod" } }] } });
  });
  afterEach(() => h.close());

  const actx = (env: NodeJS.ProcessEnv = {}, provider: Record<string, unknown> = PROVIDER) => h.actx("cloud_run", provider, { env: { ...h.env, ...FAST, ...env } });
  const svc = () => h.sim.state.cloud_run.services[0]!;
  const revisionsOf = () => h.sim.state.cloud_run.revisions.map((r) => r.name);

  it("makes a tagged revision with no traffic: LATEST pinned to the serving revision, the tag URL read from trafficStatuses", async () => {
    expect(await op.read(actx(), params())).toBeNull();
    expect(op.diff(null, params())[0]).toMatchObject({ key: KEY, kind: "create", after: { state: "literal", value: expect.stringMatching(/^web-pr-42-[0-9a-f]{8}$/) } });

    const r = await op.apply(actx(), params(), null);
    expect(r.created).toEqual([KEY]);
    expect(h.intents).toEqual([{ keys: [KEY], writesBefore: 0 }]);
    const name = String(r.outputs.revision);
    expect(name).toMatch(/^web-pr-42-[0-9a-f]{8}$/);
    expect(r.outputs.url).toBe(`https://pr-42---web-${svc().identifier}.a.run.app`);
    expect(r.resources).toEqual([expect.objectContaining({ key: KEY, id: name })]);

    // Production keeps its traffic, now bound to the revision that served it (CR5); the new revision only has the tag.
    expect(svc().traffic).toEqual([PRODUCTION, { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: name, tag: "pr-42" }]);
    expect(svc().latestReady).toBe(name);
    // Two patches, each with an update mask: the template (and the pin), then the tag.
    expect(writeIndex(h, "PATCH", /^\/cloud_run\/v2\/projects\/demo-project\/locations\/us-central1\/services\/web$/)).toBe(0);
    expect(h.sim.state.writes.filter((w) => w.method === "PATCH")).toHaveLength(2);
    // The revision is the service's template with the image and the variables set; the others are inherited.
    const made = h.sim.state.cloud_run.revisions.find((x) => x.name === name)!;
    expect(made.template).toMatchObject({ revision: name, containers: [{ image: params().image, env: [{ name: "NODE_ENV", value: "production" }, { name: "DATABASE_URL", value: "postgres://prod" }, { name: "API_URL", value: "https://api-pr-42.example.com" }] }] });
    // The credential is the token gcloud printed.
    expect(calls[0]).toEqual({ file: "gcloud", args: ["auth", "print-access-token"] });

    const live = await op.read(actx(), params());
    expect(live).toEqual({ resources: r.resources, outputs: r.outputs });
    expect(op.diff(live, params())).toEqual([{ key: KEY, kind: "unchanged", label: "Cloud Run revision of web (tag pr-42)" }]);
    const writes = h.sim.state.writes.length;
    expect((await op.apply(actx(), params(), live)).created).toEqual([]);
    expect(h.sim.state.writes.length).toBe(writes);
  });

  it("traffic on LATEST (or empty) is refused before any write unless the line sets pin_latest; pinned traffic needs no opt-in", async () => {
    const { pin_latest: _pin, ...strict } = params();
    for (const traffic of [[{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }], []]) {
      svc().traffic = traffic;
      const refused = op.read(actx(), strict);
      await expect(refused).rejects.toMatchObject({ code: "PARAM_INVALID", details: { param: "pin_latest" } });
      await expect(refused).rejects.toThrow(/pin LATEST's share to web-00001-abc.*update-traffic web --to-latest.*`pin_latest: true`/);
      // Apply refuses too, even handed no live state, and sends nothing.
      await expect(op.apply(actx(), strict, null)).rejects.toMatchObject({ code: "PARAM_INVALID" });
      expect(h.sim.state.writes).toEqual([]);
      expect(svc().traffic).toEqual(traffic);
    }
    expect(() => op.diff(null, { ...strict, pin_latest: "yes" })).toThrow(/true or false/);
    // Already pinned to named revisions: no opt-in needed.
    svc().traffic = [PRODUCTION];
    const r = await op.apply(actx(), strict, await op.read(actx(), strict));
    expect(svc().traffic).toEqual([PRODUCTION, { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: r.outputs.revision, tag: "pr-42" }]);
    // A line with nothing to write is not refused when traffic is put back on LATEST later (destroy and re-apply still work).
    svc().traffic = [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }, { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: String(r.outputs.revision), tag: "pr-42" }];
    const live = await op.read(actx(), strict);
    expect(op.diff(live, strict)[0]!.kind).toBe("unchanged");
    await expect(op.read(actx(), { ...strict, env: { API_URL: "changed" } })).rejects.toMatchObject({ code: "PARAM_INVALID" });
  });

  it("a changed value is a new revision with the tag moved onto it; traffic stays where it was", async () => {
    await h.close();
    h = await harness({ cloud_run: { services: [{ name: "web", traffic: "pinned" }] } });
    const first = await op.apply(actx(), params(), null);
    const changed = params({ API_URL: "https://other.example.com" });
    const live = await op.read(actx(), changed);
    expect(op.diff(live, changed)[0]).toMatchObject({ kind: "update", before: { value: first.outputs.revision } });
    const second = await op.apply(actx(), changed, live);
    expect(second.created).toEqual([]);
    expect(second.outputs.revision).not.toBe(first.outputs.revision);
    expect(svc().traffic).toEqual([PRODUCTION, { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: second.outputs.revision, tag: "pr-42" }]);
    // Back to the first values: the first revision is found again and re-tagged, nothing made.
    const count = revisionsOf().length;
    const back = await op.apply(actx(), params(), await op.read(actx(), params()));
    expect(back.outputs.revision).toBe(first.outputs.revision);
    expect(revisionsOf()).toHaveLength(count);
  });

  it("drift: a console redeploy under the tag with another value changes the hash; reconciling re-tags the plan's revision", async () => {
    const r = await op.apply(actx(), params(), null);
    h.sim.state.applyDrift("cloud_run.service.web.tag.pr-42.env.API_URL", "https://edited.example.com");
    const drifted = await op.read(actx(), params());
    expect(drifted!.resources[0]!.hash).not.toBe(r.resources[0]!.hash);
    expect(drifted!.resources[0]!.id).not.toBe(r.outputs.revision);
    const fixed = await op.apply(actx(), params(), drifted);
    expect(fixed.outputs.revision).toBe(r.outputs.revision);
    expect((await op.read(actx(), params()))!.resources[0]!.hash).toBe(r.resources[0]!.hash);
    // A variable the line does not declare is not its business.
    h.sim.state.applyDrift("cloud_run.service.web.tag.pr-42.env.OTHER", "x");
    expect((await op.read(actx(), params()))!.resources[0]!.hash).toBe(r.resources[0]!.hash);
  });

  it("destroy removes only the tag; traffic shares and other tags stay, the revision is left; gone is fine", async () => {
    const r = await op.apply(actx(), params(), null);
    svc().traffic.push({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "web-00001-abc", tag: "other" });
    await op.destroy(actx(), r.resources);
    expect(svc().traffic).toEqual([PRODUCTION, { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "web-00001-abc", tag: "other" }]);
    expect(revisionsOf()).toContain(r.outputs.revision);
    const writes = h.sim.state.writes.length;
    await op.destroy(actx(), r.resources);
    await op.destroy(actx(), [{ key: KEY, id: "", hash: "" }]);
    expect(h.sim.state.writes.length).toBe(writes);
    // A tag with a traffic share keeps its share when the tag goes.
    svc().traffic = [{ ...PRODUCTION, tag: "pr-42" }];
    await op.destroy(actx(), r.resources);
    expect(svc().traffic).toEqual([PRODUCTION]);
    h.sim.state.cloud_run.services = [];
    await op.destroy(actx(), r.resources);
  });

  it("a revision that fails to start fails the line; a slow operation is WAIT_TIMEOUT", async () => {
    await h.close();
    h = await harness({ cloud_run: { services: [{ name: "web" }], failImages: [params().image as string] } });
    await expect(op.apply(actx(), params(), null)).rejects.toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringMatching(/failed to start/) });
    // Production still has all of its traffic.
    expect(svc().traffic).toEqual([PRODUCTION]);
    await h.close();
    h = await harness({ cloud_run: { services: [{ name: "web" }], operationPolls: 1000 } });
    await expect(op.apply(actx({ SPONSON_CLOUD_RUN_TIMEOUT_MS: "5" }), params(), null)).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
  });

  it("a patch refused because the service changed since it was read (etag) is read again and retried", async () => {
    let stale = true;
    const proxy = await recordingProxy(`${h.sim.url}/cloud_run`, (req, body) => {
      if (req.method !== "GET" || !req.path.endsWith("/services/web") || !stale) return body;
      stale = false;
      return { ...(body as object), etag: '"stale"' };
    });
    try {
      const r = await op.apply(actx({ CLOUD_RUN_API_URL: proxy.url }), params(), null);
      expect(r.outputs.revision).toMatch(/^web-pr-42-/);
      expect(h.sim.state.writes.filter((w) => w.method === "PATCH" && w.failed)).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it("checks its params and its provider block; production only when the block says so; locks the service", async () => {
    expect(() => op.diff(null, { ...params(), tag: "PR_42" })).toThrow(/lowercase/);
    expect(() => op.diff(null, { ...params(), tag: `t${"x".repeat(60)}` })).toThrow(/longer than 63/);
    expect(() => op.diff(null, params({ "BAD-NAME": "x" }))).toThrow(/not a variable name/);
    expect(() => op.diff(null, params({ A: "\u0000keep" }))).toThrow(/cannot be kept/);
    expect(() => op.diff(null, { tag: "pr-42", image: "x" })).toThrow(/`service` is required/);
    await expect(op.read(actx({}, {}), params())).rejects.toMatchObject({ code: "PLAN_INVALID" });
    await expect(op.read(actx(), { ...params(), service: "nope" })).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/does not exist/) });
    await expect(op.read(actx(), { ...params(), container: "sidecar" })).resolves.toBeNull();
    expect(op.defaults!({ service: "web" }, h.ctx)).toEqual({ service: "web", tag: "pr-42" });
    expect(op.writesEnvironment!(params(), h.ctx, PROVIDER)).toBeNull();
    expect(op.writesEnvironment!(params(), h.ctx, { ...PROVIDER, production: true })).toBe("production");
    expect(() => op.writesEnvironment!(params(), h.ctx, { production: "yes" })).toThrow(/true or false/);
    expect(op.lockOn!(params(), PROVIDER)).toBe("cloud_run:demo-project/us-central1:service:web");
    expect(op.lockOn!(params(), {})).toBeNull();
  });

  it("plan shows a value not known yet by its reference; a tag left on LATEST reads as changed", async () => {
    const pending = pendingMarker("db.connection_string");
    expect(op.diff(null, params({ DATABASE_URL: pending }))[0]).toMatchObject({ kind: "create", after: { state: "pending", ref: "db.connection_string" } });
    expect(await op.read(actx(), { ...params(), service: pending })).toBeNull();
    const r = await op.apply(actx(), params(), null);
    svc().traffic[1] = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", tag: "pr-42" };
    const live = await op.read(actx(), params());
    expect(live!.resources[0]!.hash).not.toBe(r.resources[0]!.hash);
    expect(op.diff(live, params())[0]!.kind).toBe("update");
  });

  it("a multi-container service: the container with ports, or the one named; several without ports need `container`", async () => {
    const containers = [
      { name: "sidecar", image: "proxy:1" },
      { name: "app", image: "app:1", ports: [{ containerPort: 8080 }], env: [{ name: "API_URL", value: "old" }] },
    ];
    svc().template = { containers };
    const r = await op.apply(actx(), params(), null);
    const made = h.sim.state.cloud_run.revisions.find((x) => x.name === r.outputs.revision)!;
    expect(made.template.containers).toEqual([containers[0], { ...containers[1], image: params().image, env: [{ name: "API_URL", value: "https://api-pr-42.example.com" }] }]);
    const named = await op.apply(actx(), { ...params(), tag: "pr-43", container: "sidecar" }, null);
    expect((h.sim.state.cloud_run.revisions.find((x) => x.name === named.outputs.revision)!.template.containers as Array<{ image: string }>)[0]!.image).toBe(params().image);
    svc().template = { containers: [{ name: "a", image: "a" }, { name: "b", image: "b" }] };
    await expect(op.apply(actx(), { ...params(), tag: "pr-44" }, null)).rejects.toThrow(/several containers/);
  });

  it("empty traffic is pinned like LATEST; a service with no ready revision is refused before any write", async () => {
    svc().traffic = [];
    await op.apply(actx(), params(), null);
    expect(svc().traffic[0]).toEqual(PRODUCTION);
    svc().traffic = [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }];
    const proxy = await recordingProxy(`${h.sim.url}/cloud_run`, (req, body) => (req.method === "GET" && req.path.endsWith("/services/web") ? { ...(body as object), latestReadyRevision: "" } : body));
    try {
      const writes = h.sim.state.writes.length;
      await expect(op.apply(actx({ CLOUD_RUN_API_URL: proxy.url }), params({ API_URL: "x" }), null)).rejects.toThrow(/no ready revision/);
      expect(h.sim.state.writes.length).toBe(writes);
    } finally {
      await proxy.close();
    }
  });

  it("a missing gcloud fails with PROVIDER_AUTH naming the adapter", async () => {
    const broken = createCloudRunAdapter({ exec: async () => Promise.reject(Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" })) }).ops.revision!;
    await expect(broken.read(actx(), params())).rejects.toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringMatching(/^cloud_run: `gcloud` is not installed/) });
  });
});
