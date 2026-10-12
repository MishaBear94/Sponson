/**
 * Contentful adapter (the Content Management API): a sandbox environment per scope, copied from a source
 * environment, and the delivery API keys that may read it. The API assumptions it relies on are numbered CF1… at the
 * top of packages/sim/src/routes/contentful.ts.
 *
 * Why an adapter and not an `http` recipe (ADR 0020, Amendments 4 and 9): a new environment is copied
 * asynchronously and is usable only once its status is `ready` (CF4), so `apply` waits for it; and granting an API
 * key access to it is a `PUT` of the key's whole `environments` list with the version read just before
 * (`X-Contentful-Version`, CF6/CF7), a precondition no request template carries.
 *
 * `environment`:
 * - Key: `environment:<id>`. Id: the environment id (Contentful's own identity, chosen by the plan). The space is the
 *   provider block.
 * - Hash: the id only. What it was copied from is used when it is created; an environment cannot be copied again in
 *   place, so changing `source` later changes nothing, and a console edit of its content is not drift (it is the
 *   point of a sandbox). A deleted environment is `missing`, and the next apply copies it again.
 * - A copy still in progress (a run that timed out waiting) is shown as an update to `ready`, and the next apply
 *   waits for it without writing; a copy that `failed` is refused with what to do.
 *
 * `api_key_access`:
 * - Key: `api_key:<key id>:environment:<environment id>`. Id: `<key id>/<environment id>`.
 * - The key's `environments` is one list on a shared object, so the line locks the key (`lockOn`,
 *   `contentful:<space>:api_key:<key id>`, ADR 0019), and every write sends the version it read (CF6): a writer
 *   outside Sponson in between makes it read and try again, never lose a link.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type CredentialCheck, type Literal, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
// Only the stable authoring API exported from `@sponson/adapters` (listed in CONTRIBUTING.md).
import { assertNoPending, clientFor, deleteIgnoringNotFound, optionalEnv, optionalProvider, paramError, requireEnv, requireProvider, stringParam, verifyByGet } from "./common.js";
import { ShapeError, isObject, isProviderError, type ApiClient } from "./http.js";

const ADAPTER = "contentful";
/** The environment Contentful reads, and what tells `sponson init` a repository uses Contentful; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = {
  credentialEnv: "CONTENTFUL_MANAGEMENT_TOKEN",
  credentialUrl: "https://www.contentful.com/developers/docs/references/authentication/",
  credentialScope: "A personal access token (or an OAuth token) with the content_management_manage scope, of a user whose role may create and delete sandbox environments and edit API keys in the space.",
  baseUrlEnv: "CONTENTFUL_API_URL",
  title: "Contentful",
  category: "cms",
  detect: { deps: ["contentful", "contentful-management", "@contentful/"], env: ["CONTENTFUL_*"] },
} as const;

/** Contentful's Content Management API (CF1). `CONTENTFUL_API_URL` overrides it (`https://api.eu.contentful.com`; tests point it at the sim). */
export const CONTENTFUL_DEFAULT_API_URL = "https://api.contentful.com";

/** The CMA's media type, sent with every body (CF3). */
const MEDIA_TYPE = "application/vnd.contentful.management.v1+json";

/** How often a new environment is polled, and for how long (milliseconds; overridable for tests). */
const POLL_MS = { env: "SPONSON_CONTENTFUL_POLL_MS", fallback: 3000 };
const READY_TIMEOUT_MS = { env: "SPONSON_CONTENTFUL_READY_TIMEOUT_MS", fallback: 10 * 60 * 1000 };

/** Rounds of read → write when another writer changes an API key in between (CF6). */
const VERSION_ROUNDS = 3;

function msFromEnv(env: NodeJS.ProcessEnv, s: { env: string; fallback: number }): number {
  const raw = optionalEnv(env, s.env);
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : s.fallback;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

interface Client {
  api: ApiClient;
  /** `/spaces/<space>`. */
  base: string;
  /** A client sending these extra headers too (`X-Contentful-Version`, `X-Contentful-Source-Environment`). */
  with(headers: Record<string, string>): ApiClient;
}

/** The client for the space in `providers.contentful.space`. */
function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const space = requireProvider(actx, "space", ADAPTER);
  const opts = { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? CONTENTFUL_DEFAULT_API_URL, token, contentType: MEDIA_TYPE };
  return { api: clientFor(actx, ADAPTER, opts), base: `/spaces/${enc(space)}`, with: (headers) => clientFor(actx, ADAPTER, { ...opts, headers }) };
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

interface Environment {
  id: string;
  status: string;
}

const ENV_PREFIX = "environment:";
/** CF2: an environment id. */
const ENV_ID = /^[a-zA-Z0-9-_.]{1,40}$/;

function environmentRecord(id: string): ResourceRecord {
  return { key: `${ENV_PREFIX}${id}`, id, hash: sha256(canonicalJson({ name: id })), label: `Contentful environment ${id}` };
}

function environmentOutputs(e: Environment): Record<string, Literal> {
  return { environment_id: e.id, status: e.status };
}

/** An environment answer: its id and `sys.status.sys.id` (CF2, CF4). */
function parseEnvironment(body: unknown): Environment {
  const sys = isObject(body) ? body.sys : undefined;
  const status = isObject(sys) && isObject(sys.status) && isObject(sys.status.sys) ? sys.status.sys.id : undefined;
  if (!isObject(sys) || typeof sys.id !== "string" || typeof status !== "string") throw new ShapeError("expected `{ sys: { id, status: { sys: { id } } } }`");
  return { id: sys.id, status };
}

/** The environment, or null when there is none (CF5). Reads only (a read moves nothing at Contentful). */
async function getEnvironment(c: Client, id: string): Promise<Environment | null> {
  try {
    return await c.api.get(`${c.base}/environments/${enc(id)}`, parseEnvironment);
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
}

function environmentId(params: Record<string, unknown>): string {
  const id = stringParam(params, "name", ADAPTER);
  if (!ENV_ID.test(id)) throw paramError(ADAPTER, `\`name\` ${JSON.stringify(id)} is not an environment id: 1 to 40 letters, digits, \`-\`, \`_\` or \`.\``, "name");
  if (id === "master") throw paramError(ADAPTER, "`name` may not be `master`: Sponson makes and deletes sandbox environments, never the master one", "name");
  return id;
}

function failedCopy(id: string): SponsonError {
  return new SponsonError("PROVIDER_INVALID", `contentful: copying environment ${id} failed; delete it in the Contentful web app (Settings → Environments), then apply again to copy it anew`, { adapter: ADAPTER, environment: id });
}

/** Poll the environment until it is `ready` (CF4); `failed` fails, a timeout is WAIT_TIMEOUT that the next run resumes. */
async function waitReady(actx: AdapterContext, c: Client, id: string): Promise<Environment> {
  const deadline = Date.now() + msFromEnv(actx.env, READY_TIMEOUT_MS);
  for (;;) {
    const e = await getEnvironment(c, id);
    if (!e) throw new SponsonError("PROVIDER_RESPONSE", `contentful: environment ${id} disappeared while it was being copied`, { adapter: ADAPTER, environment: id });
    if (e.status === "ready") return e;
    if (e.status === "failed") throw failedCopy(id);
    if (Date.now() > deadline) {
      throw new SponsonError("WAIT_TIMEOUT", `contentful: environment ${id} is not ready after ${msFromEnv(actx.env, READY_TIMEOUT_MS)}ms (${READY_TIMEOUT_MS.env}); run again to keep waiting`, { adapter: ADAPTER, environment: id });
    }
    actx.log(`environment ${id} not ready yet (${e.status})`);
    await sleep(msFromEnv(actx.env, POLL_MS));
  }
}

/** Create the environment (CF2); null when it exists already (a create whose answer was lost, CF6's 409). */
async function createEnvironment(c: Client, id: string, source: string): Promise<Environment | null> {
  try {
    return await c.with({ "X-Contentful-Source-Environment": source }).put(`${c.base}/environments/${enc(id)}`, { name: id }, parseEnvironment);
  } catch (e) {
    if (isProviderError(e, "PROVIDER_CONFLICT")) return null;
    throw e;
  }
}

const environment: OpSpec = {
  outputs: { environment_id: { available: "immediate" }, status: { available: "immediate" } },

  async read(actx, params) {
    if (markerKind(params.name) !== null) return null;
    const c = client(actx);
    const e = await getEnvironment(c, environmentId(params));
    return e ? { resources: [environmentRecord(e.id)], outputs: environmentOutputs(e) } : null;
  },

  diff(live, params) {
    const name = params.name;
    const key = markerKind(name) !== null ? `${ENV_PREFIX}(pending)` : `${ENV_PREFIX}${String(name)}`;
    const label = `Contentful environment ${String(name)}`;
    if (live?.resources.some((r) => r.key === key)) {
      const status = String(live.outputs.status ?? "ready");
      // A copy still in progress: the next apply waits for it, writing nothing.
      if (status === "ready") return [{ key, kind: "unchanged", label }];
      return [{ key, kind: "update", label, before: { state: "literal", value: status }, after: { state: "literal", value: "ready" } }];
    }
    const source = params.source ?? "master";
    const after = markerKind(source) !== null ? { state: "pending" as const, ref: String(source) } : { state: "literal" as const, value: `copy of ${String(source)}` };
    return [{ key, kind: "create", label, before: { state: "absent" }, after }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const id = environmentId(params);
    const source = stringParam(params, "source", ADAPTER, "master");
    const key = `${ENV_PREFIX}${id}`;
    const c = client(actx);
    if (live?.resources.some((r) => r.key === key)) {
      if (live.outputs.status === "ready") return { resources: live.resources, outputs: live.outputs, created: [] };
      return { resources: [environmentRecord(id)], outputs: environmentOutputs(await waitReady(actx, c, id)), created: [] };
    }
    // Copying from an environment that does not exist would fail at Contentful: say so before announcing anything.
    if (!(await getEnvironment(c, source))) throw paramError(ADAPTER, `\`source\` environment ${source} does not exist in the space`, "source");
    // Announce the create before sending it; a create whose answer was lost is found by its id next time.
    await actx.intend([key]);
    actx.log(`copy environment ${source} to ${id}`);
    const made = await createEnvironment(c, id, source);
    const ready = await waitReady(actx, c, id);
    return { resources: [environmentRecord(id)], outputs: environmentOutputs(ready), created: made ? [key] : [] };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    // An intent the engine could not locate has no id; `master` is never deleted, whatever a ledger says (CF5).
    for (const r of resources) if (r.id !== "" && r.id !== "master") await deleteIgnoringNotFound(c.api, `${c.base}/environments/${enc(r.id)}`);
  },
};

// ---------------------------------------------------------------------------
// api_key_access
// ---------------------------------------------------------------------------

interface ApiKey {
  name: string;
  description: string;
  environments: string[];
  version: number;
}

const ACCESS_PREFIX = "api_key:";

function accessKey(keyId: string, env: string): string {
  return `${ACCESS_PREFIX}${keyId}:environment:${env}`;
}

function accessRecord(keyId: string, env: string): ResourceRecord {
  return { key: accessKey(keyId, env), id: `${keyId}/${env}`, hash: sha256(canonicalJson({ api_key: keyId, environment: env })), label: `Contentful API key ${keyId} reading ${env}` };
}

/** An API key answer (CF7): what a write must send back, and the environments it reads. */
function parseApiKey(body: unknown): ApiKey {
  const sys = isObject(body) ? body.sys : undefined;
  if (!isObject(body) || !isObject(sys) || typeof sys.version !== "number" || !Array.isArray(body.environments)) throw new ShapeError("expected `{ name, environments, sys: { version } }`");
  const environments = body.environments.map((l) => (isObject(l) && isObject(l.sys) && typeof l.sys.id === "string" ? l.sys.id : null));
  if (environments.some((e) => e === null)) throw new ShapeError("expected `environments` to be environment links");
  return { name: typeof body.name === "string" ? body.name : "", description: typeof body.description === "string" ? body.description : "", environments: environments as string[], version: sys.version };
}

async function getApiKey(c: Client, keyId: string): Promise<ApiKey | null> {
  try {
    return await c.api.get(`${c.base}/api_keys/${enc(keyId)}`, parseApiKey);
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
}

const envLink = (id: string) => ({ sys: { type: "Link", linkType: "Environment", id } });

/**
 * Read the key, change its environments, write them back with the version read (CF6, CF7); again when another
 * writer got there first, up to VERSION_ROUNDS times. False when the key does not exist (nothing to change).
 */
async function rewriteEnvironments(c: Client, keyId: string, change: (envs: string[]) => string[]): Promise<boolean> {
  for (let round = 1; ; round++) {
    const k = await getApiKey(c, keyId);
    if (!k) return false;
    const next = change(k.environments);
    if (canonicalJson(next) === canonicalJson(k.environments)) return true;
    try {
      const body = { name: k.name, description: k.description, environments: next.map(envLink) };
      const written = await c.with({ "X-Contentful-Version": String(k.version) }).put(`${c.base}/api_keys/${enc(keyId)}`, body, parseApiKey);
      if (canonicalJson(written.environments) !== canonicalJson(next)) throw new SponsonError("PROVIDER_RESPONSE", `contentful: API key ${keyId} did not take the environments it was sent`, { adapter: ADAPTER, api_key: keyId });
      return true;
    } catch (e) {
      if (!isProviderError(e, "PROVIDER_CONFLICT") || round >= VERSION_ROUNDS) throw e;
    }
  }
}

function accessParams(params: Record<string, unknown>): { keyId: string; env: string } {
  return { keyId: stringParam(params, "api_key_id", ADAPTER), env: stringParam(params, "environment", ADAPTER) };
}

const apiKeyAccess: OpSpec = {
  outputs: {},

  lockOn(params, provider) {
    const keyId = params.api_key_id;
    if (typeof keyId !== "string" || markerKind(keyId) !== null || typeof provider.space !== "string") return null;
    return `contentful:${provider.space}:api_key:${keyId}`;
  },

  async read(actx, params) {
    if (markerKind(params.api_key_id) !== null || markerKind(params.environment) !== null) return null;
    const { keyId, env } = accessParams(params);
    const k = await getApiKey(client(actx), keyId);
    if (!k) throw paramError(ADAPTER, `API key ${keyId} does not exist in the space (Settings → API keys: the id is in the key's URL)`, "api_key_id");
    return k.environments.includes(env) ? { resources: [accessRecord(keyId, env)], outputs: {} } : null;
  },

  diff(live, params) {
    const pending = markerKind(params.api_key_id) !== null || markerKind(params.environment) !== null;
    const key = pending ? `${ACCESS_PREFIX}(pending)` : accessKey(String(params.api_key_id), String(params.environment));
    const label = `Contentful API key ${String(params.api_key_id)} reading ${String(params.environment)}`;
    if (live?.resources.some((r) => r.key === key)) return [{ key, kind: "unchanged", label }];
    const env = params.environment;
    const after = markerKind(env) !== null ? { state: "pending" as const, ref: String(env) } : { state: "literal" as const, value: String(env) };
    return [{ key, kind: "create", label, before: { state: "absent" }, after }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const { keyId, env } = accessParams(params);
    const key = accessKey(keyId, env);
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: {}, created: [] };
    await actx.intend([key]);
    actx.log(`let API key ${keyId} read environment ${env}`);
    const found = await rewriteEnvironments(client(actx), keyId, (envs) => (envs.includes(env) ? envs : [...envs, env]));
    if (!found) throw paramError(ADAPTER, `API key ${keyId} does not exist in the space`, "api_key_id");
    return { resources: [accessRecord(keyId, env)], outputs: {}, created: [key] };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) {
      const at = r.id.indexOf("/");
      if (at <= 0) continue; // an intent never located: nothing was written under it
      const [keyId, env] = [r.id.slice(0, at), r.id.slice(at + 1)];
      // A key that is gone has nothing left to remove.
      await rewriteEnvironments(c, keyId, (envs) => envs.filter((e) => e !== env));
    }
  },
};

/** One read-only request that proves the credential works, and reaches the space when the plan names it (`sponson init --setup`). */
async function verifyCredential(actx: AdapterContext): Promise<CredentialCheck> {
  const api = clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? CONTENTFUL_DEFAULT_API_URL, token: requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER) });
  const space = optionalProvider(actx, "space");
  if (!space) return verifyByGet(api, "/spaces?limit=1", "account");
  return verifyByGet(api, `/spaces/${enc(space)}/environments?limit=1`, `space ${space}`);
}

/**
 * The Contentful adapter (`adapter: contentful` in a plan). Registered in `createRegistry()`; needs
 * `CONTENTFUL_MANAGEMENT_TOKEN` and `providers.contentful.space`.
 */
export const contentfulAdapter: ResourceAdapter = { name: ADAPTER, ops: { environment, api_key_access: apiKeyAccess }, about: ABOUT, verifyCredential };
