import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "./index.js";
import { matchesRule } from "./chaos.js";

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
    expect(sim.state.vercel.projects.prj_demo).toMatchObject({ envs: [], deployments: [], link: { type: "github" } });
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

describe("sim chaos: transport", () => {
  let sim: SimHandle;
  beforeEach(async () => {
    sim = await startSim();
  });
  afterEach(() => sim.close());

  const chaos = (body: unknown) => fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify(body), headers: auth }).then((r) => r.json());
  const post = (path: string, body: unknown) => fetch(`${sim.url}${path}`, { method: "POST", body: JSON.stringify(body), headers: auth });

  it("fail_on with a GET rule fails reads too; without one, reads are never failed", async () => {
    await chaos({ fail_next: 1, status: 502 });
    expect((await fetch(`${sim.url}/clerk/redirect_urls`, { headers: auth })).status).toBe(200);
    await chaos({ fail_next: 1, status: 502, fail_on: "GET /clerk/*" });
    expect((await fetch(`${sim.url}/clerk/redirect_urls`, { headers: auth })).status).toBe(502);
    expect((await fetch(`${sim.url}/clerk/redirect_urls`, { headers: auth })).status).toBe(200);
    expect(sim.state.writes).toEqual([]);
  });

  it("429s carry Retry-After from retry_after", async () => {
    await chaos({ fail_next: 1, status: 429, retry_after: 2 });
    const r = await post("/clerk/redirect_urls", { url: "https://a" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("2");
  });

  it("drop_response_next performs the write and destroys the socket", async () => {
    await chaos({ drop_response_next: 1, fail_on: "POST /clerk/*" });
    await expect(post("/clerk/redirect_urls", { url: "https://dropped" })).rejects.toThrow();
    expect(sim.state.clerk.redirect_urls.map((r) => r.url)).toEqual(["https://dropped"]);
    expect(sim.state.writes[0]).not.toHaveProperty("failed");
    expect((await post("/clerk/redirect_urls", { url: "https://b" })).status).toBe(200);
  });

  it("hang_next accepts the request and never answers (and does not perform it)", async () => {
    await chaos({ hang_next: 1, fail_on: "GET /neon/*" });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 150);
    await expect(fetch(`${sim.url}/neon/projects/proj_demo/branches`, { headers: auth, signal: ctl.signal })).rejects.toThrow();
    clearTimeout(t);
    expect((await fetch(`${sim.url}/neon/projects/proj_demo/branches`, { headers: auth })).status).toBe(200);
  });

  it("hold_next parks a matching request until released, then performs and answers it", async () => {
    await chaos({ hold_next: 1, fail_on: "POST /clerk/*" });
    const held = post("/clerk/redirect_urls", { url: "https://held" });
    await expect.poll(() => sim.state.heldCount).toBe(1);
    expect((await post("/clerk/redirect_urls", { url: "https://after" })).status).toBe(200);
    expect(sim.state.clerk.redirect_urls.map((r) => r.url)).toEqual(["https://after"]);
    expect(await (await fetch(`${sim.url}/_release`, { method: "POST" })).json()).toEqual({ released: 1 });
    expect((await held).status).toBe(200);
    expect(sim.state.clerk.redirect_urls.map((r) => r.url)).toEqual(["https://after", "https://held"]);
    expect(sim.state.heldCount).toBe(0);
  });

  it("refused writes are logged as failed", async () => {
    await post("/clerk/redirect_urls", { url: "https://dup" });
    expect((await post("/clerk/redirect_urls", { url: "https://dup" })).status).toBe(422);
    expect(sim.state.writes.map((w) => w.failed ?? false)).toEqual([false, true]);
  });
});

describe("sim pagination (page_size)", () => {
  let sim: SimHandle;
  afterEach(() => sim.close());
  const get = (path: string) => fetch(`${sim.url}${path}`, { headers: auth }).then((r) => r.json() as Promise<Record<string, unknown>>);

  it("pages Neon branches by ?cursor=, Vercel envs by ?until=, Clerk redirect URLs by offset/limit", async () => {
    sim = await startSim({
      seed: {
        chaos: { page_size: 2 },
        neon: { projects: { proj_demo: { branches: [{ name: "main" }, { name: "a", parent: "main" }, { name: "b", parent: "main" }] } } },
        vercel: { projects: { prj_demo: { envs: ["A", "B", "C"].map((key) => ({ key, value: key, target: "preview" })) } } },
        clerk: { redirect_urls: ["https://1", "https://2", "https://3"] },
      },
    });
    const n1 = await get("/neon/projects/proj_demo/branches");
    expect((n1.branches as Array<{ name: string; default: boolean }>).map((b) => [b.name, b.default])).toEqual([["main", true], ["a", false]]);
    const next = (n1.pagination as { next: string }).next;
    const n2 = await get(`/neon/projects/proj_demo/branches?cursor=${next}`);
    expect((n2.branches as Array<{ name: string }>).map((b) => b.name)).toEqual(["b"]);
    expect(n2.pagination).toEqual({});

    const v1 = await get("/vercel/v10/projects/prj_demo/env");
    expect(v1.pagination).toEqual({ count: 2, next: 2, prev: null });
    const v2 = await get("/vercel/v10/projects/prj_demo/env?until=2");
    expect((v2.envs as Array<{ key: string }>).map((e) => e.key)).toEqual(["C"]);
    expect((v2.pagination as { next: unknown }).next).toBeNull();

    const c1 = await get("/clerk/redirect_urls?paginated=true");
    expect(c1).toMatchObject({ total_count: 3 });
    expect((c1.data as unknown[]).length).toBe(2);
    const c2 = await get("/clerk/redirect_urls?paginated=true&offset=2&limit=100");
    expect((c2.data as Array<{ url: string }>).map((r) => r.url)).toEqual(["https://3"]);
  });

  it("Clerk answers a bare array without `paginated=true`, and pages by the spec's default limit (10) with it", async () => {
    sim = await startSim({ seed: { clerk: { redirect_urls: Array.from({ length: 12 }, (_, i) => `https://${i}`) } } });
    const bare = (await fetch(`${sim.url}/clerk/redirect_urls`, { headers: auth }).then((r) => r.json())) as unknown[];
    expect(bare).toHaveLength(12);
    expect(bare[0]).toEqual({ object: "redirect_url", id: expect.any(String), url: "https://0", created_at: expect.any(Number), updated_at: expect.any(Number) });
    const paged = await get("/clerk/redirect_urls?paginated=true");
    expect(paged).toMatchObject({ total_count: 12 });
    expect(paged.data as unknown[]).toHaveLength(10);
  });
});

describe("sim providers: async operations, deployments, upsert conflicts, drift", () => {
  let sim: SimHandle;
  beforeEach(async () => {
    sim = await startSim();
  });
  afterEach(() => sim.close());
  const chaos = (body: unknown) => fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify(body), headers: auth }).then((r) => r.json());
  const post = (path: string, body: unknown) => fetch(`${sim.url}${path}`, { method: "POST", body: JSON.stringify(body), headers: auth });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("neon_op_ms: after a create, further creates and writes to the new branch answer 423 until the operations finish", async () => {
    await chaos({ neon_op_ms: 100 });
    const main = sim.state.neon.projects.proj_demo!.branches[0]!.id;
    const r = (await (await post("/neon/projects/proj_demo/branches", { branch: { name: "x", parent_id: main } })).json()) as { branch: { id: string } };
    expect((await post("/neon/projects/proj_demo/branches", { branch: { name: "y", parent_id: main } })).status).toBe(423);
    expect((await fetch(`${sim.url}/neon/projects/proj_demo/branches/${r.branch.id}`, { method: "DELETE", headers: auth })).status).toBe(423);
    await sleep(110);
    expect((await post("/neon/projects/proj_demo/branches", { branch: { name: "y", parent_id: main } })).status).toBe(201);
  });

  it("deploy_ms: QUEUED → BUILDING → READY; every deployment gets its own URL", async () => {
    await chaos({ deploy: "never", deploy_ms: 150 });
    const create = async () => (await (await post("/vercel/v13/deployments", { name: "prj_demo", gitSource: { type: "github", repoId: 100000, ref: "feat/x", sha: "a".repeat(40) } })).json()) as { id: string; url: string; readyState: string };
    const d = await create();
    expect(d.readyState).toBe("QUEUED");
    await sleep(60);
    expect(((await (await fetch(`${sim.url}/vercel/v13/deployments/${d.id}`, { headers: auth })).json()) as { readyState: string }).readyState).toBe("BUILDING");
    await sleep(100);
    expect(((await (await fetch(`${sim.url}/vercel/v13/deployments/${d.id}`, { headers: auth })).json()) as { readyState: string }).readyState).toBe("READY");
    const again = await create();
    expect(d.url).toBe("prj_demo-aaaaaaaa.vercel.app");
    expect(again.url).toBe("prj_demo-aaaaaaaa-2.vercel.app");
  });

  it("deploy cancel: a new build on a branch cancels that branch's builds in progress", async () => {
    await chaos({ deploy: "cancel", deploy_ms: 1000 });
    await post("/vercel/v13/deployments", { name: "prj_demo", gitSource: { type: "github", repoId: 100000, ref: "feat/x", sha: "a".repeat(40) } });
    await post("/vercel/v13/deployments", { name: "prj_demo", gitSource: { type: "github", repoId: 100000, ref: "other", sha: "c".repeat(40) } });
    await post("/vercel/v13/deployments", { name: "prj_demo", gitSource: { type: "github", repoId: 100000, ref: "feat/x", sha: "b".repeat(40) } });
    expect(sim.state.vercel.projects.prj_demo!.deployments.map((d) => d.state)).toEqual(["CANCELED", "QUEUED", "QUEUED"]);
  });

  it("bulk upsert: overlapping targets fail the whole request with 400 ENV_CONFLICT; env_upsert_fail fills `failed`", async () => {
    await post("/vercel/v10/projects/prj_demo/env?upsert=true", [{ key: "API_BASE", value: "v1", target: ["production", "preview"] }]);
    const r = await post("/vercel/v10/projects/prj_demo/env?upsert=true", [
      { key: "OK", value: "1", target: ["production"] },
      { key: "API_BASE", value: "v2", target: ["production"] },
    ]);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("ENV_CONFLICT");
    expect(sim.state.vercel.projects.prj_demo!.envs.map((e) => e.key)).toEqual(["API_BASE"]);

    await chaos({ env_upsert_fail: ["BAD"] });
    const r2 = (await (await post("/vercel/v10/projects/prj_demo/env?upsert=true", [
      { key: "GOOD", value: "1", target: ["preview"] },
      { key: "BAD", value: "2", target: ["preview"] },
    ])).json()) as { created: Array<{ key: string; createdAt: number; updatedAt: number }>; failed: Array<{ error: { key: string } }> };
    expect(r2.created.map((e) => e.key)).toEqual(["GOOD"]);
    expect(r2.failed.map((f) => f.error.key)).toEqual(["BAD"]);
    // an update is distinguishable from a create in the answer
    const r3 = (await (await post("/vercel/v10/projects/prj_demo/env?upsert=true", [{ key: "GOOD", value: "3", target: ["preview"] }])).json()) as typeof r2;
    expect(r3.created[0]!.updatedAt).toBeGreaterThan(r3.created[0]!.createdAt);
  });

  it("drift targets one git branch with @branch (@* = project-wide) and `recreate` gives a new id", async () => {
    await post("/vercel/v10/projects/prj_demo/env?upsert=true", [
      { key: "X", value: "branch", target: ["preview"], gitBranch: "feat/x" },
      { key: "X", value: "shared", target: ["preview"] },
    ]);
    await chaos({ drift: { "vercel.env.preview@feat/x.X": "edited" } });
    const envs = () => sim.state.vercel.projects.prj_demo!.envs;
    expect(envs().map((e) => e.value)).toEqual(["edited", "shared"]);
    await chaos({ drift: { "vercel.env.preview@*.X": "edited-shared" } });
    expect(envs().map((e) => e.value)).toEqual(["edited", "edited-shared"]);
    const before = envs().find((e) => e.gitBranch === "feat/x")!.id;
    await chaos({ drift: { "vercel:prj_demo.env.preview@feat/x.X": "recreate" } });
    const after = envs().find((e) => e.gitBranch === "feat/x")!;
    expect(after.id).not.toBe(before);
    expect(after.value).toBe("edited");

    const main = sim.state.neon.projects.proj_demo!.branches[0]!;
    await post("/neon/projects/proj_demo/branches", { branch: { name: "pr", parent_id: main.id } });
    const old = sim.state.neon.projects.proj_demo!.branches.find((b) => b.name === "pr")!.id;
    await chaos({ drift: { "neon.branch.pr": "recreate" } });
    const now = sim.state.neon.projects.proj_demo!.branches.find((b) => b.name === "pr")!;
    expect(now.id).not.toBe(old);
    expect(now.parent_id).toBe(main.id);

    await post("/clerk/redirect_urls", { url: "https://r" });
    const ru = sim.state.clerk.redirect_urls[0]!.id;
    await chaos({ drift: { "clerk.redirect.https://r": "recreate" } });
    expect(sim.state.clerk.redirect_urls.map((r) => r.url)).toEqual(["https://r"]);
    expect(sim.state.clerk.redirect_urls[0]!.id).not.toBe(ru);
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
