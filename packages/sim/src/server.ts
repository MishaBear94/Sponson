import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type SimState, type DeploymentState, type SimSeed, type VercelDeployment, type VercelEnv } from "./state.js";

/*
 * Assumptions about the real APIs that this fake encodes and that are most likely wrong
 * (see 验收策略.md, "本地覆盖不了的"). Verify against live accounts before trusting the rest:
 *   1. Vercel env writes are visible to the next deployment immediately (no propagation delay).
 *   2. GET /v6/deployments?sha= returns newest first; the adapter sorts by createdAt anyway.
 *   3. Neon branch deletion is synchronous; the branch is gone when DELETE returns.
 *   4. GET /v9/projects/:id/env returns plaintext values. The real API needs `?decrypt=true` (the adapter sends it)
 *      and never returns values of `sensitive`-type vars, so those would always diff as `update`.
 *   5. POST /v10/projects/:id/env (bulk upsert) answers 200 with `{ created, failed }`; the adapter treats a
 *      non-empty `failed` as an error. The sim never fills `failed`.
 *   6. POST /v13/deployments resolves the project from `name`; the adapter also sends `project`, which the real
 *      API prefers. The response is READY at once unless chaos says otherwise; the real one is QUEUED/BUILDING first.
 *   7. Neon branch creation is synchronous and the endpoint is usable when POST returns. The real API runs it as
 *      async operations; a connection attempt right after apply may be refused for a few seconds.
 *   8. Neon connection strings use database `neondb` and role `neondb_owner`, the defaults of a new project.
 *   9. Clerk answers 422 to a duplicate redirect URL and returns the list as a bare JSON array.
 */

type Json = Record<string, unknown>;

class Reply {
  constructor(
    public status: number,
    public body: unknown,
  ) {}
}

const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);

export function createSimServer(state: SimState): Server {
  return createServer((req, res) => {
    handle(state, req, res).catch((e: unknown) => {
      send(res, 500, { error: String((e as Error).message ?? e) });
    });
  });
}

async function handle(state: SimState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://sim.local");
  const raw = await readBody(req);
  let body: unknown = undefined;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid json" });
    }
  }

  if (url.pathname.startsWith("/_")) {
    const r = control(state, method, url, body);
    return send(res, r.status, r.body);
  }

  // Any non-empty bearer token is accepted; missing-token bugs must surface as 401.
  const auth = req.headers.authorization ?? "";
  if (!/^Bearer\s+\S+$/.test(auth)) return send(res, 401, { error: "unauthorized" });

  if (state.chaos.latency_ms > 0) await sleep(state.chaos.latency_ms);

  if (WRITE_METHODS.has(method)) {
    const entry = { at: new Date().toISOString(), method, path: url.pathname, bodyHash: sha256(raw) };
    if (state.shouldFail(method, url.pathname)) {
      state.writes.push({ ...entry, failed: true });
      return send(res, state.chaos.status, { error: "chaos" });
    }
    state.writes.push(entry);
  }

  let r: Reply;
  if (url.pathname.startsWith("/vercel/")) r = vercel(state, method, url, body);
  else if (url.pathname.startsWith("/neon/")) r = neon(state, method, url, body);
  else if (url.pathname.startsWith("/clerk/")) r = clerk(state, method, url, body);
  else r = new Reply(404, { error: "not found" });
  send(res, r.status, r.body);
}

// ---------------------------------------------------------------------------
// Control endpoints
// ---------------------------------------------------------------------------

function control(state: SimState, method: string, url: URL, body: unknown): Reply {
  const path = url.pathname;
  if (method === "POST" && path === "/_chaos") {
    try {
      return new Reply(200, state.applyChaos((body ?? {}) as Json));
    } catch (e) {
      return new Reply(400, { error: (e as Error).message });
    }
  }
  if (method === "GET" && path === "/_state") return new Reply(200, state.snapshot());
  if (method === "GET" && path === "/_writes") {
    const since = Number(url.searchParams.get("since") ?? 0);
    return new Reply(200, state.writes.slice(Number.isFinite(since) ? since : 0));
  }
  if (method === "POST" && path === "/_reset") {
    state.reset(body as Partial<SimSeed> | undefined);
    return new Reply(200, { ok: true });
  }
  return new Reply(404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

function vercel(state: SimState, method: string, url: URL, body: unknown): Reply {
  const path = url.pathname.slice("/vercel".length);
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/v9\/projects\/([^/]+)\/env$/)) && method === "GET") {
    const p = state.vercel.projects[m[1]!];
    if (!p) return new Reply(404, { error: "project not found" });
    return new Reply(200, { envs: p.envs.map(publicEnv) });
  }
  if ((m = path.match(/^\/v10\/projects\/([^/]+)\/env$/)) && method === "POST") {
    const p = state.vercel.projects[m[1]!];
    if (!p) return new Reply(404, { error: "project not found" });
    const upsert = url.searchParams.get("upsert") === "true";
    const items = (Array.isArray(body) ? body : [body]) as Array<Partial<VercelEnv> & { target?: string[] }>;
    const created: VercelEnv[] = [];
    for (const it of items) {
      if (typeof it?.key !== "string" || typeof it.value !== "string" || !Array.isArray(it.target)) return new Reply(400, { error: "bad env" });
      const existing = p.envs.find((e) => e.key === it.key && sameSet(e.target, it.target!) && (e.gitBranch ?? null) === (it.gitBranch ?? null));
      if (existing) {
        if (!upsert) return new Reply(400, { error: "ENV_ALREADY_EXISTS" });
        existing.value = it.value;
        existing.updatedAt = Date.now();
        created.push(existing);
        continue;
      }
      const now = Date.now();
      const env: VercelEnv = {
        id: state.nextId("env_"),
        key: it.key,
        value: it.value,
        target: [...it.target],
        type: it.type === "plain" ? "plain" : "encrypted",
        ...(it.gitBranch ? { gitBranch: it.gitBranch } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: "api",
      };
      p.envs.push(env);
      created.push(env);
    }
    return new Reply(200, { created: created.map(publicEnv), failed: [] });
  }
  if ((m = path.match(/^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/)) && (method === "PATCH" || method === "DELETE")) {
    const p = state.vercel.projects[m[1]!];
    if (!p) return new Reply(404, { error: "project not found" });
    const env = p.envs.find((e) => e.id === m![2]);
    if (!env) return new Reply(404, { error: "env not found" });
    if (method === "DELETE") {
      p.envs = p.envs.filter((e) => e !== env);
      return new Reply(200, publicEnv(env));
    }
    const b = (body ?? {}) as Partial<VercelEnv>;
    if (typeof b.value === "string") env.value = b.value;
    env.updatedAt = Date.now();
    return new Reply(200, publicEnv(env));
  }
  if (path === "/v6/deployments" && method === "GET") {
    const projectId = url.searchParams.get("projectId") ?? "";
    const sha = url.searchParams.get("sha") ?? "";
    const p = state.vercel.projects[projectId];
    if (!p) return new Reply(404, { error: "project not found" });
    if (sha && !p.deployments.some((d) => d.meta.githubCommitSha === sha)) autoDeploy(state, projectId, sha);
    refreshDeployments(p.deployments);
    const list = p.deployments.filter((d) => !sha || d.meta.githubCommitSha === sha).sort((a, b) => b.createdAt - a.createdAt);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return new Reply(200, { deployments: list.slice(0, limit).map(publicDeployment) });
  }
  if (path === "/v13/deployments" && method === "POST") {
    const b = (body ?? {}) as { name?: string; gitSource?: { sha?: string } };
    const projectId = b.name ?? "";
    const p = state.vercel.projects[projectId];
    if (!p) return new Reply(404, { error: "project not found" });
    const sha = b.gitSource?.sha ?? "unknown";
    const d = state.createDeployment(projectId, p, sha, state.chaos.deploy === "fail" ? "ERROR" : "READY", Date.now());
    return new Reply(200, deploymentDetail(d));
  }
  if ((m = path.match(/^\/v13\/deployments\/([^/]+)$/)) && method === "GET") {
    for (const p of Object.values(state.vercel.projects)) {
      refreshDeployments(p.deployments);
      const d = p.deployments.find((x) => x.uid === m![1]);
      if (d) return new Reply(200, deploymentDetail(d));
    }
    return new Reply(404, { error: "deployment not found" });
  }
  return new Reply(404, { error: "not found" });
}

/** Stand-in for Vercel's git integration: the first lookup of a sha "triggers" its auto-deploy per the chaos mode. */
function autoDeploy(state: SimState, projectId: string, sha: string): void {
  const p = state.vercel.projects[projectId]!;
  const mode = state.chaos.deploy;
  const now = Date.now();
  if (mode === "never") return;
  if (mode === "fail") {
    state.createDeployment(projectId, p, sha, "ERROR", now);
    return;
  }
  if (mode === "stale") {
    state.createDeployment(projectId, p, sha, "READY", now - 60_000);
    return;
  }
  if (mode === "double") {
    state.createDeployment(projectId, p, sha, "READY", now - 1_000, "-1");
    state.createDeployment(projectId, p, sha, "READY", now, "-2");
    return;
  }
  const delay = mode.match(/^delay:(\d+(?:\.\d+)?)$/);
  if (delay) {
    const d = state.createDeployment(projectId, p, sha, "BUILDING", now);
    d.readyAt = now + Number(delay[1]) * 1000;
    return;
  }
  state.createDeployment(projectId, p, sha, "READY", now);
}

function refreshDeployments(list: VercelDeployment[]): void {
  const now = Date.now();
  for (const d of list) if (d.readyAt !== undefined && d.state === "BUILDING" && now >= d.readyAt) d.state = "READY";
}

function publicEnv(e: VercelEnv) {
  const { createdBy: _c, ...rest } = e;
  return rest;
}

function publicDeployment(d: VercelDeployment) {
  return { uid: d.uid, url: d.url, state: d.state, createdAt: d.createdAt, meta: d.meta };
}

function deploymentDetail(d: VercelDeployment): { id: string; url: string; readyState: DeploymentState; createdAt: number } {
  return { id: d.uid, url: d.url, readyState: d.state, createdAt: d.createdAt };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------

function neon(state: SimState, method: string, url: URL, body: unknown): Reply {
  const path = url.pathname.slice("/neon".length);
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/projects\/([^/]+)\/branches$/))) {
    const p = state.neon.projects[m[1]!];
    if (!p) return new Reply(404, { error: "project not found" });
    if (method === "GET") {
      return new Reply(200, { branches: p.branches.map((b) => ({ id: b.id, name: b.name, parent_id: b.parent_id, created_at: b.created_at })) });
    }
    if (method === "POST") {
      const b = (body ?? {}) as { branch?: { name?: string; parent_id?: string } };
      const name = b.branch?.name;
      if (!name) return new Reply(400, { error: "branch.name required" });
      if (p.branches.some((x) => x.name === name)) return new Reply(409, { error: "branch already exists" });
      const parentId = b.branch?.parent_id ?? null;
      if (parentId && !p.branches.some((x) => x.id === parentId)) return new Reply(404, { error: "parent branch not found" });
      const branch = state.createBranch(p, name, parentId, "api");
      return new Reply(201, {
        branch: { id: branch.id, name: branch.name, parent_id: branch.parent_id, created_at: branch.created_at },
        endpoints: [{ id: branch.endpoint.id, host: branch.endpoint.host }],
        connection_uris: [{ connection_uri: state.connectionUri(branch) }],
      });
    }
  }
  if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)\/endpoints$/)) && method === "GET") {
    const p = state.neon.projects[m[1]!];
    const b = p?.branches.find((x) => x.id === m![2]);
    if (!p || !b) return new Reply(404, { error: "branch not found" });
    return new Reply(200, { endpoints: [{ id: b.endpoint.id, host: b.endpoint.host }] });
  }
  if ((m = path.match(/^\/projects\/([^/]+)\/connection_uri$/)) && method === "GET") {
    const p = state.neon.projects[m[1]!];
    const b = p?.branches.find((x) => x.id === url.searchParams.get("branch_id"));
    if (!p || !b) return new Reply(404, { error: "branch not found" });
    return new Reply(200, { uri: state.connectionUri(b) });
  }
  if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)$/)) && method === "DELETE") {
    const p = state.neon.projects[m[1]!];
    const b = p?.branches.find((x) => x.id === m![2]);
    if (!p || !b) return new Reply(404, { error: "branch not found" });
    p.branches = p.branches.filter((x) => x !== b);
    return new Reply(200, { branch: { id: b.id, name: b.name } });
  }
  return new Reply(404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Clerk
// ---------------------------------------------------------------------------

function clerk(state: SimState, method: string, url: URL, body: unknown): Reply {
  const path = url.pathname.slice("/clerk".length);
  let m: RegExpMatchArray | null;

  if (path === "/redirect_urls" && method === "GET") {
    return new Reply(200, state.clerk.redirect_urls.map((r) => ({ id: r.id, url: r.url })));
  }
  if (path === "/redirect_urls" && method === "POST") {
    const b = (body ?? {}) as { url?: string };
    if (!b.url) return new Reply(400, { error: "url required" });
    if (state.clerk.redirect_urls.some((r) => r.url === b.url)) return new Reply(422, { error: "redirect url already exists" });
    const r = { id: state.nextId("ru_"), url: b.url, createdAt: Date.now(), createdBy: "api" as const };
    state.clerk.redirect_urls.push(r);
    return new Reply(200, { id: r.id, url: r.url });
  }
  if ((m = path.match(/^\/redirect_urls\/([^/]+)$/)) && method === "DELETE") {
    const r = state.clerk.redirect_urls.find((x) => x.id === m![1]);
    if (!r) return new Reply(404, { error: "not found" });
    state.clerk.redirect_urls = state.clerk.redirect_urls.filter((x) => x !== r);
    return new Reply(200, { id: r.id, object: "redirect_url", deleted: true });
  }
  return new Reply(404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
