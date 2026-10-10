import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, sha256, type AdapterContext, type Ctx, type Literal, type OpSpec, type ResolvedParams, type ResourceAdapter, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { ABSENT, assertNoPending, clientFor, deleteIgnoringNotFound, diffValue, optionalEnv, optionalProvider, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isTransient, listAll, obj, records, type ApiClient, type Page } from "./http.js";

/** The environment vercel reads; declared once, used by the code below and by the generated docs. */
const ABOUT = { credentialEnv: "VERCEL_TOKEN", baseUrlEnv: "VERCEL_API_URL" } as const;

/** Vercel's API base URL; `VERCEL_API_URL` overrides it (the sim and tests use that). */
export const VERCEL_DEFAULT_API_URL = "https://api.vercel.com";

const TARGETS = ["preview", "production", "development"] as const;
type Target = (typeof TARGETS)[number];
/** The `gitBranch` dimension of a project-wide variable, in keys and params. */
const ALL_BRANCHES = "*";

interface VercelEnv {
  id: string;
  key: string;
  value?: string;
  target: string[];
  gitBranch?: string;
  /** `encrypted`, `plain`, `sensitive`, … A `sensitive` value is never returned by the API. */
  type?: string;
  /** Whether `value` is the plaintext (`decrypted` in the API's env objects). */
  decrypted?: boolean;
}

/** `readyState` values (OpenAPI: GET /v7/deployments, GET /v13/deployments/{idOrUrl}). */
type DeploymentState = "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "BLOCKED" | "DELETED";

/**
 * Which deployments a lookup may return. A deployment's `target` is `production` or null for previews (OpenAPI:
 * GET /v7/deployments, item `target`); a custom environment (`staging`) is neither, so it never matches.
 */
type DeployTarget = "production" | "preview";

/** The deployments that carry a line's values: production for the production target, previews otherwise. */
function deployTargetFor(target: string): DeployTarget {
  return target === "production" ? "production" : "preview";
}

interface Deployment {
  uid: string;
  target: DeployTarget | "other";
  /** Absent until the deployment's upload is complete (GET /v7/deployments) or in POST's lean answer. */
  url?: string;
  state: DeploymentState;
  createdAt: number;
}

interface Client {
  api: ApiClient;
  project: string;
  team: string | undefined;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, "vercel");
  const project = requireProvider(actx, "project", "vercel");
  return { api: clientFor(actx, "vercel", { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? VERCEL_DEFAULT_API_URL, token }), project, team: optionalProvider(actx, "team") };
}

function query(c: Client, extra: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  if (c.team) q.set("teamId", c.team);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

function targetFor(env: string): Target {
  return env === "production" ? "production" : "preview";
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

function parseEnvs(v: unknown, what: string): VercelEnv[] {
  return records(v, what, ["id", "key"]).map((e, i) => {
    const target = typeof e.target === "string" ? [e.target] : e.target;
    if (!Array.isArray(target) || !target.every((t) => typeof t === "string")) throw new ShapeError(`expected ${what}[${i}].target to be a list of targets`);
    return {
      id: e.id,
      key: e.key,
      target: target as string[],
      ...(typeof e.value === "string" ? { value: e.value } : {}),
      ...(typeof e.gitBranch === "string" && e.gitBranch !== "" ? { gitBranch: e.gitBranch } : {}),
      ...(typeof e.type === "string" ? { type: e.type } : {}),
      ...(typeof e.decrypted === "boolean" ? { decrypted: e.decrypted } : {}),
    };
  });
}

/**
 * The plaintext of a listed variable when the list carries it: `plain` vars always, others only when the API says
 * `decrypted: true`. Undefined means "ask GET /v1/projects/:id/env/:id" (or, for `sensitive`, unknowable).
 */
function plaintext(e: VercelEnv): string | undefined {
  if (e.value === undefined) return undefined;
  return e.type === "plain" || e.decrypted === true ? e.value : undefined;
}

/**
 * `{ envs, pagination: { next } }`. The OpenAPI spec defines the `pagination` object for this endpoint but no
 * page parameter; `?until=<next>` is the convention of Vercel's other lists. listEnvs drops repeats, so an API
 * that ignores `until` costs one extra request, not duplicate records.
 */
function envPage(body: unknown): Page<VercelEnv> {
  const o = obj(body, "the env list");
  const items = parseEnvs(o.envs, "`envs`");
  const p = o.pagination;
  const next = p && typeof p === "object" ? (p as Record<string, unknown>).next : undefined;
  return { items, next: typeof next === "number" || (typeof next === "string" && next !== "") ? { until: String(next) } : null };
}

/** GET /v7/deployments: `readyState` is required by the spec, `state` optional; `url` is null until the upload completes. */
function parseDeployments(body: unknown): Deployment[] {
  return records(obj(body, "the deployment list").deployments, "`deployments`", ["uid"]).map((d, i) => {
    if (typeof d.createdAt !== "number") throw new ShapeError(`expected deployments[${i}].createdAt to be a number`);
    const state = typeof d.readyState === "string" ? d.readyState : d.state;
    if (typeof state !== "string") throw new ShapeError(`expected deployments[${i}].readyState to be a string`);
    return { uid: d.uid, target: targetOf(d.target), ...(typeof d.url === "string" && d.url !== "" ? { url: d.url } : {}), state: state as DeploymentState, createdAt: d.createdAt };
  });
}

/** POST /v13/deployments and GET /v13/deployments/:id answer `{ id, readyState, url? }` (POST's lean variant has no `url`). */
function parseDeploymentDetail(body: unknown): Deployment {
  const [d] = records([body], "the deployment", ["id", "readyState"]);
  return { uid: d!.id, target: targetOf(d!.target), ...(typeof d!.url === "string" && d!.url !== "" ? { url: d!.url } : {}), state: d!.readyState as DeploymentState, createdAt: typeof d!.createdAt === "number" ? d!.createdAt : Date.now() };
}

function targetOf(v: unknown): Deployment["target"] {
  return v === "production" ? "production" : v === null || v === undefined ? "preview" : "other";
}

interface UpsertResult {
  created: VercelEnv[];
  failedKeys: string[];
}

/** `{ created: env | env[], failed: [{ error: { key, code, message } }] }`. Messages are dropped: they can echo values. */
function parseUpsert(body: unknown): UpsertResult {
  const o = obj(body, "the upsert response");
  const created = o.created === undefined ? [] : parseEnvs(Array.isArray(o.created) ? o.created : [o.created], "`created`");
  const failed = o.failed === undefined ? [] : o.failed;
  if (!Array.isArray(failed)) throw new ShapeError("expected `failed` to be a list");
  const failedKeys = failed.map((f) => {
    const err = f && typeof f === "object" ? (f as Record<string, unknown>).error : undefined;
    const e = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
    // The spec's failure object names the variable as `key` or `envVarKey`.
    const key = typeof e.key === "string" ? e.key : e.envVarKey;
    return typeof key === "string" ? key : "(unnamed)";
  });
  return { created, failedKeys };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Every variable of the project, once each (by id). `decrypt=true` is deprecated in the spec but still listed. */
async function listEnvs(c: Client): Promise<VercelEnv[]> {
  const all = await listAll(c.api, `/v10/projects/${c.project}/env${query(c, { decrypt: "true" })}`, envPage);
  const seen = new Set<string>();
  return all.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/**
 * The value to compare a declared variable by: the listed plaintext, else the decrypted value from
 * GET /v1/projects/:id/env/:id ("Retrieve the decrypted value of an environment variable"). A `sensitive`
 * variable's value is never readable, so it hashes as "" and always diffs as an update.
 */
async function comparableValue(c: Client, e: VercelEnv): Promise<string> {
  const listed = plaintext(e);
  if (listed !== undefined || e.type === "sensitive") return listed ?? "";
  const one = await c.api.get(`/v1/projects/${c.project}/env/${encodeURIComponent(e.id)}${query(c)}`, (body) => parseEnvs([body], "the env var")[0]!);
  return plaintext(one) ?? "";
}

/**
 * GET /v7/deployments of one commit in one environment (`sha` and `target` are documented v7 filters). The result is
 * filtered again by each item's `target`, so a preview build of a commit is never mistaken for its production build.
 */
async function deploymentsFor(c: Client, sha: string, target: DeployTarget): Promise<Deployment[]> {
  const list = await c.api.get(`/v7/deployments${query(c, { projectId: c.project, sha, target, limit: "20" })}`, parseDeployments);
  return list.filter((d) => d.target === target);
}

function newest(list: Deployment[]): Deployment | undefined {
  return list.reduce<Deployment | undefined>((best, d) => (!best || d.createdAt > best.createdAt ? d : best), undefined);
}

/** States a deployment does not leave by itself. BLOCKED needs someone to act in Vercel; DELETED is gone. */
const FAILED_STATES: ReadonlySet<string> = new Set(["ERROR", "CANCELED", "BLOCKED", "DELETED"]);

function deploymentFailed(d: Deployment): SponsonError {
  return new SponsonError("PROVIDER_INVALID", `vercel: deployment ${d.uid} ended ${d.state}; it will not become ready`, { adapter: "vercel", deployment: d.uid, state: d.state });
}

/**
 * The `gitSource` of POST /v13/deployments for this project's connected repository. The spec requires the
 * repository's identity (`repoId`, GitLab `projectId`, Bitbucket `repoUuid`) next to `ref`; it comes from the
 * project's `link` (GET /v9/projects/:id).
 */
async function gitSourceFor(c: Client, ctx: Ctx): Promise<Record<string, unknown>> {
  const link = await c.api.get(`/v9/projects/${c.project}${query(c)}`, (body) => {
    const l = obj(body, "the project").link;
    return l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : undefined;
  });
  const at = { ref: ctx.git.branch, sha: ctx.git.sha };
  const id = (v: unknown) => typeof v === "string" || typeof v === "number";
  if ((link?.type === "github" || link?.type === "github-limited") && id(link.repoId)) return { type: link.type, repoId: link.repoId, ...at };
  if (link?.type === "gitlab" && id(link.projectId)) return { type: "gitlab", projectId: link.projectId, ...at };
  if (link?.type === "bitbucket" && typeof link.uuid === "string") return { type: "bitbucket", repoUuid: link.uuid, ...(typeof link.workspaceUuid === "string" ? { workspaceUuid: link.workspaceUuid } : {}), ...at };
  throw new SponsonError(
    "PROVIDER_INVALID",
    `vercel: project ${c.project} is ${link ? `connected to a ${String(link.type)} repository, which Sponson cannot deploy from` : "not connected to a Git repository"}; Sponson deploys a commit through the project's GitHub, GitLab or Bitbucket connection`,
    { adapter: "vercel", project: c.project },
  );
}

/** A new build of this commit. `forceNew=1`: Vercel may otherwise answer with an earlier deployment of the same commit. */
async function triggerDeploy(c: Client, ctx: Ctx, target: DeployTarget): Promise<Deployment> {
  const body = {
    name: c.project,
    project: c.project,
    gitSource: await gitSourceFor(c, ctx),
    ...(target === "production" ? { target: "production" } : {}),
  };
  return c.api.post(`/v13/deployments${query(c, { forceNew: "1" })}`, body, parseDeploymentDetail);
}

// ---------------------------------------------------------------------------
// op: env
// ---------------------------------------------------------------------------

interface EnvScope {
  target: Target;
  /** Git branch for branch-scoped preview vars; undefined for project-wide ones. */
  branch: string | undefined;
  values: Record<string, unknown>;
}

function envScope(params: ResolvedParams): EnvScope {
  const target = stringParam(params, "target", "vercel", "preview");
  if (!(TARGETS as readonly string[]).includes(target)) throw paramError("vercel", `param \`target\` must be one of ${TARGETS.join(", ")} (got ${JSON.stringify(target)})`, "target");
  const rawBranch = params.branch;
  if (rawBranch !== undefined && rawBranch !== null && typeof rawBranch !== "string") throw paramError("vercel", "param `branch` must be a string", "branch");
  const branch = typeof rawBranch === "string" && rawBranch !== "" && rawBranch !== ALL_BRANCHES ? rawBranch : undefined;
  if (branch !== undefined && target !== "preview") throw paramError("vercel", `param \`branch\` only applies to target preview (got target ${target})`, "branch");
  const values = params.values;
  if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) throw paramError("vercel", "param `values` must be an object of NAME → value", "values");
  return { target: target as Target, branch, values: (values ?? {}) as Record<string, unknown> };
}

/** Identity: target, git branch (`*` = project-wide) and name. Two records differing in any of them are different resources. */
function envKey(target: string, branch: string | undefined, name: string): string {
  return `env:${target}:${branch ?? ALL_BRANCHES}:${name}`;
}

/** Inverse of envKey. A variable name never contains `:`; a git branch may. */
function parseEnvKey(key: string): { target: string; branch: string; name: string } {
  const [kind, target] = key.split(":", 2);
  const last = key.lastIndexOf(":");
  const branchAt = (kind?.length ?? 0) + (target?.length ?? 0) + 2;
  if (kind !== "env" || !target || last < branchAt) throw new SponsonError("INTERNAL", `vercel: \`${key}\` is not an env key`, { adapter: "vercel", key });
  return { target, branch: key.slice(branchAt, last), name: key.slice(last + 1) };
}

function envLabel(scope: EnvScope, name: string): string {
  return `${name} (${scope.target}${scope.branch ? `, ${scope.branch}` : ""})`;
}

function envRecord(target: string, e: VercelEnv, hash: string): ResourceRecord {
  return { key: envKey(target, e.gitBranch, e.key), id: e.id, hash, label: `${e.key} (${target}${e.gitBranch ? `, ${e.gitBranch}` : ""})` };
}

/** Records this line's target+branch sees: the target is among the record's targets and the git branch is the same. */
function inScope(e: VercelEnv, scope: EnvScope): boolean {
  return e.target.includes(scope.target) && e.gitBranch === scope.branch;
}

/**
 * One record shared by several targets cannot be managed by a line that owns one target: writing our target would
 * either create a second record (two effective values) or patch the other targets behind the user's back.
 */
function refuseShared(e: VercelEnv, scope: EnvScope): SponsonError {
  return new SponsonError(
    "PROVIDER_CONFLICT",
    `vercel: ${e.key} is a single variable shared by targets ${e.target.join(", ")}; this line manages only ${scope.target}. ` +
      `Split it in the Vercel dashboard into one variable per environment, then run again.`,
    { adapter: "vercel", key: envKey(scope.target, scope.branch, e.key), targets: e.target },
  );
}

const env: OpSpec = {
  outputs: {
    preview_url: { available: "external", event: "deploy" },
    deployment_id: { available: "external", event: "deploy" },
  },

  defaults(params, ctx) {
    const target = (params.target as string | undefined) ?? targetFor(ctx.env);
    const out: ResolvedParams = { ...params, target };
    if (target === "preview" && out.branch === undefined) out.branch = ctx.git.branch;
    return out;
  },

  writesEnvironment(params, ctx) {
    return typeof params.target === "string" ? params.target : targetFor(ctx.env);
  },

  async read(actx, params) {
    const scope = envScope(params);
    const c = client(actx);
    const live = (await listEnvs(c)).filter((e) => inScope(e, scope));
    const resources: ResourceRecord[] = [];
    for (const name of Object.keys(scope.values)) {
      const e = live.find((x) => x.key === name);
      if (!e) continue;
      if (e.target.length !== 1) throw refuseShared(e, scope);
      resources.push(envRecord(scope.target, e, sha256(await comparableValue(c, e))));
    }
    if (resources.length === 0) return null;
    return { resources, outputs: {} };
  },

  diff(live, params) {
    const scope = envScope(params);
    const byKey = new Map((live?.resources ?? []).map((r) => [r.key, r]));
    return Object.entries(scope.values).map(([name, desired]) => {
      const key = envKey(scope.target, scope.branch, name);
      return diffValue({ key, label: envLabel(scope, name), live: byKey.get(key), desired, sensitive: true });
    });
  },

  async apply(actx, params, live) {
    assertNoPending(params, "vercel");
    const scope = envScope(params);
    const c = client(actx);
    const diffs = env.diff(live, params);
    const keyOf = (name: string) => envKey(scope.target, scope.branch, name);
    const kindOf = new Map(diffs.map((d) => [d.key, d.kind]));
    const toWrite = Object.entries(scope.values).filter(([name]) => kindOf.get(keyOf(name)) !== "unchanged");
    const creating = toWrite.map(([name]) => keyOf(name)).filter((k) => kindOf.get(k) === "create");

    const byKey = new Map((live?.resources ?? []).map((r) => [r.key, r]));
    let notes: Record<string, unknown> | undefined;
    if (toWrite.length > 0) {
      if (creating.length > 0) await actx.intend(creating);
      const startedAt = Date.now();
      const body = toWrite.map(([key, value]) => ({ key, value: String(value), type: "encrypted", target: [scope.target], ...(scope.branch ? { gitBranch: scope.branch } : {}) }));
      actx.log(`upsert ${body.length} env var(s) in ${scope.target}${scope.branch ? ` for ${scope.branch}` : ""}`);
      const path = `/v10/projects/${c.project}/env${query(c, { upsert: "true" })}`;
      const r = await c.api.post(path, body, parseUpsert);
      // A bulk upsert answers 200 even when some entries were rejected.
      if (r.failedKeys.length > 0) {
        throw new SponsonError("PROVIDER_INVALID", `vercel: the bulk upsert rejected ${r.failedKeys.length} env var(s): ${r.failedKeys.join(", ")}`, {
          adapter: "vercel",
          method: "POST",
          path,
          keys: r.failedKeys,
        });
      }
      // Trust the write's answer for ids: a list right after a write may not show it yet.
      for (const [name, value] of toWrite) {
        const written = r.created.find((e) => e.key === name && inScope(e, scope));
        if (!written) throw new SponsonError("PROVIDER_RESPONSE", `vercel: POST ${path} → 200: the upsert response does not list ${name}`, { adapter: "vercel", method: "POST", path, key: name });
        byKey.set(keyOf(name), envRecord(scope.target, written, sha256(String(value))));
      }

      // Vercel may have started building this sha before the vars landed; that build would miss them.
      const target = deployTargetFor(scope.target);
      const d = newest(await deploymentsFor(c, actx.ctx.git.sha, target));
      if (d && d.createdAt < startedAt && !FAILED_STATES.has(d.state)) {
        actx.log(`deployment ${d.uid} predates env write; redeploying`);
        await triggerDeploy(c, actx.ctx, target);
        notes = { redeployed: true };
      }
    }

    const resources = Object.keys(scope.values).map((name) => {
      const rec = byKey.get(keyOf(name));
      if (!rec) throw new SponsonError("INTERNAL", `vercel: no record for ${name} after apply`, { adapter: "vercel", key: keyOf(name) });
      return rec;
    });
    return { resources, outputs: {}, created: creating, ...(notes ? { notes } : {}) };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(c.api, `/v9/projects/${c.project}/env/${encodeURIComponent(r.id)}${query(c)}`);
  },

  /** Every var this line's deployments see in its target: those for its git branch and the project-wide ones. */
  async listScope(actx, params) {
    const scope = envScope(params);
    const c = client(actx);
    return (await listEnvs(c))
      .filter((e) => e.target.includes(scope.target) && (e.gitBranch === undefined || e.gitBranch === scope.branch))
      .map((e) => envRecord(scope.target, e, sha256(plaintext(e) ?? "")));
  },

  /**
   * One line per (target, git branch), every variable `{ keep: true }`: Sponson takes over that they exist, never
   * their values. A project-wide variable is adopted as project-wide (`branch: "*"`), never re-created as a
   * branch-scoped copy; `branch` is omitted when it is the current git branch (the op's default).
   */
  adopt(resources, ctx) {
    const groups = new Map<string, { target: string; branch: string; values: Record<string, { keep: true }>; keys: string[] }>();
    for (const r of resources) {
      const { target, branch, name } = parseEnvKey(r.key);
      const id = `${target}\u0000${branch}`;
      const g = groups.get(id) ?? { target, branch, values: {}, keys: [] };
      g.values[name] = { keep: true };
      g.keys.push(r.key);
      groups.set(id, g);
    }
    return [...groups.values()].map(({ target, branch, values, keys }) => {
      const current = branch === ctx.git.branch;
      const suffix = branch === ALL_BRANCHES ? "-shared" : current ? "" : `-${branch}`;
      return { id: `env-${target}${suffix}`, params: { target, ...(current ? {} : { branch }), values }, keys };
    });
  },

  async awaitExternal(actx, params) {
    const c = client(actx);
    let list: Deployment[];
    try {
      list = await deploymentsFor(c, actx.ctx.git.sha, deployTargetFor(envScope(params).target));
    } catch (e) {
      // The HTTP layer already retried; a provider that is still unavailable means "not known yet", not "failed".
      if (isTransient(e)) return null;
      throw e;
    }
    const d = newest(list);
    if (!d) return null;
    if (d.state === "READY" && d.url) return deployOutputs(d);
    if (FAILED_STATES.has(d.state)) throw deploymentFailed(d);
    return null;
  },
};

// ---------------------------------------------------------------------------
// op: deploy
// ---------------------------------------------------------------------------

/** The `deploy` op builds for the run's environment: production under `--env production`, a preview otherwise. */
function deployOpTarget(ctx: Ctx): DeployTarget {
  return ctx.env === "production" ? "production" : "preview";
}

/** Identity: environment and commit — a commit's production and preview deployments are different resources. */
function deployKey(sha: string, target: DeployTarget): string {
  return `deployment:${target}:${sha}`;
}

function deployRecord(sha: string, target: DeployTarget, d: Deployment): ResourceRecord {
  return { key: deployKey(sha, target), id: d.uid, hash: sha256(d.uid), label: `${target} deployment ${d.uid}` };
}

function deployOutputs(d: Deployment): Record<string, Literal> {
  if (!d.url) throw new SponsonError("PROVIDER_RESPONSE", `vercel: deployment ${d.uid} is READY but has no \`url\``, { adapter: "vercel", deployment: d.uid });
  return { preview_url: `https://${d.url}`, deployment_id: d.uid };
}

/** Watch one deployment until READY. Transient status errors are waited through; ERROR/CANCELED end it. */
async function untilReady(c: Client, actx: AdapterContext, first: Deployment): Promise<Deployment> {
  const timeout = Number(actx.env.SPONSON_DEPLOY_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeout;
  let d = first;
  for (;;) {
    if (d.state === "READY" && d.url) return d;
    if (FAILED_STATES.has(d.state)) throw deploymentFailed(d);
    if (Date.now() > deadline) throw new SponsonError("WAIT_TIMEOUT", `vercel: deployment ${d.uid} not ready after ${timeout}ms (still ${d.state}); run again to keep watching it`, { adapter: "vercel", deployment: d.uid, state: d.state });
    await sleep(Math.min(200, Math.max(0, deadline - Date.now()) + 1));
    try {
      d = { ...(await c.api.get(`/v13/deployments/${encodeURIComponent(d.uid)}${query(c)}`, parseDeploymentDetail)), createdAt: d.createdAt };
    } catch (e) {
      if (!isTransient(e)) throw e;
    }
  }
}

const deploy: OpSpec = {
  outputs: {
    preview_url: { available: "immediate" },
    deployment_id: { available: "immediate" },
  },

  writesEnvironment(_params, ctx) {
    return deployOpTarget(ctx);
  },

  /** The newest deployment of this sha that has not failed, finished or not: a build in progress is not a reason for another. */
  async read(actx) {
    const c = client(actx);
    const target = deployOpTarget(actx.ctx);
    const d = newest((await deploymentsFor(c, actx.ctx.git.sha, target)).filter((x) => !FAILED_STATES.has(x.state)));
    if (!d) return null;
    return { resources: [deployRecord(actx.ctx.git.sha, target, d)], outputs: d.state === "READY" && d.url ? deployOutputs(d) : {} };
  },

  diff(live): ResourceDiff[] {
    const r = live?.resources[0];
    if (r && live.outputs.preview_url !== undefined) return [{ key: r.key, kind: "unchanged", label: r.label ?? r.key }];
    // In progress: apply watches it rather than starting another.
    if (r) return [{ key: r.key, kind: "update", label: r.label ?? r.key, before: { state: "literal", value: "building" }, after: { state: "literal", value: "ready" } }];
    return [{ key: "deployment:(new)", kind: "create", label: "deployment", before: ABSENT, after: { state: "literal", value: "new deployment" } }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, "vercel");
    const c = client(actx);
    const sha = actx.ctx.git.sha;
    const target = deployOpTarget(actx.ctx);
    const existing = live?.resources[0];
    if (existing && live.outputs.preview_url !== undefined) return { resources: live.resources, outputs: live.outputs, created: [] };

    let start: Deployment;
    const created: string[] = [];
    if (existing) {
      actx.log(`deployment ${existing.id} for ${sha} is in progress; watching it`);
      start = { uid: existing.id, target, state: "BUILDING", createdAt: 0 };
    } else {
      await actx.intend([deployKey(sha, target)]);
      actx.log(`deploy ${sha} (${target})`);
      start = await triggerDeploy(c, actx.ctx, target);
      created.push(deployKey(sha, target));
    }
    const d = await untilReady(c, actx, start);
    return { resources: [deployRecord(sha, target, d)], outputs: deployOutputs(d), created };
  },

  // Deployments are history; Vercel keeps them and so do we.
  async destroy() {},
};

/**
 * Vercel: op `env` manages environment variables per target and git branch; op `deploy` triggers or watches a
 * deployment and outputs its `preview_url`. Needs `VERCEL_TOKEN` and `providers.vercel.project`.
 */
export const vercelAdapter: ResourceAdapter = { name: "vercel", ops: { env, deploy }, about: ABOUT };
