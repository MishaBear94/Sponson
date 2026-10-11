/** The simulated Cloud Run's refusals, operations and drift keys, called directly (the adapter's tests cover the happy paths). */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAOS } from "../chaos.js";
import type { SimCore } from "../provider.js";
import { cloudRunSim, type CloudRunSeed, type CloudRunState } from "./cloud_run.js";

const SERVICE = "/v2/projects/demo-project/locations/us-central1/services/web";
const PINNED = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "web-00001-abc", percent: 100 };

function setup(seed: CloudRunSeed = { services: [{ name: "web" }] }): { core: SimCore; state: CloudRunState } {
  let n = 0;
  const core: SimCore = { chaos: { ...DEFAULT_CHAOS }, nextId: (p) => `${p}${++n}` };
  return { core, state: cloudRunSim.reset(core, seed) };
}

function call(s: { core: SimCore; state: CloudRunState }, method: string, path: string, body?: unknown) {
  const url = new URL(`http://sim.local${path}`);
  return cloudRunSim.routes(s.core, s.state, { method, path: url.pathname, url, body });
}

const body = (r: { body: unknown }) => r.body as Record<string, unknown>;

describe("cloud_run sim", () => {
  it("answers the service, its revisions and operations; 404 for what does not exist", () => {
    const s = setup();
    const svc = body(call(s, "GET", SERVICE));
    expect(svc).toMatchObject({ name: "projects/demo-project/locations/us-central1/services/web", generation: "1", latestReadyRevision: `${String(svc.name)}/revisions/web-00001-abc`, reconciling: false });
    expect(body(call(s, "GET", `${SERVICE}/revisions/web-00001-abc`))).toMatchObject({ conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }] });
    for (const path of [`${SERVICE}x`, `${SERVICE}/revisions/nope`, "/v2/projects/demo-project/locations/us-central1/operations/nope", "/nope"]) expect(call(s, "GET", path).status).toBe(404);
    expect(call(s, "PATCH", `${SERVICE}x?updateMask=traffic`, { traffic: [] }).status).toBe(404);
  });

  it("refuses a patch without a known mask, with a stale etag, a bad template or bad traffic, and changes nothing", () => {
    const s = setup();
    const etag = String(body(call(s, "GET", SERVICE)).etag);
    const template = (revision?: string, image: unknown = "img") => ({ ...(revision ? { revision } : {}), containers: [{ image }] });
    const refusals: Array<[string, unknown, number]> = [
      ["", { traffic: [] }, 400],
      ["?updateMask=labels", {}, 400],
      ["?updateMask=traffic", { traffic: [], etag: '"stale"' }, 409],
      ["?updateMask=template", { template: { containers: [] } }, 400],
      ["?updateMask=template", { template: template(undefined, 1) }, 400],
      ["?updateMask=template", { template: template("other-1") }, 400],
      ["?updateMask=template", { template: template("web-ends-") }, 400],
      ["?updateMask=template", { template: template(`web-${"x".repeat(60)}`) }, 400],
      ["?updateMask=template", { template: template("web-00001-abc") }, 409],
      ["?updateMask=traffic", { traffic: "all" }, 400],
      ["?updateMask=traffic", { traffic: [{ type: "SPLIT", percent: 100 }] }, 400],
      ["?updateMask=traffic", { traffic: [{ ...PINNED, revision: "web-nope" }] }, 400],
      ["?updateMask=traffic", { traffic: [{ ...PINNED, percent: 101 }] }, 400],
      ["?updateMask=traffic", { traffic: [{ ...PINNED, percent: 50 }] }, 400],
      ["?updateMask=traffic", { traffic: [{ ...PINNED, tag: "Bad_Tag" }] }, 400],
      ["?updateMask=traffic", { traffic: [{ ...PINNED, tag: "a" }, { ...PINNED, percent: 0, tag: "a" }] }, 400],
    ];
    for (const [mask, b, status] of refusals) expect([mask, call(s, "PATCH", `${SERVICE}${mask}`, b).status]).toEqual([mask, status]);
    expect(body(call(s, "GET", SERVICE)).etag).toBe(etag);
    expect(s.state.revisions).toHaveLength(1);
  });

  it("a template change makes a revision once its operation ends; LATEST then follows it, a failing image never comes up", () => {
    const s = setup({ services: [{ name: "web" }], failImages: ["bad"] });
    const op = body(call(s, "PATCH", `${SERVICE}?updateMask=template`, { template: { containers: [{ image: "good" }] } }));
    expect(op).toMatchObject({ done: false });
    expect(body(call(s, "GET", SERVICE))).toMatchObject({ reconciling: true });
    const done = body(call(s, "GET", `/v2/${String(op.name)}`));
    expect(done).toMatchObject({ done: true, response: { reconciling: false } });
    expect(body(call(s, "GET", SERVICE)).trafficStatuses).toEqual([{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", revision: s.state.services[0]!.latestCreated, percent: 100 }]);
    // An unchanged template makes no revision.
    call(s, "PATCH", `${SERVICE}?updateMask=template`, { template: s.state.services[0]!.template });
    expect(s.state.revisions).toHaveLength(2);

    const failing = body(call(s, "PATCH", `${SERVICE}?updateMask=template`, { template: { containers: [{ image: "bad" }] } }));
    call(s, "GET", `/v2/${String(failing.name)}`);
    expect(body(call(s, "GET", `/v2/${String(failing.name)}`))).toMatchObject({ done: true, error: { code: 9 } });
    expect(s.state.services[0]!.latestReady).not.toBe(s.state.services[0]!.latestCreated);
  });

  it("drift keys: a deploy, a removed tag, a redeploy under a tag; unknown ones are refused", () => {
    const s = setup({ services: [{ name: "web", traffic: "pinned" }] });
    const svc = s.state.services[0]!;
    cloudRunSim.drift(s.core, s.state, { key: "cloud_run.service.web.deploy", rest: "service.web.deploy", value: "img:2" });
    expect(svc.traffic).toEqual([PINNED]);
    expect(s.state.revisions).toHaveLength(2);
    svc.traffic.push({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", tag: "t" }, { ...PINNED, percent: 0, tag: "u" });
    cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.tag.t.env.A", value: "1" });
    expect(svc.traffic[1]).toMatchObject({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: svc.latestReady, tag: "t" });
    cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.tag.u", value: "delete" });
    svc.traffic[0]!.tag = "p";
    cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.tag.p", value: "delete" });
    expect(svc.traffic).toEqual([PINNED, expect.objectContaining({ tag: "t" })]);
    expect(cloudRunSim.drift(s.core, s.state, { key: "k", rest: "app.web", value: "x" })).toBe(false);
    expect(cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.deploy", value: "x", only: "p" })).toBe(false);
    expect(() => cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.nope.deploy", value: "x" })).toThrow(/no service/);
    expect(() => cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.tag.zz", value: "delete" })).toThrow(/no tag/);
    expect(() => cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.tag.zz.env.A", value: "1" })).toThrow(/no tagged revision/);
    expect(() => cloudRunSim.drift(s.core, s.state, { key: "k", rest: "service.web.other", value: "1" })).toThrow(/use service/);
  });
});
