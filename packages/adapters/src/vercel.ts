import { sha256, type AdapterContext, type Literal, type OpSpec, type ResolvedParams, type ResourceAdapter, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { assertNoPending, deleteIgnoringNotFound, diffValue, optionalProvider, requireEnv, requireProvider, stringParam } from "./common.js";
import { apiClient, type ApiClient } from "./http.js";

export const VERCEL_DEFAULT_API_URL = "https://api.vercel.com";

const TARGETS = ["preview", "production", "development"] as const;
type Target = (typeof TARGETS)[number];

interface VercelEnv {
  id: string;
  key: string;
  value: string;
  target: string[];
  type: string;
  gitBranch?: string;
  createdAt: number;
  updatedAt: number;
}

interface Deployment {
  uid: string;
  url: string;
  state: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED";
  createdAt: number;
  meta?: { githubCommitSha?: string };
}

interface Client {
  api: ApiClient;
  project: string;
  team: string | undefined;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, "VERCEL_TOKEN", "vercel");
  const project = requireProvider(actx, "project", "vercel");
  return { api: apiClient({ baseUrl: actx.env.VERCEL_API_URL || VERCEL_DEFAULT_API_URL, token }), project, team: optionalProvider(actx, "team") };
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

function envKey(target: string, name: string): string {
  return `env:${target}:${name}`;
}

function envRecord(target: string, e: VercelEnv): ResourceRecord {
  return { key: envKey(target, e.key), id: e.id, hash: sha256(e.value), label: `${e.key} (${target}${e.gitBranch ? `, ${e.gitBranch}` : ""})` };
}

interface EnvScope {
  target: Target;
  branch: string | undefined;
  values: Record<string, unknown>;
}

function envScope(params: ResolvedParams): EnvScope {
  const target = stringParam(params, "target", "preview");
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error(`vercel: param \`target\` must be one of ${TARGETS.join(", ")} (got ${JSON.stringify(target)})`);
  const branch = typeof params.branch === "string" && params.branch !== "" ? params.branch : undefined;
  const values = params.values;
  if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) throw new Error("vercel: param `values` must be an object of NAME → value");
  return { target: target as Target, branch: target === "preview" ? branch : undefined, values: (values ?? {}) as Record<string, unknown> };
}

/** Envs that belong to this target and, for preview, exactly this git branch (or no branch when none is given). */
async function listEnvs(c: Client, scope: EnvScope): Promise<VercelEnv[]> {
  const r = await c.api.get<{ envs: VercelEnv[] }>(`/v9/projects/${c.project}/env${query(c, { decrypt: "true" })}`);
  return r.envs.filter((e) => e.target.includes(scope.target) && (e.gitBranch ?? undefined) === scope.branch);
}

async function deploymentsFor(c: Client, sha: string): Promise<Deployment[]> {
  const r = await c.api.get<{ deployments: Deployment[] }>(`/v6/deployments${query(c, { projectId: c.project, sha, limit: "20" })}`);
  return r.deployments;
}

function newest(list: Deployment[]): Deployment | undefined {
  return list.reduce<Deployment | undefined>((best, d) => (!best || d.createdAt > best.createdAt ? d : best), undefined);
}

async function triggerDeploy(c: Client, actx: AdapterContext): Promise<{ id: string; url: string; readyState: Deployment["state"] }> {
  const body = {
    name: c.project,
    project: c.project,
    gitSource: { type: "github", ref: actx.ctx.git.branch, sha: actx.ctx.git.sha },
    ...(actx.ctx.env === "production" ? { target: "production" } : {}),
  };
  return c.api.post(`/v13/deployments${query(c)}`, body);
}

// ---------------------------------------------------------------------------
// op: env
// ---------------------------------------------------------------------------

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

  async read(actx, params) {
    const c = client(actx);
    const scope = envScope(params);
    const live = await listEnvs(c, scope);
    const resources = Object.keys(scope.values)
      .map((k) => live.find((e) => e.key === k))
      .filter((e): e is VercelEnv => e !== undefined)
      .map((e) => envRecord(scope.target, e));
    if (resources.length === 0) return null;
    return { resources, outputs: {} };
  },

  diff(live, params) {
    const scope = envScope(params);
    const byKey = new Map((live?.resources ?? []).map((r) => [r.key, r]));
    return Object.entries(scope.values).map(([name, desired]) => {
      const key = envKey(scope.target, name);
      return diffValue({ key, label: `${name} (${scope.target})`, live: byKey.get(key), desired, sensitive: true });
    });
  },

  async apply(actx, params, live) {
    assertNoPending(params, "vercel");
    const c = client(actx);
    const scope = envScope(params);
    const diffs = env.diff(live, params);
    const toWrite = diffs.filter((d) => d.kind !== "unchanged");
    const created = diffs.filter((d) => d.kind === "create").map((d) => d.key);

    const startedAt = Date.now();
    let notes: Record<string, unknown> | undefined;
    if (toWrite.length > 0) {
      const names = new Set(toWrite.map((d) => d.key.slice(envKey(scope.target, "").length)));
      const body = Object.entries(scope.values)
        .filter(([name]) => names.has(name))
        .map(([key, value]) => ({ key, value: String(value), type: "encrypted", target: [scope.target], ...(scope.branch ? { gitBranch: scope.branch } : {}) }));
      actx.log(`upsert ${body.length} env var(s) in ${scope.target}`);
      // A bulk upsert answers 200 even when some entries were rejected; they come back under `failed`.
      const r = await c.api.post<{ failed?: Array<{ error?: { key?: string; message?: string } }> }>(`/v10/projects/${c.project}/env${query(c, { upsert: "true" })}`, body);
      if (r?.failed?.length) {
        const why = r.failed.map((f) => `${f.error?.key ?? "?"}: ${f.error?.message ?? "rejected"}`).join("; ");
        throw new Error(`vercel: ${r.failed.length} env var(s) rejected (${why})`);
      }

      // Vercel may have already started building this sha before the vars landed; that build would miss them.
      const d = newest(await deploymentsFor(c, actx.ctx.git.sha));
      if (d && d.createdAt < startedAt && d.state !== "ERROR") {
        actx.log(`deployment ${d.uid} predates env write; redeploying`);
        await triggerDeploy(c, actx);
        notes = { redeployed: true };
      }
    }

    const after = await listEnvs(c, scope);
    const resources: ResourceRecord[] = [];
    for (const name of Object.keys(scope.values)) {
      const e = after.find((x) => x.key === name);
      if (!e) throw new Error(`vercel: ${name} missing after upsert`);
      resources.push(envRecord(scope.target, e));
    }
    return { resources, outputs: {}, created, ...(notes ? { notes } : {}) };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(c.api, `/v9/projects/${c.project}/env/${r.id}${query(c)}`);
  },

  async listScope(actx, params) {
    const c = client(actx);
    const scope = envScope(params);
    return (await listEnvs(c, scope)).map((e) => envRecord(scope.target, e));
  },

  async awaitExternal(actx) {
    const c = client(actx);
    const d = newest(await deploymentsFor(c, actx.ctx.git.sha));
    if (!d) return null;
    if (d.state === "READY") return { preview_url: `https://${d.url}`, deployment_id: d.uid };
    if (d.state === "ERROR" || d.state === "CANCELED") throw new Error(`deployment ${d.uid} failed`);
    return null;
  },
};

// ---------------------------------------------------------------------------
// op: deploy
// ---------------------------------------------------------------------------

function deployKey(sha: string): string {
  return `deployment:${sha}`;
}

function deployRecord(sha: string, d: { uid: string; url: string }): ResourceRecord {
  return { key: deployKey(sha), id: d.uid, hash: sha256(d.uid), label: `deployment ${d.uid}` };
}

function deployOutputs(d: { uid: string; url: string }): Record<string, Literal> {
  return { preview_url: `https://${d.url}`, deployment_id: d.uid };
}

const deploy: OpSpec = {
  outputs: {
    preview_url: { available: "immediate" },
    deployment_id: { available: "immediate" },
  },

  async read(actx) {
    const c = client(actx);
    const d = newest(await deploymentsFor(c, actx.ctx.git.sha));
    if (!d || d.state !== "READY") return null;
    return { resources: [deployRecord(actx.ctx.git.sha, d)], outputs: deployOutputs(d) };
  },

  diff(live): ResourceDiff[] {
    const r = live?.resources[0];
    if (r) return [{ key: r.key, kind: "unchanged", label: r.label ?? r.key }];
    return [{ key: "deployment:(new)", kind: "create", label: "deployment", after: "(new deployment)" }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, "vercel");
    if (live?.resources[0]) return { resources: live.resources, outputs: live.outputs, created: [] };
    const c = client(actx);
    const sha = actx.ctx.git.sha;
    actx.log(`deploy ${sha}`);
    const started = await triggerDeploy(c, actx);
    const timeout = Number(actx.env.SPONSON_DEPLOY_TIMEOUT_MS ?? 120_000);
    const deadline = Date.now() + timeout;
    let d = started;
    while (d.readyState !== "READY") {
      if (d.readyState === "ERROR" || d.readyState === "CANCELED") throw new Error(`deployment ${d.id} failed`);
      if (Date.now() > deadline) throw new Error(`deployment ${d.id} not ready after ${timeout}ms`);
      await sleep(200);
      d = await c.api.get(`/v13/deployments/${started.id}${query(c)}`);
    }
    const rec = { uid: d.id, url: d.url };
    return { resources: [deployRecord(sha, rec)], outputs: deployOutputs(rec), created: [deployKey(sha)] };
  },

  // Deployments are history; Vercel keeps them and so do we.
  async destroy() {},
};

export const vercelAdapter: ResourceAdapter = { name: "vercel", ops: { env, deploy } };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
