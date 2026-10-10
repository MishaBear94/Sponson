/**
 * Netlify: environment variable values per deploy context, and the deploy that carries them.
 *
 * Netlify stores one object per variable (`key`) with a list of values, one per deploy context (`production`,
 * `deploy-preview`, `branch-deploy`, `dev`, `dev-server`, or `branch` with the branch name in
 * `context_parameter`). A line owns one context's value of each variable it declares, never the variable: a
 * value a human set for another context is never read as ours, changed or deleted. Every call and field below is
 * checked against Netlify's OpenAPI document; see the NL assumptions in packages/sim/src/routes/netlify.ts and the
 * Netlify section of docs/api-verification.md.
 */
import { SponsonError, sha256, type AdapterContext, type Literal, type OpSpec, type ResolvedParams, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { assertNoPending, clientFor, deleteIgnoringNotFound, diffValue, optionalEnv, optionalProvider, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isProviderError, isTransient, obj, records, type ApiClient } from "./http.js";

const ADAPTER = "netlify";
/** The environment Netlify reads; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = { credentialEnv: "NETLIFY_AUTH_TOKEN", baseUrlEnv: "NETLIFY_API_URL" } as const;

/** Netlify's API base URL (OpenAPI `host` + `basePath`); `NETLIFY_API_URL` overrides it (the sim and tests use that). */
export const NETLIFY_DEFAULT_API_URL = "https://api.netlify.com/api/v1";

/**
 * The deploy contexts a line may own (OpenAPI `envVarValue.context`). `all` is left out on purpose: one value for
 * every context cannot belong to a line that manages one of them.
 */
const CONTEXTS = ["production", "deploy-preview", "branch-deploy", "dev", "dev-server", "branch"] as const;
type Context = (typeof CONTEXTS)[number];
/** The branch dimension of a key for every context but `branch`. */
const NO_BRANCH = "*";

interface EnvValue {
  id: string;
  context: string;
  contextParameter?: string;
  value?: string;
}

interface EnvVar {
  key: string;
  values: EnvValue[];
  /** Secret values are write-only: never returned in readable form, except in the `dev` context. */
  isSecret: boolean;
  /** Milliseconds; when any of the variable's values last changed (`updated_at`). */
  updatedAt?: number;
}

/** A deploy as GET /sites/{site_id}/deploys lists it. `context` and `state` are plain strings in the spec. */
interface Deploy {
  id: string;
  state: string;
  context?: string;
  commitRef?: string;
  reviewId?: number;
  createdAt: number;
}

interface Client {
  api: ApiClient;
  site: string;
  /** `providers.netlify.account`, or the site's account once looked up. */
  account?: string;
  /** The site's subdomain name, once looked up. */
  name?: string;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const site = requireProvider(actx, "site", ADAPTER);
  const api = clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? NETLIFY_DEFAULT_API_URL, token });
  const account = optionalProvider(actx, "account");
  return { api, site, ...(account ? { account } : {}) };
}

/** GET /sites/{site_id}: the site's `name` (its `<name>.netlify.app` subdomain) and its account. */
async function loadSite(c: Client): Promise<void> {
  const s = await c.api.get(`/sites/${encodeURIComponent(c.site)}`, (body) => {
    const o = obj(body, "the site");
    const account = typeof o.account_id === "string" && o.account_id !== "" ? o.account_id : o.account_slug;
    if (typeof o.name !== "string" || o.name === "") throw new ShapeError("expected the site's `name` to be a string");
    return { name: o.name, account: typeof account === "string" && account !== "" ? account : undefined };
  });
  c.name = s.name;
  if (!c.account) {
    if (!s.account) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: site ${c.site} names no account; set providers.netlify.account`, { adapter: ADAPTER, site: c.site });
    c.account = s.account;
  }
}

/** `/accounts/{account_id}/env[/{key}…]?site_id=`: the site's own variables, never the account's shared ones. */
async function envPath(c: Client, suffix = ""): Promise<string> {
  if (!c.account) await loadSite(c);
  return `/accounts/${encodeURIComponent(c.account!)}/env${suffix}?site_id=${encodeURIComponent(c.site)}`;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

function parseValues(v: unknown, what: string): EnvValue[] {
  return records(v ?? [], what, ["id", "context"]).map((x) => ({
    id: x.id,
    context: x.context,
    ...(typeof x.context_parameter === "string" && x.context_parameter !== "" ? { contextParameter: x.context_parameter } : {}),
    ...(typeof x.value === "string" ? { value: x.value } : {}),
  }));
}

function parseEnvVar(e: Record<string, unknown>, what: string): EnvVar {
  if (typeof e.key !== "string") throw new ShapeError(`expected ${what}.key to be a string`);
  const updated = typeof e.updated_at === "string" ? Date.parse(e.updated_at) : NaN;
  return {
    key: e.key,
    values: parseValues(e.values, `${what}.values`),
    isSecret: e.is_secret === true,
    ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
  };
}

function parseEnvVars(body: unknown): EnvVar[] {
  if (!Array.isArray(body)) throw new ShapeError("expected a list of environment variables");
  return body.map((e, i) => parseEnvVar(obj(e, `[${i}]`), `[${i}]`));
}

function parseDeploys(body: unknown): Deploy[] {
  return records(body, "the deploy list", ["id", "state"]).map((d, i) => {
    const created = typeof d.created_at === "string" ? Date.parse(d.created_at) : NaN;
    if (!Number.isFinite(created)) throw new ShapeError(`expected [${i}].created_at to be a date`);
    return {
      id: d.id,
      state: d.state,
      createdAt: created,
      ...(typeof d.context === "string" ? { context: d.context } : {}),
      ...(typeof d.commit_ref === "string" ? { commitRef: d.commit_ref } : {}),
      ...(typeof d.review_id === "number" ? { reviewId: d.review_id } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Scope: which value of a variable a line owns
// ---------------------------------------------------------------------------

interface EnvScope {
  context: Context;
  /** The branch of a `branch` context (`context_parameter`); undefined for every other context. */
  branch: string | undefined;
  values: Record<string, unknown>;
}

function branchParam(params: ResolvedParams): string | undefined {
  const raw = params.branch;
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw paramError(ADAPTER, "param `branch` must be a string", "branch");
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function envScope(params: ResolvedParams): EnvScope {
  const context = stringParam(params, "context", ADAPTER);
  if (!(CONTEXTS as readonly string[]).includes(context)) throw paramError(ADAPTER, `param \`context\` must be one of ${CONTEXTS.join(", ")} (got ${JSON.stringify(context)})`, "context");
  const branch = branchParam(params);
  if (context === "branch" && branch === undefined) throw paramError(ADAPTER, "param `branch` is required with `context: branch`", "branch");
  if (context !== "branch" && branch !== undefined) throw paramError(ADAPTER, `param \`branch\` only applies to \`context: branch\` (got context ${context})`, "branch");
  const values = params.values;
  if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) throw paramError(ADAPTER, "param `values` must be an object of NAME → value", "values");
  return { context: context as Context, branch, values: (values ?? {}) as Record<string, unknown> };
}

/** Identity: context, branch (`*` outside the `branch` context) and name. A variable name never contains `:`. */
function envKey(context: string, branch: string | undefined, name: string): string {
  return `env:${context}:${branch ?? NO_BRANCH}:${name}`;
}

/** Inverse of envKey. A branch may contain `:`, a variable name may not. */
function parseEnvKey(key: string): { context: string; branch: string; name: string } {
  const [kind, context] = key.split(":", 2);
  const last = key.lastIndexOf(":");
  const branchAt = (kind?.length ?? 0) + (context?.length ?? 0) + 2;
  if (kind !== "env" || !context || last < branchAt) throw new SponsonError("INTERNAL", `${ADAPTER}: \`${key}\` is not an env key`, { adapter: ADAPTER, key });
  return { context, branch: key.slice(branchAt, last), name: key.slice(last + 1) };
}

function scopeLabel(scope: Pick<EnvScope, "context" | "branch">, name: string): string {
  return `${name} (${scope.context === "branch" ? `branch ${scope.branch}` : scope.context})`;
}

function owns(v: EnvValue, scope: Pick<EnvScope, "context" | "branch">): boolean {
  return v.context === scope.context && (scope.context !== "branch" || v.contextParameter === scope.branch);
}

/** What a value hashes as: its text, or "" when Netlify will not show it (a secret outside `dev`): such a value always diffs as an update. */
function comparable(e: EnvVar, v: EnvValue): string {
  return e.isSecret && v.context !== "dev" ? "" : (v.value ?? "");
}

function valueRecord(scope: Pick<EnvScope, "context" | "branch">, e: EnvVar, v: EnvValue): ResourceRecord {
  return { key: envKey(scope.context, scope.branch, e.key), id: v.id, hash: sha256(comparable(e, v)), label: scopeLabel(scope, e.key) };
}

/**
 * A variable with one value for all contexts cannot be managed by a line that owns one context: adding ours would
 * either be refused or leave two values competing for the same deploys.
 */
function refuseAll(e: EnvVar, scope: EnvScope): SponsonError {
  return new SponsonError(
    "PROVIDER_CONFLICT",
    `${ADAPTER}: ${e.key} has one value for all deploy contexts; this line manages only ${scope.context === "branch" ? `branch ${scope.branch}` : scope.context}. ` +
      `In the Netlify UI, give ${e.key} different values for each deploy context, then run again.`,
    { adapter: ADAPTER, key: envKey(scope.context, scope.branch, e.key) },
  );
}

async function listVars(c: Client): Promise<EnvVar[]> {
  return c.api.get(await envPath(c), parseEnvVars);
}

/** The value body of PATCH /accounts/{account_id}/env/{key} and of each `values` item of POST /accounts/{account_id}/env. */
function valueBody(scope: EnvScope, value: unknown): Record<string, string> {
  return { context: scope.context, value: String(value), ...(scope.branch !== undefined ? { context_parameter: scope.branch } : {}) };
}

function ownValue(e: EnvVar, scope: EnvScope, path: string): EnvValue {
  const v = e.values.find((x) => owns(x, scope));
  if (!v) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: ${path}: the answer does not list the ${scopeLabel(scope, e.key)} value`, { adapter: ADAPTER, path, key: e.key });
  return v;
}

/**
 * Write the given values: one POST for the variables that do not exist yet (createEnvVars), one PATCH per
 * variable that does (setEnvVarValue, "updates or creates a new value for an existing environment variable").
 * Returns the written variables as Netlify answered them.
 */
async function writeValues(c: Client, scope: EnvScope, toWrite: Array<[string, unknown]>, existing: Set<string>): Promise<EnvVar[]> {
  const fresh = toWrite.filter(([name]) => !existing.has(name));
  const out: EnvVar[] = [];
  if (fresh.length > 0) {
    const path = await envPath(c);
    try {
      out.push(...(await c.api.post(path, fresh.map(([key, value]) => ({ key, values: [valueBody(scope, value)] })), parseEnvVars)));
    } catch (e) {
      // Created meanwhile (by a human, or by an earlier attempt of ours whose answer was lost): set the value instead.
      if (!isProviderError(e, ["PROVIDER_CONFLICT", "PROVIDER_INVALID"])) throw e;
      const now = new Set((await listVars(c)).map((v) => v.key));
      if (!fresh.every(([name]) => now.has(name))) throw e;
      for (const [name] of fresh) existing.add(name);
      return writeValues(c, scope, toWrite, existing);
    }
  }
  for (const [name, value] of toWrite.filter(([n]) => existing.has(n))) {
    const path = await envPath(c, `/${encodeURIComponent(name)}`);
    out.push(await c.api.patch(path, valueBody(scope, value), (body) => parseEnvVar(obj(body, "the variable"), "the variable"), { idempotent: true }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deploys: which deploy of this commit carries the line's values
// ---------------------------------------------------------------------------

/** The deploy contexts whose builds read a line's values. `branch` values reach Deploy Previews and branch deploys of that branch. */
const DEPLOYS_OF: Record<Context, readonly string[]> = {
  production: ["production"],
  "deploy-preview": ["deploy-preview"],
  "branch-deploy": ["branch-deploy"],
  branch: ["deploy-preview", "branch-deploy"],
  dev: [],
  "dev-server": [],
};

/** States a deploy does not leave by itself (OpenAPI: the `state` filter of listSiteDeploys). */
const FAILED_STATES: ReadonlySet<string> = new Set(["error", "rejected"]);

/** The recent deploys of this commit that read the line's context, newest first. */
async function deploysOf(c: Client, sha: string, scope: EnvScope): Promise<Deploy[]> {
  const contexts = DEPLOYS_OF[scope.context];
  const list = await c.api.get(`/sites/${encodeURIComponent(c.site)}/deploys?page=1&per_page=100`, parseDeploys);
  return list.filter((d) => d.commitRef === sha && (d.context === undefined || contexts.includes(d.context))).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Build again what a deploy that predates the write built: POST /sites/{site_id}/builds builds the production
 * branch without `branch`, a branch deploy of that branch with it. A Deploy Preview cannot be rebuilt through the
 * API (Netlify documents retrying one only in its UI), so for `deploy-preview` lines this returns false.
 */
async function rebuild(c: Client, scope: EnvScope, gitBranch: string): Promise<boolean> {
  if (scope.context === "deploy-preview" || DEPLOYS_OF[scope.context].length === 0) return false;
  const branch = scope.context === "production" ? undefined : scope.context === "branch" ? (scope.branch!.endsWith("*") ? gitBranch : scope.branch!) : gitBranch;
  await c.api.post(`/sites/${encodeURIComponent(c.site)}/builds${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`);
  return true;
}

function deployFailed(d: Deploy): SponsonError {
  return new SponsonError("PROVIDER_INVALID", `${ADAPTER}: deploy ${d.id} ended ${d.state}; it will not become ready`, { adapter: ADAPTER, deploy: d.id, state: d.state });
}

/** Documented URL formats: `<deploy id>--<site>.netlify.app` (permalink) and `deploy-preview-<n>--<site>.netlify.app`. */
function deployOutputs(d: Deploy, siteName: string): Record<string, Literal> {
  const permalink = `https://${d.id}--${siteName}.netlify.app`;
  const preview = d.context === "deploy-preview" && d.reviewId !== undefined ? `https://deploy-preview-${d.reviewId}--${siteName}.netlify.app` : permalink;
  return { preview_url: permalink, deploy_id: d.id, deploy_preview_url: preview };
}

/** When the line's variables last changed in Netlify: a deploy created before that does not carry them. */
function writtenAt(vars: EnvVar[], scope: EnvScope): number {
  return vars.filter((v) => v.key in scope.values).reduce((max, v) => Math.max(max, v.updatedAt ?? 0), 0);
}

/** After a write: rebuild (or report) a deploy of this commit that started before it. */
async function afterWrite(c: Client, actx: AdapterContext, scope: EnvScope, at: number): Promise<Record<string, unknown> | undefined> {
  if (DEPLOYS_OF[scope.context].length === 0) return undefined;
  const stale = (await deploysOf(c, actx.ctx.git.sha, scope)).find((d) => d.createdAt < at && !FAILED_STATES.has(d.state));
  if (!stale) return undefined;
  if (await rebuild(c, scope, actx.ctx.git.branch)) {
    actx.log(`deploy ${stale.id} predates the variables; started a new build`);
    return { redeployed: true };
  }
  actx.log(`deploy ${stale.id} started before the variables were written and does not carry them; retry it in the Netlify UI (Deploys → Retry) or push a commit`);
  return { stale_deploy: stale.id };
}

// ---------------------------------------------------------------------------
// op: env
// ---------------------------------------------------------------------------

/** The line's context unless the plan names one: production values under `--env production`, else the git branch's. */
function contextFor(env: string): Context {
  return env === "production" ? "production" : "branch";
}

const env: OpSpec = {
  outputs: {
    preview_url: { available: "external", event: "deploy" },
    deploy_id: { available: "external", event: "deploy" },
    deploy_preview_url: { available: "external", event: "deploy" },
  },

  defaults(params, ctx) {
    const context = (params.context as string | undefined) ?? contextFor(ctx.env);
    const out: ResolvedParams = { ...params, context };
    if (context === "branch" && out.branch === undefined) out.branch = ctx.git.branch;
    return out;
  },

  writesEnvironment(params, ctx) {
    const context = typeof params.context === "string" ? params.context : contextFor(ctx.env);
    return context === "production" ? "production" : context;
  },

  async read(actx, params) {
    const scope = envScope(params);
    const c = client(actx);
    const vars = await listVars(c);
    const resources: ResourceRecord[] = [];
    for (const name of Object.keys(scope.values)) {
      const e = vars.find((x) => x.key === name);
      if (!e) continue;
      if (e.values.some((v) => v.context === "all")) throw refuseAll(e, scope);
      const v = e.values.find((x) => owns(x, scope));
      if (v) resources.push(valueRecord(scope, e, v));
    }
    return resources.length === 0 ? null : { resources, outputs: {} };
  },

  diff(live, params) {
    const scope = envScope(params);
    const byKey = new Map((live?.resources ?? []).map((r) => [r.key, r]));
    return Object.entries(scope.values).map(([name, desired]) => {
      const key = envKey(scope.context, scope.branch, name);
      return diffValue({ key, label: scopeLabel(scope, name), live: byKey.get(key), desired, sensitive: true });
    });
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const scope = envScope(params);
    const c = client(actx);
    const keyOf = (name: string) => envKey(scope.context, scope.branch, name);
    const kindOf = new Map(env.diff(live, params).map((d) => [d.key, d.kind]));
    const toWrite = Object.entries(scope.values).filter(([name]) => kindOf.get(keyOf(name)) !== "unchanged");
    const creating = toWrite.map(([name]) => keyOf(name)).filter((k) => kindOf.get(k) === "create");
    const byKey = new Map((live?.resources ?? []).map((r) => [r.key, r]));

    let notes: Record<string, unknown> | undefined;
    if (toWrite.length > 0) {
      const vars = await listVars(c);
      const shared = vars.find((e) => e.key in scope.values && e.values.some((v) => v.context === "all"));
      if (shared) throw refuseAll(shared, scope);
      if (creating.length > 0) await actx.intend(creating);
      actx.log(`set ${toWrite.length} value(s) in ${scope.context === "branch" ? `branch ${scope.branch}` : scope.context}`);
      const written = await writeValues(c, scope, toWrite, new Set(vars.map((v) => v.key)));
      for (const [name, value] of toWrite) {
        const e = written.find((x) => x.key === name);
        if (!e) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: the write's answer does not list ${name}`, { adapter: ADAPTER, key: name });
        // A secret's value never reads back (outside `dev`), so it is recorded as read() will see it.
        const v = ownValue(e, scope, name);
        byKey.set(keyOf(name), { ...valueRecord(scope, e, v), hash: sha256(e.isSecret && v.context !== "dev" ? "" : String(value)) });
      }
      notes = await afterWrite(c, actx, scope, writtenAt(written, scope) || Date.now());
    }

    const resources = Object.keys(scope.values).map((name) => {
      const rec = byKey.get(keyOf(name));
      if (!rec) throw new SponsonError("INTERNAL", `${ADAPTER}: no record for ${name} after apply`, { adapter: ADAPTER, key: keyOf(name) });
      return rec;
    });
    return { resources, outputs: {}, created: creating, ...(notes ? { notes } : {}) };
  },

  /**
   * Delete the values this line owns (deleteEnvVarValue), then the variable only if that left it with no value at
   * all: a value someone set for another context keeps the variable alive.
   */
  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) {
      const { name } = parseEnvKey(r.key);
      const one = await envPath(c, `/${encodeURIComponent(name)}`);
      await deleteIgnoringNotFound(c.api, await envPath(c, `/${encodeURIComponent(name)}/value/${encodeURIComponent(r.id)}`));
      let left: EnvVar;
      try {
        left = await c.api.get(one, (body) => parseEnvVar(obj(body, "the variable"), "the variable"));
      } catch (e) {
        if (isProviderError(e, "PROVIDER_NOT_FOUND")) continue;
        throw e;
      }
      if (left.values.length === 0) await deleteIgnoringNotFound(c.api, one);
    }
  },

  /** Every value of this line's context (and branch), whoever set it. */
  async listScope(actx, params) {
    const scope = envScope(params);
    const c = client(actx);
    return (await listVars(c)).flatMap((e) => e.values.filter((v) => owns(v, scope)).map((v) => valueRecord(scope, e, v)));
  },

  /**
   * One line per context (and branch), every variable `{ keep: true }`: Sponson takes over that the values exist,
   * never what they are. `branch` is omitted when it is the current git branch, the op's default.
   */
  adopt(resources, ctx) {
    const groups = new Map<string, { context: string; branch: string; values: Record<string, { keep: true }>; keys: string[] }>();
    for (const r of resources) {
      const { context, branch, name } = parseEnvKey(r.key);
      const id = `${context}\u0000${branch}`;
      const g = groups.get(id) ?? { context, branch, values: {}, keys: [] };
      g.values[name] = { keep: true };
      g.keys.push(r.key);
      groups.set(id, g);
    }
    return [...groups.values()].map(({ context, branch, values, keys }) => {
      const pinned = context === "branch" && branch !== ctx.git.branch;
      return { id: context === "branch" ? (pinned ? `env-branch-${branch}` : "env-branch") : `env-${context}`, params: { context, ...(pinned ? { branch } : {}), values }, keys };
    });
  },

  /**
   * The newest deploy of this commit that reads the line's context and started after its variables last changed.
   * An older one does not carry them, so it is never reported as ready.
   */
  async awaitExternal(actx, params) {
    const scope = envScope(params);
    if (DEPLOYS_OF[scope.context].length === 0) {
      throw new SponsonError("PARAM_INVALID", `${ADAPTER}: \`context: ${scope.context}\` values are for local development, not part of any deploy, so this line has no \`preview_url\``, { adapter: ADAPTER, context: scope.context });
    }
    const c = client(actx);
    let found: Deploy | undefined;
    try {
      const at = writtenAt(await listVars(c), scope);
      found = (await deploysOf(c, actx.ctx.git.sha, scope)).find((d) => d.createdAt >= at);
      if (found?.state === "ready") await loadSite(c);
    } catch (e) {
      // The HTTP layer already retried; a provider that is still unavailable means "not known yet", not "failed".
      if (isTransient(e)) return null;
      throw e;
    }
    if (!found) return null;
    if (found.state === "ready") return deployOutputs(found, c.name!);
    if (FAILED_STATES.has(found.state)) throw deployFailed(found);
    return null;
  },
};

/**
 * Netlify (`adapter: netlify`): op `env` manages environment variable values per deploy context and outputs the
 * `preview_url` of the deploy that carries them. Needs `NETLIFY_AUTH_TOKEN` and `providers.netlify.site`.
 */
export const netlifyAdapter: ResourceAdapter = { name: ADAPTER, ops: { env }, about: ABOUT };
