/**
 * Simulated Vercel: project env vars and deployments.
 *
 * Assumptions about the real API that this fake encodes and that are most likely wrong. A local fake cannot
 * prove them; scenarios/contract.test.ts pins the critical ones against live accounts (`pnpm test:live`):
 *   V1. Env writes are visible to the next deployment immediately (no propagation delay). Lists are
 *       read-your-writes here; the real list may lag a write, so adapters trust write responses instead.
 *   V2. GET /v6/deployments?sha= returns newest first; the adapter sorts by createdAt anyway.
 *   V3. GET /v9/projects/:id/env returns plaintext values. The real API needs `?decrypt=true` (the adapter sends it)
 *       and never returns values of `sensitive`-type vars, so those would always diff as `update`.
 *   V4. POST /v10/projects/:id/env?upsert=true answers 200 with `{ created, failed }`; `created` lists every entry
 *       written (new or updated, `createdAt === updatedAt` only for new ones); entries named in chaos
 *       `env_upsert_fail` come back under `failed` and are not written. An entry whose key+gitBranch already exists
 *       with an overlapping but different target set fails the whole request with 400 `ENV_CONFLICT`.
 *   V5. POST /v13/deployments resolves the project from `name`; the adapter also sends `project`, which the real
 *       API prefers. Deployments go QUEUED → BUILDING → READY over chaos `deploy_ms` (default 0: READY at once).
 *       Every deployment has its own URL. `deploy: cancel` cancels a branch's in-progress builds when a new one starts.
 *   V6. Pagination (chaos `page_size`): `{ envs, pagination: { count, next, prev } }` with `?until=`. Cursors are
 *       opaque to the client.
 */
import { page, Reply, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One simulated Vercel environment variable. */
export interface VercelEnv {
  id: string;
  key: string;
  value: string;
  target: string[];
  type: "encrypted" | "plain";
  gitBranch?: string;
  createdAt: number;
  updatedAt: number;
  createdBy: CreatedBy;
}

/** Vercel's deployment states, as its API reports them. */
export type DeploymentState = "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED";

/** One simulated deployment. */
export interface VercelDeployment {
  uid: string;
  url: string;
  state: DeploymentState;
  createdAt: number;
  /** While in progress: QUEUED until `buildingAt`, BUILDING until `readyAt`, then `finalState`. */
  buildingAt?: number;
  readyAt?: number;
  finalState?: DeploymentState;
  meta: { githubCommitSha: string; githubCommitRef?: string };
  createdBy: CreatedBy;
}

/** One simulated Vercel project: its variables and deployments. */
export interface VercelProject {
  envs: VercelEnv[];
  deployments: VercelDeployment[];
}

/** Simulated Vercel: projects by id. */
export interface VercelState {
  projects: Record<string, VercelProject>;
}

/** Initial Vercel state. */
export interface VercelSeed {
  projects: Record<string, { envs: Array<{ key: string; value: string; target: string; gitBranch?: string }> }>;
}

/** Simulated Vercel (env vars, deployments); see the assumptions at the top of this file. */
export const vercelSim: ProviderSim<VercelState, VercelSeed> = {
  env: { token: "VERCEL_TOKEN", url: "VERCEL_API_URL", testToken: "tok_vercel" },
  defaultSeed: { projects: { prj_demo: { envs: [] } } },

  reset(core, seed) {
    const state: VercelState = { projects: {} };
    const now = Date.now();
    for (const [id, p] of Object.entries(seed?.projects ?? {})) {
      const project: VercelProject = { envs: [], deployments: [] };
      for (const e of p.envs) {
        project.envs.push({
          id: core.nextId("env_"),
          key: e.key,
          value: e.value,
          target: [e.target],
          type: "encrypted",
          ...(e.gitBranch ? { gitBranch: e.gitBranch } : {}),
          createdAt: now,
          updatedAt: now,
          createdBy: "sim",
        });
      }
      state.projects[id] = project;
    }
    return state;
  },

  /**
   * `env.<target>.<NAME>`           every record of NAME in target
   * `env.<target>@<branch>.<NAME>`  only the record for that git branch (`@*`: the project-wide one)
   * Value: a new value, "delete", or "recreate" (delete and re-create with the same name and a new id).
   */
  drift(core, state, { key, rest, value, only }) {
    if (!rest.startsWith("env.")) return false;
    const spec = rest.slice("env.".length);
    // Env names have no dots; git branches may.
    const dot = spec.lastIndexOf(".");
    if (dot < 0) throw new Error(`bad drift key: ${key}`);
    const [target, branch] = splitOnce(spec.slice(0, dot), "@");
    const name = spec.slice(dot + 1);
    for (const [id, p] of Object.entries(state.projects)) {
      if (only !== undefined && id !== only) continue;
      const hit = p.envs.filter((e) => e.key === name && e.target.includes(target) && (branch === undefined || (e.gitBranch ?? "*") === branch));
      if (value === "delete") p.envs = p.envs.filter((e) => !hit.includes(e));
      else if (value === "recreate") {
        p.envs = p.envs.filter((e) => !hit.includes(e));
        for (const e of hit) p.envs.push({ ...e, id: core.nextId("env_"), createdAt: Date.now(), updatedAt: Date.now(), createdBy: "sim" });
      } else for (const e of hit) Object.assign(e, { value, updatedAt: Date.now() });
    }
    return true;
  },

  routes(core, state, { method, url, path, body }) {
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/env$/)) && method === "GET") {
      const p = state.projects[m[1]!];
      if (!p) return new Reply(404, { error: "project not found" });
      const pg = page(core, p.envs, url.searchParams.get("until"));
      return new Reply(200, { envs: pg.items.map(publicEnv), pagination: { count: pg.items.length, next: pg.next, prev: null } });
    }
    if ((m = path.match(/^\/v10\/projects\/([^/]+)\/env$/)) && method === "POST") {
      const p = state.projects[m[1]!];
      if (!p) return new Reply(404, { error: "project not found" });
      return upsertEnvs(core, p, Array.isArray(body) ? body : [body], url.searchParams.get("upsert") === "true");
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/)) && (method === "PATCH" || method === "DELETE")) {
      const p = state.projects[m[1]!];
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
      const p = state.projects[projectId];
      if (!p) return new Reply(404, { error: "project not found" });
      if (sha && !p.deployments.some((d) => d.meta.githubCommitSha === sha)) autoDeploy(core, projectId, p, sha);
      refreshDeployments(p.deployments);
      const list = p.deployments.filter((d) => !sha || d.meta.githubCommitSha === sha).sort((a, b) => b.createdAt - a.createdAt);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return new Reply(200, { deployments: list.slice(0, limit).map(publicDeployment) });
    }
    if (path === "/v13/deployments" && method === "POST") {
      const b = (body ?? {}) as { name?: string; gitSource?: { sha?: string; ref?: string } };
      const projectId = b.name ?? "";
      const p = state.projects[projectId];
      if (!p) return new Reply(404, { error: "project not found" });
      const sha = b.gitSource?.sha ?? "unknown";
      const d = createDeployment(core, projectId, p, sha, core.chaos.deploy === "fail" ? "ERROR" : "READY", Date.now(), {
        ...(b.gitSource?.ref ? { ref: b.gitSource.ref } : {}),
        buildMs: core.chaos.deploy_ms,
      });
      return new Reply(200, deploymentDetail(d));
    }
    if ((m = path.match(/^\/v13\/deployments\/([^/]+)$/)) && method === "GET") {
      for (const p of Object.values(state.projects)) {
        refreshDeployments(p.deployments);
        const d = p.deployments.find((x) => x.uid === m![1]);
        if (d) return new Reply(200, deploymentDetail(d));
      }
      return new Reply(404, { error: "deployment not found" });
    }
    return new Reply(404, { error: "not found" });
  },
};

/** One item of an env create request, once validated. */
type EnvInput = Pick<VercelEnv, "key" | "value" | "target"> & { type?: unknown; gitBranch?: string };

function isEnvInput(v: unknown): v is EnvInput {
  if (typeof v !== "object" || v === null) return false;
  const it = v as Record<string, unknown>;
  return typeof it.key === "string" && typeof it.value === "string" && Array.isArray(it.target) && (it.gitBranch === undefined || typeof it.gitBranch === "string");
}

function upsertEnvs(core: SimCore, p: VercelProject, body: unknown[], upsert: boolean): Reply {
  const sameScope = (e: VercelEnv, it: EnvInput) => e.key === it.key && (e.gitBranch ?? null) === (it.gitBranch ?? null);
  // Validate the whole batch first: a rejected request writes nothing.
  if (!body.every(isEnvInput)) return new Reply(400, { error: { code: "bad_request", message: "bad env" } });
  const items = body;
  for (const it of items) {
    const overlapping = p.envs.find((e) => sameScope(e, it) && !sameSet(e.target, it.target) && e.target.some((t) => it.target.includes(t)));
    if (overlapping) {
      return new Reply(400, { error: { code: "ENV_CONFLICT", key: it.key, message: `A variable with the key ${it.key} already exists for the target ${overlapping.target.join(",")}` } });
    }
  }
  const created: VercelEnv[] = [];
  const failed: Array<{ error: { code: string; key: string; message: string } }> = [];
  for (const it of items) {
    if (core.chaos.env_upsert_fail.includes(it.key)) {
      failed.push({ error: { code: "ENV_CONFLICT", key: it.key, message: "rejected by chaos env_upsert_fail" } });
      continue;
    }
    const existing = p.envs.find((e) => sameScope(e, it) && sameSet(e.target, it.target));
    if (existing) {
      if (!upsert) return new Reply(400, { error: { code: "ENV_ALREADY_EXISTS", key: it.key, message: "already exists" } });
      existing.value = it.value;
      existing.updatedAt = Math.max(Date.now(), existing.createdAt + 1);
      created.push(existing);
      continue;
    }
    const now = Date.now();
    const env: VercelEnv = {
      id: core.nextId("env_"),
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
  return new Reply(200, { created: created.map(publicEnv), failed });
}

/**
 * Every deployment gets its own URL: the first one of a sha is `<project>-<sha8>.vercel.app`, later ones
 * (redeploys) `-2`, `-3`, … `buildMs` > 0 starts it QUEUED and makes it reach `state` over that time.
 */
export function createDeployment(core: SimCore, projectId: string, project: VercelProject, sha: string, state: DeploymentState, createdAt: number, opts: { ref?: string; buildMs?: number } = {}): VercelDeployment {
  const n = project.deployments.filter((d) => d.meta.githubCommitSha === sha).length + 1;
  const buildMs = opts.buildMs ?? 0;
  const d: VercelDeployment = {
    uid: core.nextId("dpl_"),
    url: `${projectId}-${sha.slice(0, 8)}${n > 1 ? `-${n}` : ""}.vercel.app`,
    state: buildMs > 0 ? "QUEUED" : state,
    createdAt,
    ...(buildMs > 0 ? { buildingAt: createdAt + buildMs / 3, readyAt: createdAt + buildMs, finalState: state } : {}),
    meta: { githubCommitSha: sha, ...(opts.ref ? { githubCommitRef: opts.ref } : {}) },
    createdBy: "api",
  };
  if (core.chaos.deploy === "cancel" && opts.ref) {
    // Vercel's auto-cancel: a new build on a branch cancels the builds of that branch still in progress.
    refreshDeployments(project.deployments, createdAt);
    for (const old of project.deployments) {
      if (old.meta.githubCommitRef === opts.ref && (old.state === "QUEUED" || old.state === "BUILDING")) {
        old.state = "CANCELED";
        delete old.finalState;
      }
    }
  }
  project.deployments.push(d);
  return d;
}

/** Advance in-progress deployments to the state their timings say they are in now. */
export function refreshDeployments(list: VercelDeployment[], now = Date.now()): void {
  for (const d of list) {
    if (d.state !== "QUEUED" && d.state !== "BUILDING") continue;
    if (d.readyAt !== undefined && now >= d.readyAt) {
      d.state = d.finalState ?? "READY";
      delete d.finalState;
    } else if (d.state === "QUEUED" && (d.buildingAt === undefined || now >= d.buildingAt)) d.state = "BUILDING";
  }
}

/** Stand-in for Vercel's git integration: the first lookup of a sha "triggers" its auto-deploy per the chaos mode. */
function autoDeploy(core: SimCore, projectId: string, p: VercelProject, sha: string): void {
  const mode = core.chaos.deploy;
  const now = Date.now();
  if (mode === "never") return;
  if (mode === "fail") {
    createDeployment(core, projectId, p, sha, "ERROR", now);
    return;
  }
  if (mode === "stale") {
    createDeployment(core, projectId, p, sha, "READY", now - 60_000);
    return;
  }
  if (mode === "double") {
    createDeployment(core, projectId, p, sha, "READY", now - 1_000);
    createDeployment(core, projectId, p, sha, "READY", now);
    return;
  }
  const delay = mode.match(/^delay:(\d+(?:\.\d+)?)$/);
  if (delay) {
    const d = createDeployment(core, projectId, p, sha, "BUILDING", now);
    d.readyAt = now + Number(delay[1]) * 1000;
    return;
  }
  createDeployment(core, projectId, p, sha, "READY", now, { buildMs: core.chaos.deploy_ms });
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

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
