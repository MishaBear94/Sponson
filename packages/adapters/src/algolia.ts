/**
 * Algolia adapter: an index per scope, copied from a template index. The copy is an asynchronous task, so `apply`
 * waits for it to be published before the line counts as applied: that wait is why this is an adapter and not an
 * `http` recipe (ADR 0017, "No polling"). The API assumptions it relies on are numbered AL1… at the top of
 * packages/sim/src/routes/algolia.ts.
 *
 * - Key: `index:<name>`. Id: the index name (Algolia's own identity, AL1). The application is the provider block.
 * - Hash: the name only. What was copied (`copy_from`, `scope`) is not something an index records, so it cannot be
 *   compared: changing it later does not copy again, and a console edit of the copy's records or settings is not
 *   drift. A deleted index is `missing`, and the next apply copies it again.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type Literal, type OpSpec, type ResourceAdapter, type ResourceRecord, type CredentialCheck } from "@sponson/core";
// Only the stable authoring API exported from `@sponson/adapters` (listed in CONTRIBUTING.md).
import { assertNoPending, clientFor, deleteIgnoringNotFound, optionalEnv, paramError, requireEnv, requireProvider, stringParam, verifyByGet } from "./common.js";
import { ShapeError, isObject, isProviderError, type ApiClient } from "./http.js";

const ADAPTER = "algolia";
/** The environment Algolia reads; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = { credentialEnv: "ALGOLIA_API_KEY", credentialUrl: "https://dashboard.algolia.com/account/api-keys/", credentialScope: "A restricted API key (not the Admin key) with the addObject, deleteIndex, editSettings, settings and listIndexes ACLs.", baseUrlEnv: "ALGOLIA_API_URL", title: "Algolia", category: "search-payments", detect: { deps: ["algoliasearch", "@algolia/", "instantsearch.js", "react-instantsearch"], env: ["ALGOLIA_*"] } } as const;

/** How often the copy task is polled, and for how long (milliseconds; overridable for tests). */
const POLL_MS = { env: "SPONSON_ALGOLIA_POLL_MS", fallback: 1000 };
const TASK_TIMEOUT_MS = { env: "SPONSON_ALGOLIA_TASK_TIMEOUT_MS", fallback: 5 * 60 * 1000 };

function msFromEnv(env: NodeJS.ProcessEnv, s: { env: string; fallback: number }): number {
  const raw = optionalEnv(env, s.env);
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : s.fallback;
}

/** The client for the application in `providers.algolia.application_id` (AL2: `https://<app id>.algolia.net`). */
function client(actx: AdapterContext): ApiClient {
  const key = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const appId = requireProvider(actx, "application_id", ADAPTER);
  const baseUrl = optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? `https://${appId}.algolia.net`;
  return clientFor(actx, ADAPTER, { baseUrl, token: key, authHeader: "header:x-algolia-api-key", headers: { "X-Algolia-Application-Id": appId } });
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

const PREFIX = "index:";

function indexRecord(name: string): ResourceRecord {
  return { key: `${PREFIX}${name}`, id: name, hash: sha256(canonicalJson({ name })), label: `Algolia index ${name}` };
}

function outputsOf(name: string): Record<string, Literal> {
  return { name };
}

/** Whether the index exists: its settings answer 200, or 404 (AL4). Reads only. */
async function exists(api: ApiClient, name: string): Promise<boolean> {
  try {
    await api.get(`/1/indexes/${enc(name)}/settings`);
    return true;
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return false;
    throw e;
  }
}

const SCOPES = ["settings", "synonyms", "rules"];

/** The copy's `scope`: absent (everything, records included), or a list of settings, synonyms and rules (AL3). */
function scopeParam(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === "string" && SCOPES.includes(s))) {
    throw paramError(ADAPTER, `param \`scope\` must be a non-empty list of ${SCOPES.join(", ")} (left out: records too)`, "scope");
  }
  return v as string[];
}

/** The task id of a copy answer (AL3). */
function taskOf(body: unknown): number {
  if (!isObject(body) || typeof body.taskID !== "number") throw new ShapeError("expected `{ taskID }`");
  return body.taskID;
}

/** Poll the copy task until it is published (AL5); WAIT_TIMEOUT when it is not, which the next run resumes. */
async function waitPublished(actx: AdapterContext, api: ApiClient, name: string, task: number): Promise<void> {
  const deadline = Date.now() + msFromEnv(actx.env, TASK_TIMEOUT_MS);
  for (;;) {
    const status = await api.get(`/1/indexes/${enc(name)}/task/${task}`, (b) => {
      if (!isObject(b) || typeof b.status !== "string") throw new ShapeError("expected `{ status }`");
      return b.status;
    });
    if (status === "published") return;
    if (Date.now() > deadline) {
      throw new SponsonError("WAIT_TIMEOUT", `algolia: the copy into index ${name} (task ${task}) is not published after ${msFromEnv(actx.env, TASK_TIMEOUT_MS)}ms (${TASK_TIMEOUT_MS.env}); run again to keep waiting`, { adapter: ADAPTER, index: name });
    }
    actx.log(`copy into ${name} not published yet`);
    await sleep(msFromEnv(actx.env, POLL_MS));
  }
}

function names(params: Record<string, unknown>): { name: string; source: string } {
  const name = stringParam(params, "name", ADAPTER);
  const source = stringParam(params, "copy_from", ADAPTER);
  if (name === source) throw paramError(ADAPTER, "`name` and `copy_from` are the same index: the copy would overwrite its own template", "name");
  return { name, source };
}

const index: OpSpec = {
  outputs: { name: { available: "immediate" } },

  async read(actx, params) {
    if (markerKind(params.name) !== null) return null;
    const name = stringParam(params, "name", ADAPTER);
    if (!(await exists(client(actx), name))) return null;
    return { resources: [indexRecord(name)], outputs: outputsOf(name) };
  },

  diff(live, params) {
    const name = params.name;
    const key = markerKind(name) !== null ? `${PREFIX}(pending)` : `${PREFIX}${String(name)}`;
    const label = `Algolia index ${String(name)}`;
    if (live?.resources.some((r) => r.key === key)) return [{ key, kind: "unchanged", label }];
    const source = params.copy_from;
    const after = markerKind(source) !== null ? { state: "pending" as const, ref: String(source) } : { state: "literal" as const, value: `copy of ${String(source)}` };
    return [{ key, kind: "create", label, before: { state: "absent" }, after }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const { name, source } = names(params);
    const scope = scopeParam(params.scope);
    const key = `${PREFIX}${name}`;
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: live.outputs, created: [] };
    const api = client(actx);
    // Copying an index that does not exist makes an empty one (AL3): refuse instead of handing out an empty index.
    if (!(await exists(api, source))) throw paramError(ADAPTER, `\`copy_from\` index ${source} does not exist in the application`, "copy_from");
    // Announce the copy before sending it. A copy whose answer was lost is sent again by the next run, which
    // overwrites the destination with the template once more (AL3): harmless before anyone wrote to it.
    await actx.intend([key]);
    actx.log(`copy ${source} to ${name}`);
    const task = await api.post(`/1/indexes/${enc(source)}/operation`, { operation: "copy", destination: name, ...(scope ? { scope } : {}) }, taskOf, { idempotent: true });
    await waitPublished(actx, api, name, task);
    return { resources: [indexRecord(name)], outputs: outputsOf(name), created: [key] };
  },

  async destroy(actx, resources) {
    const api = client(actx);
    // Deleting an index that does not exist is ignored (AL6); a 404 is gone all the same.
    // An intent the engine could not locate has no id: nothing is known to exist under it (the engine reports it).
    for (const r of resources) if (r.id !== "") await deleteIgnoringNotFound(api, `/1/indexes/${enc(r.id)}`);
  },
};

/** One read-only request that proves the credential works, and reaches the project when the plan names it (`sponson init --setup`). */
async function verifyCredential(actx: AdapterContext): Promise<CredentialCheck> {
  return verifyByGet(client(actx), "/1/indexes?page=0&hitsPerPage=1", `application ${String(actx.provider.application_id)}`);
}

/**
 * The Algolia adapter (`adapter: algolia` in a plan). Registered in `createRegistry()`; needs `ALGOLIA_API_KEY`
 * (with the addObject, deleteIndex and settings ACLs) and `providers.algolia.application_id`.
 */
export const algoliaAdapter: ResourceAdapter = { name: ADAPTER, ops: { index }, about: ABOUT, verifyCredential };
