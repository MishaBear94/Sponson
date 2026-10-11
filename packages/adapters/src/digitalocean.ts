/**
 * DigitalOcean App Platform adapter: an app per scope, created from an app spec the plan carries whole (its
 * environment variables included), and waited for until its deployment is live. App Platform has no native pull
 * request previews; this is the app per pull request that DigitalOcean's GitHub action otherwise makes. The API
 * assumptions it relies on are numbered DO1… at the top of packages/sim/src/routes/digitalocean.ts.
 *
 * - Key: `app:<spec.name>` (names are unique in an account, DO3). Id: the app's id.
 * - Hash: the spec's fields the plan declares, read back from the live spec (the platform adds defaults, DO6;
 *   those are not the plan's), with the values of `SECRET` variables left out (they read back encrypted, DO7). A
 *   console edit of a declared field is `changed` drift; a secret's value edited in the console is not seen.
 * - Writes: `PUT` of the whole spec (DO4), so a field set only in the console is lost on the next update. Every
 *   create and update starts a deployment, which `apply` waits for (`wait: false` to skip).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type DiffSide, type Literal, type LiveState, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
// Only the stable authoring API exported from `@sponson/adapters` (listed in CONTRIBUTING.md).
import { assertNoPending, clientFor, deleteIgnoringNotFound, desiredSide, optionalEnv, paramError, requireEnv } from "./common.js";
import { ShapeError, isObject, isProviderError, listAll, type ApiClient } from "./http.js";

const ADAPTER = "digitalocean";
/** The environment DigitalOcean reads (doctl's variable); declared once, used here and by the generated docs. */
const ABOUT = { credentialEnv: "DIGITALOCEAN_ACCESS_TOKEN", baseUrlEnv: "DIGITALOCEAN_API_URL", title: "DigitalOcean App Platform", category: "deploy", detect: { env: ["DIGITALOCEAN_*"], files: [".do/app.yaml", ".do/deploy.template.yaml"] } } as const;

/** DigitalOcean's API base URL (DO1). `DIGITALOCEAN_API_URL` overrides it; tests point that at the sim. */
export const DIGITALOCEAN_DEFAULT_API_URL = "https://api.digitalocean.com";

/** How often a deployment is polled, and for how long (milliseconds; overridable for tests). */
const POLL_MS = { env: "SPONSON_DIGITALOCEAN_POLL_MS", fallback: 5000 };
const DEPLOY_TIMEOUT_MS = { env: "SPONSON_DIGITALOCEAN_DEPLOY_TIMEOUT_MS", fallback: 20 * 60 * 1000 };

function msFromEnv(env: NodeJS.ProcessEnv, s: { env: string; fallback: number }): number {
  const raw = optionalEnv(env, s.env);
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : s.fallback;
}

function client(actx: AdapterContext): ApiClient {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  return clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? DIGITALOCEAN_DEFAULT_API_URL, token });
}

type Spec = Record<string, unknown>;

/** An app as the adapter reads it (DO2). */
interface App {
  id: string;
  spec: Spec;
  liveUrl?: string;
  /** The deployment a create or update started (DO5). */
  deployment?: string;
}

function parseApp(v: unknown): App {
  if (!isObject(v) || typeof v.id !== "string" || !isObject(v.spec)) throw new ShapeError("expected an app with `id` and `spec`");
  const dep = [v.pending_deployment, v.in_progress_deployment].find((d) => isObject(d) && typeof d.id === "string") as { id: string } | undefined;
  return { id: v.id, spec: v.spec, ...(typeof v.live_url === "string" && v.live_url !== "" ? { liveUrl: v.live_url } : {}), ...(dep ? { deployment: dep.id } : {}) };
}

function appOf(body: unknown): App {
  if (!isObject(body)) throw new ShapeError("expected `{ app }`");
  return parseApp(body.app);
}

// ---------------------------------------------------------------------------
// The spec and its hash
// ---------------------------------------------------------------------------

/** The plan's spec; PARAM_INVALID unless it is a map with a `name`. */
function specParam(params: Record<string, unknown>): Spec {
  const spec = params.spec;
  if (!isObject(spec)) throw paramError(ADAPTER, "param `spec` is required: the whole app spec, as a map", "spec");
  if (markerKind(spec.name) === null && (typeof spec.name !== "string" || spec.name === "")) throw paramError(ADAPTER, "`spec.name` is required: the app's name, unique in the account", "spec.name");
  return spec;
}

/** `live` reduced to the fields `desired` declares, recursively (maps by key, lists by position). */
function projectSpec(live: unknown, desired: unknown): unknown {
  if (isObject(desired)) return Object.fromEntries(Object.entries(desired).map(([k, v]) => [k, projectSpec(isObject(live) ? live[k] : undefined, v)]));
  if (Array.isArray(desired)) return desired.map((d, i) => projectSpec(Array.isArray(live) ? live[i] : undefined, d));
  return live ?? null;
}

/** The spec with the value of every `type: SECRET` variable replaced by a placeholder: it reads back encrypted (DO7). */
function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (!isObject(v)) return v;
  const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskSecrets(x)]));
  if (out.type === "SECRET" && "value" in out) out.value = "(secret)";
  return out;
}

function specHash(spec: unknown): string {
  return sha256(canonicalJson(maskSecrets(spec)));
}

const PREFIX = "app:";

function appRecord(name: string, id: string, hash: string): ResourceRecord {
  return { key: `${PREFIX}${name}`, id, hash, label: `DigitalOcean app ${name}` };
}

function outputsOf(app: App): Record<string, Literal> {
  return { app_id: app.id, ...(app.liveUrl ? { live_url: app.liveUrl } : {}) };
}

/** The first pending or secret marker anywhere in the spec. */
function firstMarker(v: unknown): string | undefined {
  const kind = markerKind(v);
  if (kind === "pending" || kind === "secret") return v as string;
  const children = Array.isArray(v) ? v : isObject(v) ? Object.values(v) : [];
  for (const c of children) {
    const m = firstMarker(c);
    if (m !== undefined) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading, waiting
// ---------------------------------------------------------------------------

/** What `read` found, kept for `apply` of the same inspection. */
const found = new WeakMap<LiveState, App>();

/** The app named `name`, from the paged list (DO2, DO3); null when there is none. */
async function findApp(api: ApiClient, name: string): Promise<App | null> {
  const apps = await listAll(api, "/v2/apps?per_page=100", (body, n) => {
    if (!isObject(body)) throw new ShapeError("expected `{ apps, links }`");
    const list = Array.isArray(body.apps) ? body.apps.map(parseApp) : [];
    const pages = isObject(body.links) && isObject(body.links.pages) ? body.links.pages : {};
    return { items: list, next: typeof pages.next === "string" ? { page: String(n + 2) } : null };
  });
  return apps.find((a) => a.spec.name === name) ?? null;
}

/** The phase of a deployment (DO5). */
async function phaseOf(api: ApiClient, app: string, deployment: string): Promise<string> {
  return api.get(`/v2/apps/${encodeURIComponent(app)}/deployments/${encodeURIComponent(deployment)}`, (b) => {
    if (!isObject(b) || !isObject(b.deployment) || typeof b.deployment.phase !== "string") throw new ShapeError("expected `{ deployment: { phase } }`");
    return b.deployment.phase;
  });
}

const DONE = ["ACTIVE", "SUPERSEDED"];
const FAILED = ["ERROR", "CANCELED"];

/** Poll the deployment a write started until it is live (DO5); a failed one fails the line. */
async function waitDeployed(actx: AdapterContext, api: ApiClient, name: string, app: App): Promise<App> {
  if (!app.deployment) return app;
  const deadline = Date.now() + msFromEnv(actx.env, DEPLOY_TIMEOUT_MS);
  for (;;) {
    const phase = await phaseOf(api, app.id, app.deployment);
    if (DONE.includes(phase)) return api.get(`/v2/apps/${encodeURIComponent(app.id)}`, appOf);
    if (FAILED.includes(phase)) throw new SponsonError("PROVIDER_INVALID", `digitalocean: the deployment of app ${name} ended ${phase}; see its build and deploy logs`, { adapter: ADAPTER, app: name });
    if (Date.now() > deadline) {
      throw new SponsonError("WAIT_TIMEOUT", `digitalocean: app ${name} is not deployed after ${msFromEnv(actx.env, DEPLOY_TIMEOUT_MS)}ms (${DEPLOY_TIMEOUT_MS.env}); run again to keep waiting`, { adapter: ADAPTER, app: name });
    }
    actx.log(`app ${name}: deployment ${phase}`);
    await sleep(msFromEnv(actx.env, POLL_MS));
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function waits(params: Record<string, unknown>): boolean {
  if (params.wait !== undefined && typeof params.wait !== "boolean") throw paramError(ADAPTER, "param `wait` must be true or false", "wait");
  return params.wait !== false;
}

async function update(actx: AdapterContext, api: ApiClient, spec: Spec, existing: App, wait: boolean) {
  const name = String(spec.name);
  actx.log(`update app ${name}`);
  const app = await api.put(`/v2/apps/${encodeURIComponent(existing.id)}`, { spec }, appOf);
  const done = wait ? await waitDeployed(actx, api, name, app) : app;
  return { resources: [appRecord(name, done.id, specHash(spec))], outputs: outputsOf(done), created: [] };
}

async function create(actx: AdapterContext, api: ApiClient, spec: Spec, wait: boolean) {
  const name = String(spec.name);
  const key = `${PREFIX}${name}`;
  await actx.intend([key]);
  actx.log(`create app ${name}`);
  let app: App;
  try {
    app = await api.post("/v2/apps", { spec }, appOf);
  } catch (e) {
    if (!isProviderError(e, "PROVIDER_CONFLICT")) throw e;
    // It exists already (DO3): ours from a create whose answer was lost, or someone else's. Not created by this
    // call; the engine claims it when an earlier intent of ours named it.
    const existing = await findApp(api, name);
    if (!existing) throw e;
    return update(actx, api, spec, existing, wait);
  }
  const done = wait ? await waitDeployed(actx, api, name, app) : app;
  return { resources: [appRecord(name, done.id, specHash(spec))], outputs: outputsOf(done), created: [key] };
}

function pendingDiff(name: unknown, marker: string): ReturnType<OpSpec["diff"]> {
  const key = markerKind(name) !== null ? `${PREFIX}(pending)` : `${PREFIX}${String(name)}`;
  return [{ key, kind: "create", label: `DigitalOcean app ${String(name)}`, before: { state: "absent" }, after: desiredSide(marker, false) }];
}

/** A spec shown by its hash: it may hold resolved secret values, which never belong in a diff. */
function specSide(spec: Spec): DiffSide {
  return { state: "literal", value: `spec ${specHash(spec).slice(0, 12)}` };
}

const app: OpSpec = {
  outputs: { app_id: { available: "immediate" }, live_url: { available: "immediate" } },

  async read(actx, params) {
    const spec = specParam(params);
    if (markerKind(spec.name) !== null) return null;
    const live = await findApp(client(actx), String(spec.name));
    if (!live) return null;
    const state: LiveState = { resources: [appRecord(String(spec.name), live.id, specHash(projectSpec(live.spec, spec)))], outputs: outputsOf(live) };
    found.set(state, live);
    return state;
  },

  diff(live, params) {
    const spec = specParam(params);
    const marker = firstMarker(spec);
    const key = `${PREFIX}${String(spec.name)}`;
    const label = `DigitalOcean app ${String(spec.name)}`;
    const current = live?.resources.find((r) => r.key === key);
    if (marker !== undefined && !current) return pendingDiff(spec.name, marker);
    if (!current) return [{ key, kind: "create", label, before: { state: "absent" }, after: specSide(spec) }];
    if (marker !== undefined) return [{ key, kind: "update", label, before: { state: "literal", value: `spec ${current.hash.slice(0, 12)}` }, after: desiredSide(marker, false) }];
    if (current.hash === specHash(spec)) return [{ key, kind: "unchanged", label }];
    return [{ key, kind: "update", label, before: { state: "literal", value: `spec ${current.hash.slice(0, 12)}` }, after: specSide(spec) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const spec = specParam(params);
    const wait = waits(params);
    const api = client(actx);
    const key = `${PREFIX}${String(spec.name)}`;
    const current = live?.resources.find((r) => r.key === key);
    const existing = live ? found.get(live) : undefined;
    if (current && live && current.hash === specHash(spec)) return { resources: live.resources, outputs: live.outputs, created: [] };
    if (existing) return update(actx, api, spec, existing, wait);
    return create(actx, api, spec, wait);
  },

  async destroy(actx, resources) {
    const api = client(actx);
    // An intent the engine could not locate has no id: nothing is deleted on a guess.
    for (const r of resources) if (r.id !== "") await deleteIgnoringNotFound(api, `/v2/apps/${encodeURIComponent(r.id)}`);
  },
};

/** The DigitalOcean adapter (`adapter: digitalocean` in a plan). Registered in `createRegistry()`; needs `DIGITALOCEAN_ACCESS_TOKEN`. */
export const digitaloceanAdapter: ResourceAdapter = { name: ADAPTER, ops: { app }, about: ABOUT };
