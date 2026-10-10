/**
 * Simulated Vercel: project env vars and deployments.
 *
 * Assumptions about the real API that this fake encodes, each marked with how far it is checked. "Verified" means
 * against Vercel's published OpenAPI document (https://openapi.vercel.sh/, fetched 2026-10-10); see
 * docs/api-verification.md for the per-call table. A local fake cannot prove the rest; scenarios/contract.test.ts
 * pins the critical ones against live accounts (`pnpm test:live`):
 *   V1. Env writes are visible to the next deployment immediately (no propagation delay). Lists are
 *       read-your-writes here; the real list may lag a write, so adapters trust write responses instead.
 *       Unverified: needs a live account.
 *   V2. GET /v7/deployments?projectId=&sha= filters by commit and returns newest first. The `sha` filter is
 *       verified (a v7 query parameter; v6 is not in the spec); items carry `readyState` (required) and `state`
 *       (optional), and `url` may be null until the upload completes (verified). The order is unverified: the
 *       adapter sorts by createdAt anyway.
 *   V3. GET /v10/projects/:id/env?decrypt=true returns plaintext with `decrypted: true`; without `decrypt`,
 *       `encrypted` values are opaque. `decrypt` (deprecated), `decrypted` and GET /v1/projects/:id/env/:id
 *       ("Retrieve the decrypted value") are verified; whether the deprecated parameter still decrypts is
 *       unverified, so the adapter falls back to the per-variable GET. `sensitive` values are never returned
 *       (the GET /v1 variant without `value`), so those always diff as `update`.
 *   V4. POST /v10/projects/:id/env?upsert=true answers 201 with `{ created, failed }` (verified: `upsert`, the
 *       status, `created` as one object or a list, `failed[].error` with `code`, `message`, `key`/`envVarKey`).
 *       Unverified: that `created` lists every entry written (new or updated, `createdAt === updatedAt` only for
 *       new ones), and that an entry whose key+gitBranch exists with an overlapping but different target set
 *       fails the whole request with 400 `ENV_CONFLICT`. Entries named in chaos `env_upsert_fail` come back under
 *       `failed` and are not written. Without `upsert` a duplicate answers 403 (verified: documented 403 reason).
 *   V5. POST /v13/deployments: `project` overrides `name` and a GitHub `gitSource` needs `ref` plus `repoId` (or
 *       `org` + `repo`) — both verified, as is `forceNew`. Deployments go QUEUED → BUILDING → READY over chaos
 *       `deploy_ms` (default 0: READY at once; the real API also passes through INITIALIZING, which the adapter
 *       handles as in progress). Every deployment has its own URL (verified: "the unique URL of the deployment").
 *       `deploy: cancel` cancels a branch's in-progress builds when a new one starts (unverified).
 *   V6. Pagination (chaos `page_size`): `{ envs, pagination: { count, next, prev } }` (verified: the spec's
 *       Pagination schema). The `?until=` page parameter is unverified for the env list, which documents no page
 *       parameter; the adapter drops repeated records, so an API that ignores it costs one extra request.
 *   V7. GET /v9/projects/:id carries `link`, the connected repository (`type`, `repoId`, …); verified.
 *   V8. GET /v7/deployments accepts `target` (`production` | `preview`) and each item's `target` is `production`,
 *       a custom environment name such as `staging`, or null for a preview; verified against the spec's
 *       `/v7/deployments` parameters and item schema. The git integration builds previews; production builds
 *       of a commit exist separately.
 */
import { page, Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

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
  /** `production` for production deployments, null for previews. */
  target: "production" | null;
  createdBy: CreatedBy;
}

/** The Git repository a project is connected to (`link` in GET /v9/projects/:id); null when it has none. */
export interface VercelLink {
  type: "github";
  repoId: number;
  org: string;
  repo: string;
  productionBranch: string;
}

/** One simulated Vercel project: its variables, deployments and Git connection. */
export interface VercelProject {
  envs: VercelEnv[];
  deployments: VercelDeployment[];
  link: VercelLink | null;
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
      const project: VercelProject = { envs: [], deployments: [], link: { type: "github", repoId: 100000 + Object.keys(state.projects).length, org: "sim", repo: id, productionBranch: "main" } };
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

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

const routes = router<VercelState>(
  [
    route("GET", "/v9/projects/:project", ({ state, params }) => {
      const p = state.projects[params.project];
      if (!p) return notFound("project");
      return new Reply(200, { id: params.project, name: params.project, ...(p.link ? { link: p.link } : {}) });
    }),

    route("GET", "/v10/projects/:project/env", ({ core, state, params, url }) => {
      const p = state.projects[params.project];
      if (!p) return notFound("project");
      const decrypt = url.searchParams.get("decrypt") === "true";
      const pg = page(core, p.envs, url.searchParams.get("until"));
      return new Reply(200, { envs: pg.items.map((e) => listedEnv(e, decrypt)), pagination: { count: pg.items.length, next: pg.next, prev: null } });
    }),

    route("POST", "/v10/projects/:project/env", ({ core, state, params, url, body }) => {
      const p = state.projects[params.project];
      if (!p) return notFound("project");
      return upsertEnvs(core, p, Array.isArray(body) ? body : [body], url.searchParams.get("upsert") === "true");
    }),

    route("GET", "/v1/projects/:project/env/:id", ({ state, params }) => {
      const env = state.projects[params.project]?.envs.find((e) => e.id === params.id);
      return env ? new Reply(200, listedEnv(env, true)) : notFound("env");
    }),

    route("PATCH", "/v9/projects/:project/env/:id", ({ state, params, body }) => {
      const p = state.projects[params.project];
      if (!p) return notFound("project");
      const env = p.envs.find((e) => e.id === params.id);
      if (!env) return notFound("env");
      const b = (body ?? {}) as Partial<VercelEnv>;
      if (typeof b.value === "string") env.value = b.value;
      env.updatedAt = Date.now();
      return new Reply(200, publicEnv(env));
    }),

    route("DELETE", "/v9/projects/:project/env/:id", ({ state, params }) => {
      const p = state.projects[params.project];
      if (!p) return notFound("project");
      const env = p.envs.find((e) => e.id === params.id);
      if (!env) return notFound("env");
      p.envs = p.envs.filter((e) => e !== env);
      return new Reply(200, publicEnv(env));
    }),

    route("GET", "/v7/deployments", ({ core, state, url }) => listDeployments(core, state, url)),
    route("POST", "/v13/deployments", ({ core, state, body }) => postDeployment(core, state, body)),

    route("GET", "/v13/deployments/:id", ({ state, params }) => {
      for (const p of Object.values(state.projects)) {
        refreshDeployments(p.deployments);
        const d = p.deployments.find((x) => x.uid === params.id);
        if (d) return new Reply(200, deploymentDetail(d));
      }
      return notFound("deployment");
    }),
  ],
  () => notFound("route"),
);

/**
 * `GET /v7/deployments?projectId&sha&target&limit`. `target`: production → production deployments; preview →
 * deployments whose target is null (previews). Asking for a sha the project has not deployed yet triggers the
 * git integration's automatic deployment, as a push would have.
 */
function listDeployments(core: SimCore, state: VercelState, url: URL): Reply {
  const projectId = url.searchParams.get("projectId") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  const target = url.searchParams.get("target");
  const inTarget = (d: VercelDeployment) => target === null || (target === "production" ? d.target === "production" : target === "preview" ? d.target === null : false);
  const p = state.projects[projectId];
  if (!p) return notFound("project");
  if (sha && !p.deployments.some((d) => d.meta.githubCommitSha === sha && inTarget(d))) autoDeploy(core, projectId, p, sha, target === "production" ? "production" : undefined);
  refreshDeployments(p.deployments);
  const list = p.deployments.filter((d) => (!sha || d.meta.githubCommitSha === sha) && inTarget(d)).sort((a, b) => b.createdAt - a.createdAt);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const items = list.slice(0, limit);
  return new Reply(200, { deployments: items.map((d) => publicDeployment(projectId, d)), pagination: { count: items.length, next: list.length > limit ? (items.at(-1)?.createdAt ?? null) : null, prev: null } });
}

/** A GitHub `gitSource` naming a ref and the repository, by id or by org and repo. */
type GitSource = { type: "github"; ref: string; repoId?: unknown; org?: string; repo?: string; sha?: string };

function isGitSource(g: { type?: string; repoId?: unknown; org?: string; repo?: string; ref?: string } | undefined): g is GitSource {
  if (!g || g.type !== "github" || typeof g.ref !== "string") return false;
  return g.repoId !== undefined || (typeof g.org === "string" && typeof g.repo === "string");
}

/** `POST /v13/deployments`: a (re)deployment from a git source of the project's connected repository. */
function postDeployment(core: SimCore, state: VercelState, body: unknown): Reply {
  const b = (body ?? {}) as { name?: string; project?: string; target?: string; gitSource?: { type?: string; repoId?: unknown; org?: string; repo?: string; sha?: string; ref?: string } };
  if (typeof b.name !== "string" || b.name === "") return badRequest("missing_name", "`name` is required");
  // `project`, when given, overrides `name`.
  const projectId = b.project ?? b.name;
  const p = state.projects[projectId];
  if (!p) return notFound("project");
  const g = b.gitSource;
  if (!isGitSource(g)) return badRequest("bad_request", "Invalid request: `gitSource` needs `type`, `ref` and `repoId` (or `org` and `repo`)");
  if (!p.link || (g.repoId !== undefined && String(g.repoId) !== String(p.link.repoId))) return badRequest("incorrect_git_source_info", "The repository is not connected to this project");
  const d = createDeployment(core, projectId, p, g.sha ?? "unknown", core.chaos.deploy === "fail" ? "ERROR" : "READY", Date.now(), {
    ref: g.ref,
    buildMs: core.chaos.deploy_ms,
    ...(b.target === "production" ? { target: "production" as const } : {}),
  });
  return new Reply(200, deploymentDetail(d));
}

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
  if (!body.every(isEnvInput)) return badRequest("bad_request", "bad env");
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
      // Without `upsert`, the spec documents 403 "cannot be created because it already exists".
      if (!upsert) return new Reply(403, { error: { code: "ENV_ALREADY_EXISTS", key: it.key, message: "already exists" } });
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
  return new Reply(201, { created: created.map(publicEnv), failed });
}

/**
 * Every deployment gets its own URL: the first one of a sha is `<project>-<sha8>.vercel.app`, later ones
 * (redeploys) `-2`, `-3`, … `buildMs` > 0 starts it QUEUED and makes it reach `state` over that time.
 */
export function createDeployment(core: SimCore, projectId: string, project: VercelProject, sha: string, state: DeploymentState, createdAt: number, opts: { ref?: string; buildMs?: number; target?: "production" } = {}): VercelDeployment {
  const n = project.deployments.filter((d) => d.meta.githubCommitSha === sha).length + 1;
  const buildMs = opts.buildMs ?? 0;
  const d: VercelDeployment = {
    uid: core.nextId("dpl_"),
    url: `${projectId}-${sha.slice(0, 8)}${n > 1 ? `-${n}` : ""}.vercel.app`,
    state: buildMs > 0 ? "QUEUED" : state,
    createdAt,
    ...(buildMs > 0 ? { buildingAt: createdAt + buildMs / 3, readyAt: createdAt + buildMs, finalState: state } : {}),
    meta: { githubCommitSha: sha, ...(opts.ref ? { githubCommitRef: opts.ref } : {}) },
    target: opts.target ?? null,
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
function autoDeploy(core: SimCore, projectId: string, p: VercelProject, sha: string, target?: "production"): void {
  const mode = core.chaos.deploy;
  const now = Date.now();
  // Vercel's git integration builds the production branch for production and every other push as a preview.
  const opts = target ? { target } : {};
  if (mode === "never") return;
  if (mode === "fail") {
    createDeployment(core, projectId, p, sha, "ERROR", now, opts);
    return;
  }
  if (mode === "stale") {
    createDeployment(core, projectId, p, sha, "READY", now - 60_000, opts);
    return;
  }
  if (mode === "double") {
    createDeployment(core, projectId, p, sha, "READY", now - 1_000, opts);
    createDeployment(core, projectId, p, sha, "READY", now, opts);
    return;
  }
  const delay = mode.match(/^delay:(\d+(?:\.\d+)?)$/);
  if (delay) {
    const d = createDeployment(core, projectId, p, sha, "BUILDING", now, opts);
    d.readyAt = now + Number(delay[1]) * 1000;
    return;
  }
  createDeployment(core, projectId, p, sha, "READY", now, { ...opts, buildMs: core.chaos.deploy_ms });
}

function publicEnv(e: VercelEnv) {
  const { createdBy: _c, ...rest } = e;
  return rest;
}

/** An item of GET /v7/deployments: `readyState` is the field the spec requires; `state` is optional there. */
function publicDeployment(projectId: string, d: VercelDeployment) {
  return { uid: d.uid, name: projectId, projectId, url: d.url, readyState: d.state, state: d.state, created: d.createdAt, createdAt: d.createdAt, target: d.target, meta: d.meta };
}

function deploymentDetail(d: VercelDeployment): { id: string; url: string; readyState: DeploymentState; createdAt: number; target: "production" | null } {
  return { id: d.uid, url: d.url, readyState: d.state, createdAt: d.createdAt, target: d.target };
}

/**
 * An env var as GET /v10/projects/:id/env (with `decrypt`) or GET /v1/projects/:id/env/:id (always decrypting)
 * shows it: an `encrypted` value is opaque unless decrypted, a `sensitive` one is never returned.
 */
function listedEnv(e: VercelEnv, decrypt: boolean) {
  const { createdBy: _c, value, ...rest } = e;
  if (e.type === "plain") return { ...rest, value, decrypted: false };
  return { ...rest, value: decrypt ? value : `enc:${Buffer.from(value).toString("base64")}`, decrypted: decrypt };
}

/** Vercel's error body: `{ error: { code, message } }`. */
function badRequest(code: string, message: string): Reply {
  return new Reply(400, { error: { code, message } });
}

function notFound(what: string): Reply {
  return new Reply(404, { error: { code: "not_found", message: `${what} not found` } });
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
