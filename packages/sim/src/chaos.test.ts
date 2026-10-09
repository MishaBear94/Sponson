import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "./index.js";
import { matchesRule } from "./state.js";

const auth = { authorization: "Bearer t", "content-type": "application/json" };

describe("sim chaos", () => {
  let sim: SimHandle;
  beforeEach(async () => {
    sim = await startSim();
  });
  afterEach(() => sim.close());

  const chaos = (body: unknown) => fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify(body), headers: auth }).then((r) => r.json());
  const post = (path: string, body: unknown) => fetch(`${sim.url}${path}`, { method: "POST", body: JSON.stringify(body), headers: auth });
  const del = (path: string) => fetch(`${sim.url}${path}`, { method: "DELETE", headers: auth });
  const writes = () => fetch(`${sim.url}/_writes`).then((r) => r.json() as Promise<Array<{ method: string; path: string; failed?: true }>>);

  it("rejects requests without a bearer token", async () => {
    const r = await fetch(`${sim.url}/clerk/redirect_urls`);
    expect(r.status).toBe(401);
  });

  it("fail_next fails the next N writes with status and logs them as failed", async () => {
    expect(await chaos({ fail_next: 2, status: 500 })).toMatchObject({ fail_next: 2, status: 500, deploy: "ok" });
    expect((await post("/clerk/redirect_urls", { url: "https://a" })).status).toBe(500);
    expect((await post("/clerk/redirect_urls", { url: "https://a" })).status).toBe(500);
    expect((await post("/clerk/redirect_urls", { url: "https://a" })).status).toBe(200);
    const log = await writes();
    expect(log.map((w) => w.failed ?? false)).toEqual([true, true, false]);
    expect(log[0]).toMatchObject({ method: "POST", path: "/clerk/redirect_urls" });
    expect((await (await fetch(`${sim.url}/_writes?since=2`)).json()) as unknown[]).toHaveLength(1);
  });

  it("fail_on restricts failures to matching writes", async () => {
    await chaos({ fail_next: 1, fail_on: "DELETE /neon/*" });
    expect((await post("/clerk/redirect_urls", { url: "https://b" })).status).toBe(200);
    const main = sim.state.neon.projects.proj_demo!.branches[0]!;
    expect((await del(`/neon/projects/proj_demo/branches/${main.id}`)).status).toBe(503);
    expect(sim.state.neon.projects.proj_demo!.branches).toHaveLength(1);
    expect((await del(`/neon/projects/proj_demo/branches/${main.id}`)).status).toBe(200);
  });

  it("drift edits state immediately", async () => {
    await post("/vercel/v10/projects/prj_demo/env?upsert=true", [{ key: "DATABASE_URL", value: "orig", target: ["preview"], gitBranch: "feat/x" }]);
    await post("/neon/projects/proj_demo/branches", { branch: { name: "sponson/preview/pr-1", parent_id: "br-1" } });
    await post("/clerk/redirect_urls", { url: "https://c" });
    await chaos({ drift: { "vercel.env.preview.DATABASE_URL": "changed-in-console", "neon.branch.sponson/preview/pr-1": "delete", "clerk.redirect.https://c": "delete" } });
    const p = sim.state.vercel.projects.prj_demo!;
    expect(p.envs[0]).toMatchObject({ key: "DATABASE_URL", value: "changed-in-console", createdBy: "api" });
    expect(sim.state.neon.projects.proj_demo!.branches.map((b) => b.name)).toEqual(["main"]);
    expect(sim.state.clerk.redirect_urls).toEqual([]);
    await chaos({ drift: { "vercel.env.preview.DATABASE_URL": "delete" } });
    expect(p.envs).toEqual([]);
    expect((await fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify({ drift: { "bogus.key": "x" } }), headers: auth })).status).toBe(400);
  });

  it("marks seeded resources as sim and reset restores the seed", async () => {
    await post("/clerk/redirect_urls", { url: "https://d" });
    expect(sim.state.clerk.redirect_urls[0]?.createdBy).toBe("api");
    expect(sim.state.neon.projects.proj_demo!.branches[0]?.createdBy).toBe("sim");
    await fetch(`${sim.url}/_reset`, { method: "POST", body: JSON.stringify({ clerk: { redirect_urls: ["https://seeded"] } }), headers: auth });
    expect(sim.state.clerk.redirect_urls.map((r) => r.url)).toEqual(["https://seeded"]);
    // A partial seed keeps the default projects of the providers it does not name.
    expect(sim.state.neon.projects.proj_demo!.branches.map((b) => b.name)).toEqual(["main"]);
    expect(sim.state.vercel.projects.prj_demo).toEqual({ envs: [], deployments: [] });
    await fetch(`${sim.url}/_reset`, { method: "POST", body: JSON.stringify({ neon: { projects: {} } }), headers: auth });
    expect(sim.state.neon.projects).toEqual({});
    expect(sim.state.clerk.redirect_urls).toEqual([]);
    expect(await writes()).toEqual([]);
    const snap = (await (await fetch(`${sim.url}/_state`)).json()) as { chaos: { deploy: string } };
    expect(snap.chaos.deploy).toBe("ok");
  });

  it("latency delays provider calls, reads included", async () => {
    await chaos({ latency_ms: 120 });
    const t = Date.now();
    await fetch(`${sim.url}/clerk/redirect_urls`, { headers: auth });
    expect(Date.now() - t).toBeGreaterThanOrEqual(110);
  });

  it("rejects an unknown chaos key instead of ignoring it", async () => {
    const r = await fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify({ latency: 5 }), headers: auth });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/unknown chaos key: latency/);
    expect(sim.state.chaos.latency_ms).toBe(0);
  });
});

describe("matchesRule", () => {
  it("matches method and path glob", () => {
    expect(matchesRule("DELETE /neon/*", "DELETE", "/neon/projects/p/branches/br-1")).toBe(true);
    expect(matchesRule("DELETE /neon/*", "POST", "/neon/projects/p/branches")).toBe(false);
    expect(matchesRule("POST /clerk/redirect_urls", "POST", "/clerk/redirect_urls")).toBe(true);
    expect(matchesRule("POST /clerk/redirect_urls", "POST", "/clerk/redirect_urls/x")).toBe(false);
  });
});
