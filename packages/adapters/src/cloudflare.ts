/**
 * Cloudflare adapter. One op, `pages_env`: the variables of a Cloudflare Pages project's `preview` or `production`
 * deployment config (`deployment_configs.<env>.env_vars`), plain text (`vars`) and secret (`secrets`).
 *
 * The variables are a map on the project, not objects of their own, so `apply` is read-modify-write: it PATCHes only
 * the keys this line manages (Cloudflare merges the map; `null` deletes a key), as an idempotent PATCH, then re-reads
 * the project to check that what it sent landed and that no other key went missing. API facts and their sources are
 * the numbered assumptions (CF1…) at the top of packages/sim/src/routes/cloudflare.ts.
 *
 * Pages has one set of preview variables shared by every preview deployment (CF8): there are no per-branch values.
 * A key is therefore one resource per environment, `env:<target>:<NAME>`, whatever scope wrote it; a second scope
 * (another pull request) that declares the same key with another value is refused with OWNED_BY_OTHER_SCOPE.
 *
 * Secret values are write-only (CF3): a `secret_text` variable is compared by presence and type, never by value.
 * See `secretHash` and docs/plan-format.md (`cloudflare.pages_env`).
 */
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type Ctx, type DiffSide, type OpSpec, type ResolvedParams, type ResourceAdapter, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { ABSENT, SENSITIVE, assertNoPending, clientFor, desiredSide, optionalEnv, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isObject, isProviderError, obj, type ApiClient } from "./http.js";

const ADAPTER = "cloudflare";
/** The environment Cloudflare reads; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = { credentialEnv: "CLOUDFLARE_API_TOKEN", baseUrlEnv: "CLOUDFLARE_API_URL" } as const;

/** Cloudflare's API base URL (CF1). `CLOUDFLARE_API_URL` overrides it; tests and scenarios point that at the sim. */
export const CLOUDFLARE_DEFAULT_API_URL = "https://api.cloudflare.com/client/v4";

const TARGETS = ["preview", "production"] as const;
type Target = (typeof TARGETS)[number];
type VarType = "plain_text" | "secret_text";

/** One live variable. `value` is absent for a secret: Cloudflare never returns it (CF3). */
interface LiveVar {
  type: string;
  value?: string;
}

type VarMap = Map<string, LiveVar>;

interface Client {
  api: ApiClient;
  path: string;
}

/** The HTTP client and the project's path, from `providers.cloudflare.{account,project}`. */
function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const account = requireProvider(actx, "account", ADAPTER);
  const project = requireProvider(actx, "project", ADAPTER);
  return {
    api: clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? CLOUDFLARE_DEFAULT_API_URL, token }),
    path: `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}`,
  };
}

// ---------------------------------------------------------------------------
// Response shape (CF2): { success, errors, messages, result: project }
// ---------------------------------------------------------------------------

/** One environment's `env_vars` (nullable in the schema) as a map. A secret's value is dropped whatever it says. */
function parseVars(v: unknown, what: string): VarMap {
  const out: VarMap = new Map();
  if (v === null || v === undefined) return out;
  for (const [name, e] of Object.entries(obj(v, what))) {
    if (e === null) continue;
    const entry = obj(e, `${what}.${name}`);
    if (typeof entry.type !== "string") throw new ShapeError(`expected ${what}.${name}.type to be a string`);
    const readable = entry.type === "plain_text" && typeof entry.value === "string";
    out.set(name, readable ? { type: entry.type, value: entry.value as string } : { type: entry.type });
  }
  return out;
}

function parseProject(body: unknown): Record<Target, VarMap> {
  const env = obj(body, "the response");
  if (env.success !== true) throw new ShapeError("expected `success` to be true");
  const configs = obj(obj(env.result, "`result`").deployment_configs, "`result.deployment_configs`");
  const of = (t: Target): VarMap => {
    const c = configs[t];
    return c === null || c === undefined ? new Map() : parseVars(obj(c, `\`deployment_configs.${t}\``).env_vars, `\`deployment_configs.${t}.env_vars\``);
  };
  return { preview: of("preview"), production: of("production") };
}

async function readVars(c: Client, target: Target): Promise<VarMap> {
  return (await c.api.get(c.path, parseProject))[target];
}

/** PATCH a partial `env_vars` map (CF4): a value sets a key, `null` deletes it, keys not named are left alone. */
async function patchVars(c: Client, target: Target, vars: Record<string, { type: VarType; value: string } | null>): Promise<void> {
  // Sets state rather than adding to it, so a dropped connection or a 5xx may be retried.
  await c.api.patch(c.path, { deployment_configs: { [target]: { env_vars: vars } } }, undefined, { idempotent: true });
}

// ---------------------------------------------------------------------------
// Hashes: one canonical form for read, diff and apply
// ---------------------------------------------------------------------------

/** A plain-text variable: its type and value. */
function plainHash(value: string): string {
  return sha256(canonicalJson({ type: "plain_text", value }));
}

/**
 * A secret: its type only. Cloudflare never returns a secret's value (CF3) and the adapter API offers no place to
 * keep a fingerprint, so a secret is equal when it exists as `secret_text`. What that means: a value changed in the
 * Cloudflare dashboard is not seen as drift; a changed value in the plan is not written unless the line sets
 * `rewrite_secrets: true` (then every apply sends the secrets again). Deleting it, or turning it into plain text,
 * is seen.
 */
function secretHash(): string {
  return sha256(canonicalJson({ type: "secret_text" }));
}

function liveHash(v: LiveVar): string {
  if (v.type === "plain_text") return plainHash(v.value ?? "");
  if (v.type === "secret_text") return secretHash();
  return sha256(canonicalJson({ type: v.type }));
}

// ---------------------------------------------------------------------------
// op: pages_env
// ---------------------------------------------------------------------------

interface EnvScope {
  target: Target;
  /** NAME → desired value and the type it is written as. */
  values: Map<string, { value: unknown; type: VarType }>;
  rewriteSecrets: boolean;
}

function mapParam(params: ResolvedParams, name: string): Record<string, unknown> {
  const v = params[name];
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw paramError(ADAPTER, `param \`${name}\` must be an object of NAME → value`, name);
  return v;
}

function envScope(params: ResolvedParams): EnvScope {
  const target = stringParam(params, "target", ADAPTER, "preview");
  if (!(TARGETS as readonly string[]).includes(target)) throw paramError(ADAPTER, `param \`target\` must be one of ${TARGETS.join(", ")} (got ${JSON.stringify(target)})`, "target");
  const rewrite = params.rewrite_secrets;
  if (rewrite !== undefined && rewrite !== null && typeof rewrite !== "boolean") throw paramError(ADAPTER, "param `rewrite_secrets` must be true or false", "rewrite_secrets");
  const values = new Map<string, { value: unknown; type: VarType }>();
  for (const [name, value] of Object.entries(mapParam(params, "vars"))) values.set(name, { value, type: "plain_text" });
  for (const [name, value] of Object.entries(mapParam(params, "secrets"))) {
    if (values.has(name)) throw paramError(ADAPTER, `${name} is in both \`vars\` and \`secrets\`; a variable is either plain text or secret`, "secrets");
    values.set(name, { value, type: "secret_text" });
  }
  for (const name of values.keys()) if (name === "") throw paramError(ADAPTER, "a variable name must not be empty", "vars");
  return { target: target as Target, values, rewriteSecrets: rewrite === true };
}

/** The target a run writes by default: production under `--env production`, preview otherwise. */
function targetFor(ctx: Ctx): Target {
  return ctx.env === "production" ? "production" : "preview";
}

/**
 * Pages has exactly two variable sets, so the line must write the run's own environment. Ownership between scopes
 * is decided among the scopes of one Sponson environment; a `target: production` line applied under `--env preview`
 * would be invisible to the production scopes' ledgers (and a preview pull request's destroy would delete it).
 */
function assertRunEnvironment(scope: EnvScope, ctx: Ctx): void {
  if (scope.target === ctx.env) return;
  throw paramError(
    ADAPTER,
    `this line writes the Pages \`${scope.target}\` variables but the run's environment is \`${ctx.env}\`. Pages variables are shared by every deployment of an environment, so Sponson only writes them from a run of that environment: run with \`--env ${scope.target}\`, or limit the line with \`environments: [${scope.target}]\`.`,
    "target",
  );
}

/** Identity: the environment and the name. No branch or scope: every preview deployment shares the set (CF8). */
function varKey(target: Target, name: string): string {
  return `env:${target}:${name}`;
}

/** Inverse of varKey. A target never contains `:`; a name may. */
function parseVarKey(key: string): { target: Target; name: string } {
  const m = /^env:(preview|production):(.+)$/.exec(key);
  if (!m) throw new SponsonError("INTERNAL", `${ADAPTER}: \`${key}\` is not a pages_env key`, { adapter: ADAPTER, key });
  return { target: m[1] as Target, name: m[2]! };
}

const SECRET_LABEL = ", secret)";

function varLabel(target: Target, name: string, type: string): string {
  return `${name} (Pages ${target}${type === "secret_text" ? SECRET_LABEL : ")"}`;
}

function varRecord(target: Target, name: string, v: LiveVar): ResourceRecord {
  return { key: varKey(target, name), id: name, hash: liveHash(v), label: varLabel(target, name, v.type) };
}

/** One declared variable's diff against its live record. */
function diffVar(scope: EnvScope, name: string, desired: { value: unknown; type: VarType }, live: ResourceRecord | undefined): ResourceDiff {
  const key = varKey(scope.target, name);
  const label = varLabel(scope.target, name, desired.type);
  const secret = desired.type === "secret_text";
  const marker = markerKind(desired.value);
  if (marker === "keep") {
    if (live) return { key, kind: "unchanged", label };
    throw paramError(ADAPTER, `${label} is declared \`{ keep: true }\` but does not exist, so there is no value to keep. Give it a value or remove it.`, secret ? "secrets" : "vars");
  }
  const after: DiffSide = desiredSide(desired.value, secret);
  if (!live) return { key, kind: "create", label, before: ABSENT, after };
  if (marker === null && !(secret && scope.rewriteSecrets)) {
    const want = secret ? secretHash() : plainHash(String(desired.value));
    if (live.hash === want) return { key, kind: "unchanged", label };
  }
  return { key, kind: "update", label, before: SENSITIVE, after };
}

/** After a write: every variable sent is there as sent, and every other variable that was there still is. */
function verifyWrite(c: Client, target: Target, sent: Map<string, { type: VarType; value: string }>, before: VarMap, after: VarMap): void {
  const wrong = [...sent].filter(([name, s]) => {
    const v = after.get(name);
    return !v || v.type !== s.type || (s.type === "plain_text" && v.value !== s.value);
  });
  const lost = [...before.keys()].filter((name) => !sent.has(name) && !after.has(name));
  if (wrong.length === 0 && lost.length === 0) return;
  const parts = [
    ...(wrong.length ? [`does not show ${wrong.map(([n]) => n).join(", ")} as written`] : []),
    ...(lost.length ? [`no longer has ${lost.join(", ")}, which this write did not name (another writer removed them, or the PATCH replaced the map instead of merging it)`] : []),
  ];
  throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: after PATCH ${c.path}, the ${target} env_vars ${parts.join("; ")}`, { adapter: ADAPTER, method: "PATCH", path: c.path, written: wrong.map(([n]) => n), lost });
}

const pagesEnv: OpSpec = {
  outputs: {},

  defaults(params, ctx) {
    return { ...params, target: (params.target as string | undefined) ?? targetFor(ctx) };
  },

  writesEnvironment(params, ctx) {
    return typeof params.target === "string" ? params.target : targetFor(ctx);
  },

  /**
   * The environment's `env_vars` map is read-modify-write on one project object that every scope (and a run of the
   * other environment, for the other map) writes, so the engine serialises writers with a parent lock (ADR 0019).
   */
  lockOn(params, provider) {
    const { account, project } = provider;
    if (typeof account !== "string" || account === "" || typeof project !== "string" || project === "") return null;
    const target = typeof params.target === "string" && params.target !== "" ? params.target : "preview";
    return `cloudflare:${account}:pages:${project}:${target}:env`;
  },

  async read(actx, params) {
    const scope = envScope(params);
    assertRunEnvironment(scope, actx.ctx);
    const live = await readVars(client(actx), scope.target);
    const resources: ResourceRecord[] = [];
    for (const name of scope.values.keys()) {
      const v = live.get(name);
      if (v) resources.push(varRecord(scope.target, name, v));
    }
    return resources.length ? { resources, outputs: {} } : null;
  },

  diff(live, params) {
    const scope = envScope(params);
    const byKey = new Map((live?.resources ?? []).map((r) => [r.key, r]));
    return [...scope.values].map(([name, desired]) => diffVar(scope, name, desired, byKey.get(varKey(scope.target, name))));
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const scope = envScope(params);
    assertRunEnvironment(scope, actx.ctx);
    const diffs = new Map(pagesEnv.diff(live, params).map((d) => [d.key, d.kind]));
    const sent = new Map<string, { type: VarType; value: string }>();
    for (const [name, d] of scope.values) if (diffs.get(varKey(scope.target, name)) !== "unchanged") sent.set(name, { type: d.type, value: String(d.value) });
    const created = [...sent.keys()].map((n) => varKey(scope.target, n)).filter((k) => diffs.get(k) === "create");
    if (sent.size === 0) return { resources: live?.resources ?? [], outputs: {}, created: [] };

    const c = client(actx);
    // Read-modify-write: the variables before the write, to check afterwards that no other key was lost.
    const before = await readVars(c, scope.target);
    if (created.length) await actx.intend(created);
    actx.log(`set ${sent.size} Pages ${scope.target} variable(s): ${[...sent.keys()].join(", ")}`);
    await patchVars(c, scope.target, Object.fromEntries(sent));
    const after = await readVars(c, scope.target);
    verifyWrite(c, scope.target, sent, before, after);
    // A declared variable missing now was not written by this call (verifyWrite checked those): it vanished meanwhile.
    const resources = [...scope.values.keys()].flatMap((name) => {
      const v = after.get(name);
      return v ? [varRecord(scope.target, name, v)] : [];
    });
    return { resources, outputs: {}, created };
  },

  /** `null` for each key still present, per environment; a project or key already gone is success. */
  async destroy(actx, resources) {
    const c = client(actx);
    const byTarget = new Map<Target, string[]>();
    for (const r of resources) {
      const { target, name } = parseVarKey(r.key);
      byTarget.set(target, [...(byTarget.get(target) ?? []), name]);
    }
    for (const [target, names] of byTarget) {
      let live: VarMap;
      try {
        live = await readVars(c, target);
      } catch (e) {
        if (isProviderError(e, "PROVIDER_NOT_FOUND")) return;
        throw e;
      }
      const present = names.filter((n) => live.has(n));
      if (present.length) await patchVars(c, target, Object.fromEntries(present.map((n) => [n, null])));
    }
  },

  /** Every variable of the line's environment, for drift (`unmanaged`) and `sponson init`. */
  async listScope(actx, params) {
    const scope = envScope(params);
    const live = await readVars(client(actx), scope.target);
    return [...live].map(([name, v]) => varRecord(scope.target, name, v));
  },

  /** One line per environment; every variable `{ keep: true }` under `vars` or `secrets`, never its value. */
  adopt(resources) {
    const groups = new Map<Target, { vars: Record<string, { keep: true }>; secrets: Record<string, { keep: true }>; keys: string[] }>();
    for (const r of resources) {
      const { target, name } = parseVarKey(r.key);
      const g = groups.get(target) ?? { vars: {}, secrets: {}, keys: [] };
      (r.label?.endsWith(SECRET_LABEL) ? g.secrets : g.vars)[name] = { keep: true };
      g.keys.push(r.key);
      groups.set(target, g);
    }
    return [...groups].map(([target, g]) => ({
      id: `pages-env-${target}`,
      params: { target, ...(Object.keys(g.vars).length ? { vars: g.vars } : {}), ...(Object.keys(g.secrets).length ? { secrets: g.secrets } : {}) },
      keys: g.keys,
    }));
  },
};

/**
 * The Cloudflare adapter (`adapter: cloudflare` in a plan): op `pages_env` manages a Pages project's preview or
 * production variables. Needs `CLOUDFLARE_API_TOKEN` (account permission "Cloudflare Pages Edit") and
 * `providers.cloudflare.{account,project}`.
 */
export const cloudflareAdapter: ResourceAdapter = { name: ADAPTER, ops: { pages_env: pagesEnv }, about: ABOUT };
