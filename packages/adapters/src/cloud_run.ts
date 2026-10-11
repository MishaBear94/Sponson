/**
 * Google Cloud Run adapter: op `revision`, a revision of an existing service per scope, made from the service's
 * template with the plan's image and environment variables, reachable at its own tag URL and given no traffic. This
 * is what `gcloud run deploy --no-traffic --tag pr-42 --update-env-vars …` does, as a line Sponson can re-apply, check
 * for drift and destroy. The API assumptions it relies on are numbered CR1… at the top of
 * packages/sim/src/routes/cloud_run.ts.
 *
 * - Key: `revision:<service>:<tag>`. Id: the revision's name, `<service>-<tag>-<hash>`: a new image or variable value
 *   makes a new revision (revisions are immutable, CR4), and the same values find the same one again.
 * - Hash: the tagged revision's image and the values of the variables the line declares (others come from the
 *   service's template and are not the plan's). A console redeploy under the tag with another value, or the tag moved
 *   to another revision, is `changed` drift; the tag removed is `missing`.
 * - Writes: `PATCH` of the service with an `updateMask` and its `etag` (CR3, CR8), each waited for until its operation
 *   is done (CR9): the template with the new revision's name (traffic on LATEST pinned to the revision it serves, so
 *   no traffic moves, CR5), then the traffic list with the tag on the new revision. Destroy removes the tag; the
 *   revision is left for Cloud Run to delete (CR12).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type DiffSide, type Literal, type LiveState, type OpSpec, type ResolvedParams, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { assertNoPending, desiredSide, optionalEnv, paramError, requireProvider, stringParam } from "./common.js";
import { ShapeError, isObject, isProviderError, type ApiClient } from "./http.js";
import { DEFAULT_AUTH_DEPS, type AuthDeps } from "./http-adapter-auth.js";
import { httpClient, withDeps } from "./http-adapter-client.js";

const ADAPTER = "cloud_run";
/** The command the adapter takes its access token from (CR1): the active gcloud account's. */
const TOKEN_COMMAND = ["gcloud", "auth", "print-access-token"] as const;
/** What a user configures, declared once: used below and by the generated docs and `sponson init` (`about`). */
const ABOUT = {
  credentialEnv: TOKEN_COMMAND.join(" "),
  credentialCommand: TOKEN_COMMAND,
  credentialUrl: "https://console.cloud.google.com/iam-admin/iam",
  credentialScope: "Sign in with `gcloud auth login` as an identity holding Cloud Run Developer (roles/run.developer) and Service Account User on the service's runtime service account.",
  baseUrlEnv: "CLOUD_RUN_API_URL",
  title: "Google Cloud Run",
  category: "deploy",
  detect: { deps: ["@google-cloud/run"], env: ["CLOUD_RUN_*", "K_SERVICE"] },
} as const;

/** The Cloud Run Admin API's origin (CR1); requests go to `/v2/…`. `CLOUD_RUN_API_URL` overrides it (tests: the sim). */
export const CLOUD_RUN_DEFAULT_API_URL = "https://run.googleapis.com";

/** How often an operation or a revision is polled, and for how long (milliseconds; overridable for tests). */
const POLL_MS = { env: "SPONSON_CLOUD_RUN_POLL_MS", fallback: 2000 };
const TIMEOUT_MS = { env: "SPONSON_CLOUD_RUN_TIMEOUT_MS", fallback: 10 * 60 * 1000 };
/** A patch refused because the service changed since it was read (CR8) is read and tried again this often. */
const ATTEMPTS = 3;

const LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const BY_REVISION = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
/** A revision name's limit (CR4). */
const MAX_REVISION_NAME = 63;
const TAG = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

function msFromEnv(env: NodeJS.ProcessEnv, s: { env: string; fallback: number }): number {
  const raw = optionalEnv(env, s.env);
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : s.fallback;
}

/** The client: the shared HTTP client with the `command` credential the generic adapter uses for gcloud tokens. */
function client(actx: AdapterContext): ApiClient {
  const block = { base_url: CLOUD_RUN_DEFAULT_API_URL, base_url_env: ABOUT.baseUrlEnv, auth: { command: [...TOKEN_COMMAND] } };
  return httpClient(actx, {}, { block, where: "providers.cloud_run", adapter: ADAPTER, credentialWhere: "the Cloud Run credential: gcloud on PATH, logged in" });
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Where the service is: `providers.cloud_run.project` and `.region`. */
interface Place {
  project: string;
  region: string;
}

function placeOf(actx: AdapterContext): Place {
  return { project: requireProvider(actx, "project", ADAPTER), region: requireProvider(actx, "region", ADAPTER) };
}

/** A line's params, checked, with every value concrete (apply). */
interface Spec {
  service: string;
  tag: string;
  image: string;
  env: Record<string, string>;
  container: string | undefined;
  /** May traffic on LATEST be pinned (`pin_latest`)? */
  pinLatest: boolean;
}

function envParam(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw paramError(ADAPTER, "param `env` must be a map of NAME → value", "env");
  for (const [name, value] of Object.entries(v)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw paramError(ADAPTER, `\`env\`: ${JSON.stringify(name)} is not a variable name`, "env");
    if (markerKind(value) === "keep") throw paramError(ADAPTER, `\`env.${name}\`: \`{ keep: true }\` cannot be kept: a revision is made whole from the plan; give the value`, "env");
    if (markerKind(value) === null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw paramError(ADAPTER, `\`env.${name}\` must be a string, number or boolean`, "env");
  }
  return v;
}

function tagParam(params: ResolvedParams): string {
  const tag = stringParam(params, "tag", ADAPTER);
  if (markerKind(tag) === null && !TAG.test(tag)) throw paramError(ADAPTER, `\`tag\` ${JSON.stringify(tag)} must be lowercase letters, digits and -, starting with a letter and not ending with -`, "tag");
  return tag;
}

function containerParam(params: ResolvedParams): string | undefined {
  return params.container === undefined ? undefined : stringParam(params, "container", ADAPTER);
}

function specOf(params: ResolvedParams): Spec {
  const env = Object.fromEntries(Object.entries(envParam(params.env)).map(([k, v]) => [k, String(v)]));
  return { service: stringParam(params, "service", ADAPTER), tag: tagParam(params), image: stringParam(params, "image", ADAPTER), env, container: containerParam(params), pinLatest: pinLatestParam(params) };
}

function keyOf(service: string, tag: string): string {
  return `revision:${service}:${tag}`;
}

/** Inverse of keyOf: a service name and a tag never contain `:`. */
function parseKey(key: string): { service: string; tag: string } {
  const [kind, service, tag, extra] = key.split(":");
  if (kind !== "revision" || !service || !tag || extra !== undefined) throw new SponsonError("INTERNAL", `${ADAPTER}: \`${key}\` is not a revision key`, { adapter: ADAPTER, key });
  return { service, tag };
}

/** What the hash covers: the image and the declared variables' values (null: not set to a plain value). */
function contentHash(image: unknown, env: Record<string, string | null>): string {
  return sha256(canonicalJson({ image: image ?? null, env }));
}

/** `<service>-<tag>-<first 8 of the hash>`: the same contents name the same revision (CR4's rules). */
function revisionName(s: Spec, hash: string): string {
  const name = `${s.service}-${s.tag}-${hash.slice(0, 8)}`;
  if (name.length > MAX_REVISION_NAME) throw paramError(ADAPTER, `the revision name ${name} would be longer than ${MAX_REVISION_NAME} characters; give a shorter \`tag\``, "tag");
  return name;
}

// ---------------------------------------------------------------------------
// Response shapes (CR2, CR9, CR10)
// ---------------------------------------------------------------------------

type Target = Record<string, unknown> & { type?: string; revision?: string; percent?: number; tag?: string };

interface Service {
  etag: string | undefined;
  template: Record<string, unknown>;
  traffic: Target[];
  statuses: Target[];
  latestReady: string | undefined;
}

/** The last path segment: a revision may be named in full or short (CR7). */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

function parseService(body: unknown): Service {
  if (!isObject(body) || !isObject(body.template)) throw new ShapeError("expected a Service with a `template`");
  const list = (v: unknown, what: string): Target[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(isObject)) throw new ShapeError(`expected \`${what}\` to be a list of objects`);
    return v as Target[];
  };
  return {
    etag: typeof body.etag === "string" ? body.etag : undefined,
    template: body.template,
    traffic: list(body.traffic, "traffic"),
    statuses: list(body.trafficStatuses, "trafficStatuses"),
    latestReady: typeof body.latestReadyRevision === "string" && body.latestReadyRevision !== "" ? shortName(body.latestReadyRevision) : undefined,
  };
}

interface Operation {
  name: string;
  done: boolean;
  error?: string;
}

const OPERATION_NAME = /^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/;

function parseOperation(body: unknown): Operation {
  if (!isObject(body) || typeof body.name !== "string" || !OPERATION_NAME.test(body.name)) throw new ShapeError("expected an Operation with a `name` projects/…/locations/…/operations/…");
  const err = isObject(body.error) ? `${typeof body.error.message === "string" ? body.error.message : "failed"} (code ${String(body.error.code)})` : undefined;
  return { name: body.name, done: body.done === true, ...(err !== undefined ? { error: err } : {}) };
}

interface Revision {
  containers: Array<Record<string, unknown>>;
  ready: "yes" | "no" | "failed";
}

function parseRevision(body: unknown): Revision {
  if (!isObject(body) || !Array.isArray(body.containers) || !body.containers.every(isObject)) throw new ShapeError("expected a Revision with `containers`");
  const conditions = Array.isArray(body.conditions) ? body.conditions.filter(isObject) : [];
  const state = conditions.find((c) => c.type === "Ready")?.state;
  return { containers: body.containers as Array<Record<string, unknown>>, ready: state === "CONDITION_SUCCEEDED" ? "yes" : state === "CONDITION_FAILED" ? "failed" : "no" };
}

/** The container the line sets: the one it names, the only one, or the one that takes requests (has `ports`). */
function containerIn(containers: Array<Record<string, unknown>>, name: string | undefined, service: string): Record<string, unknown> {
  const pick = name !== undefined ? containers.find((c) => c.name === name) : containers.length === 1 ? containers[0] : containers.find((c) => Array.isArray(c.ports) && c.ports.length > 0);
  if (pick) return pick;
  throw paramError(ADAPTER, name !== undefined ? `service ${service} has no container named ${name}` : `service ${service} has several containers and none takes requests; name one with \`container\``, "container");
}

/** The declared variables' live values: a plain `value`, else null (unset, or a `valueSource` such as a secret, CR10). */
function liveEnv(container: Record<string, unknown>, names: string[]): Record<string, string | null> {
  const env = Array.isArray(container.env) ? container.env.filter(isObject) : [];
  return Object.fromEntries(names.map((n) => [n, ((v) => (typeof v === "string" ? v : null))(env.find((e) => e.name === n)?.value)]));
}

/** A revision's hash as the line sees it: its container's image and the line's variables. */
function revisionHash(rev: Revision, service: string, container: string | undefined, names: string[]): string {
  const c = containerIn(rev.containers, container, service);
  return contentHash(c.image, liveEnv(c, names));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function servicePath(p: Place, service: string): string {
  return `/v2/projects/${encodeURIComponent(p.project)}/locations/${encodeURIComponent(p.region)}/services/${encodeURIComponent(service)}`;
}

async function getService(api: ApiClient, p: Place, service: string): Promise<Service | null> {
  try {
    return await api.get(servicePath(p, service), parseService);
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
}

async function requireService(api: ApiClient, p: Place, service: string): Promise<Service> {
  const svc = await getService(api, p, service);
  if (svc) return svc;
  throw paramError(ADAPTER, `service ${service} does not exist in ${p.project}/${p.region}: Sponson makes revisions of an existing service (deploy it once first)`, "service");
}

async function getRevision(api: ApiClient, p: Place, service: string, name: string): Promise<Revision | null> {
  try {
    return await api.get(`${servicePath(p, service)}/revisions/${encodeURIComponent(name)}`, parseRevision);
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
}

function timeout(actx: AdapterContext, what: string): SponsonError {
  return new SponsonError("WAIT_TIMEOUT", `${ADAPTER}: ${what} after ${msFromEnv(actx.env, TIMEOUT_MS)}ms (${TIMEOUT_MS.env}); run again to keep waiting`, { adapter: ADAPTER });
}

/** Poll an operation until it is done (CR9); an `error` fails the line with the provider's message. */
async function waitOperation(actx: AdapterContext, api: ApiClient, first: Operation, what: string): Promise<void> {
  const deadline = Date.now() + msFromEnv(actx.env, TIMEOUT_MS);
  let op = first;
  while (!op.done) {
    if (Date.now() > deadline) throw timeout(actx, `${what} is not done`);
    actx.log(`${what}: waiting for ${op.name}`);
    await sleep(msFromEnv(actx.env, POLL_MS));
    op = await api.get(`/v2/${op.name}`, parseOperation);
  }
  if (op.error !== undefined) throw new SponsonError("PROVIDER_INVALID", `${ADAPTER}: ${what} failed: ${actx.redact(op.error).slice(0, 500)}`, { adapter: ADAPTER, operation: op.name });
}

/** Poll the revision until its Ready condition holds (CR10): one found after a lost answer may still be coming up. */
async function waitReady(actx: AdapterContext, api: ApiClient, p: Place, s: Spec, name: string): Promise<void> {
  const deadline = Date.now() + msFromEnv(actx.env, TIMEOUT_MS);
  for (;;) {
    const rev = await getRevision(api, p, s.service, name);
    if (rev?.ready === "yes") return;
    if (rev?.ready === "failed") throw new SponsonError("PROVIDER_INVALID", `${ADAPTER}: revision ${name} failed to become ready; see its logs in the Cloud Run console`, { adapter: ADAPTER, revision: name });
    if (Date.now() > deadline) throw timeout(actx, `revision ${name} is not ready`);
    await sleep(msFromEnv(actx.env, POLL_MS));
  }
}

/** PATCH the service with `fields` and its etag (CR3, CR8), and wait for the operation. */
async function patch(actx: AdapterContext, api: ApiClient, p: Place, service: string, svc: Service, fields: Record<string, unknown>, what: string): Promise<void> {
  const path = `${servicePath(p, service)}?updateMask=${Object.keys(fields).join(",")}`;
  actx.log(what);
  // Safe to send twice: a repeat carries the old etag and is refused (CR8), then read again.
  const op = await api.patch(path, { ...fields, ...(svc.etag !== undefined ? { etag: svc.etag } : {}) }, parseOperation, { idempotent: true });
  await waitOperation(actx, api, op, what);
}

/**
 * `traffic` with every LATEST target bound to the revision it serves now, or null when there is none: a template
 * change then gives the new revision no traffic (CR5). Empty traffic means 100% to LATEST.
 */
function pinned(svc: Service, service: string, allowed: boolean): Target[] | null {
  const traffic = svc.traffic.length > 0 ? svc.traffic : [{ type: LATEST, percent: 100 }];
  if (!followsLatest(svc)) return null;
  if (!allowed) throw latestRefusal(svc, service);
  if (!svc.latestReady) throw new SponsonError("PROVIDER_INVALID", `${ADAPTER}: service ${service} sends traffic to its latest revision but has no ready revision to keep it on`, { adapter: ADAPTER, service });
  return traffic.map((t) => (t.type === LATEST ? { ...t, type: BY_REVISION, revision: svc.latestReady } : t));
}

/** Whether a share of the service's traffic goes to LATEST (empty traffic does, CR5): a new revision would take it. */
function followsLatest(svc: Service): boolean {
  return svc.traffic.length === 0 || svc.traffic.some((t) => t.type === LATEST);
}

/** Why a line without `pin_latest: true` may not make a revision of a service whose traffic follows LATEST. */
function latestRefusal(svc: Service, service: string): SponsonError {
  const serving = svc.latestReady ?? "the revision serving it now";
  return paramError(
    ADAPTER,
    `service ${service} sends traffic to LATEST (its latest ready revision), so a new revision would take that traffic. ` +
      `To make one without moving traffic, Sponson must pin LATEST's share to ${serving}, as \`gcloud run deploy --no-traffic\` does; ` +
      `after that, production deploys of ${service} no longer receive traffic by themselves until you run ` +
      `\`gcloud run services update-traffic ${service} --to-latest\`. Set \`pin_latest: true\` on this line to allow it, ` +
      `or pin the traffic yourself first (\`gcloud run services update-traffic ${service} --to-revisions=${svc.latestReady ?? "<revision>"}=100\`).`,
    "pin_latest",
  );
}

/** `pin_latest`: the line may pin traffic on LATEST (a permission, not state: not hashed). */
function pinLatestParam(params: ResolvedParams): boolean {
  const v = params.pin_latest;
  if (v !== undefined && typeof v !== "boolean") throw paramError(ADAPTER, "param `pin_latest` must be true or false", "pin_latest");
  return v === true;
}

/** The service's template with the new revision's name, image and variables; everything else as it is (CR4). */
function templateFor(svc: Service, s: Spec, name: string): Record<string, unknown> {
  const t = structuredClone(svc.template);
  const containers = Array.isArray(t.containers) ? (t.containers.filter(isObject) as Array<Record<string, unknown>>) : [];
  const c = containerIn(containers, s.container, s.service);
  c.image = s.image;
  const env = (Array.isArray(c.env) ? c.env.filter(isObject) : []).map((e) => (typeof e.name === "string" && e.name in s.env ? { name: e.name, value: s.env[e.name] } : e));
  const missing = Object.keys(s.env).filter((n) => !env.some((e) => e.name === n));
  c.env = [...env, ...missing.map((n) => ({ name: n, value: s.env[n] }))];
  return { ...t, revision: name };
}

/** Make the revision: the template patched, traffic on LATEST pinned so none moves. */
async function createRevision(actx: AdapterContext, api: ApiClient, p: Place, s: Spec, name: string): Promise<void> {
  const svc = await requireService(api, p, s.service);
  const traffic = pinned(svc, s.service, s.pinLatest);
  await patch(actx, api, p, s.service, svc, { template: templateFor(svc, s, name), ...(traffic ? { traffic } : {}) }, `create revision ${name} of ${s.service} (no traffic)`);
}

/** `traffic` without `tag`: a target that had only the tag goes, one with a share keeps it. */
function withoutTag(traffic: Target[], tag: string): Target[] {
  return traffic.flatMap((t) => {
    if (t.tag !== tag) return [t];
    if (!t.percent) return [];
    const { tag: _tag, ...rest } = t;
    return [rest];
  });
}

/** The tag's URL, as the service answers it (CR6); never built. */
function tagUri(svc: Service, tag: string): string | undefined {
  const uri = svc.statuses.find((t) => t.tag === tag)?.uri;
  return typeof uri === "string" && uri !== "" ? uri : undefined;
}

/** Put the tag on the revision (moving it off any other), then read its URL. */
async function tagRevision(actx: AdapterContext, api: ApiClient, p: Place, s: Spec, name: string): Promise<string> {
  let svc = await requireService(api, p, s.service);
  const current = svc.traffic.find((t) => t.tag === s.tag);
  if (current?.type !== BY_REVISION || shortName(current.revision ?? "") !== name) {
    const traffic = [...withoutTag(svc.traffic, s.tag), { type: BY_REVISION, revision: name, tag: s.tag }];
    await patch(actx, api, p, s.service, svc, { traffic }, `tag revision ${name} as ${s.tag}`);
    svc = await requireService(api, p, s.service);
  }
  const uri = tagUri(svc, s.tag);
  if (uri) return uri;
  throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: service ${s.service} lists no URL for tag ${s.tag} in \`trafficStatuses\` after tagging`, { adapter: ADAPTER, tag: s.tag });
}

/** One pass: the revision made (or found, with these contents), ready, and tagged. */
async function converge(actx: AdapterContext, api: ApiClient, p: Place, s: Spec, hash: string): Promise<{ name: string; uri: string }> {
  const name = revisionName(s, hash);
  const existing = await getRevision(api, p, s.service, name);
  if (!existing) await createRevision(actx, api, p, s, name);
  else if (revisionHash(existing, s.service, s.container, Object.keys(s.env)) !== hash) {
    // Not a conflict to retry: the name is taken for good.
    throw new SponsonError("PROVIDER_INVALID", `${ADAPTER}: revision ${name} exists with other contents; it was not made by this line`, { adapter: ADAPTER, revision: name });
  }
  await waitReady(actx, api, p, s, name);
  return { name, uri: await tagRevision(actx, api, p, s, name) };
}

/** A patch refused because someone changed the service since it was read (CR8): read again and retry. */
async function retryingConflicts<T>(actx: AdapterContext, what: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!isProviderError(e, "PROVIDER_CONFLICT") || attempt >= ATTEMPTS) throw e;
      actx.log(`${what}: the service changed meanwhile; reading it again`);
    }
  }
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

/** What the tag points at, as the line sees it; null when the tag is absent. */
async function tagged(api: ApiClient, p: Place, svc: Service, service: string, tag: string, params: ResolvedParams): Promise<LiveState | null> {
  const target = svc.traffic.find((t) => t.tag === tag);
  if (!target) return null;
  const name = target.type === LATEST ? (svc.latestReady ?? "") : shortName(target.revision ?? "");
  const rev = name ? await getRevision(api, p, service, name) : null;
  if (!rev) return null;
  // A tag on LATEST follows every deploy: never the plan's revision, so it reads as changed.
  const hash = target.type === LATEST ? sha256(`latest:${name}`) : revisionHash(rev, service, containerParam(params), Object.keys(envParam(params.env)));
  const uri = tagUri(svc, tag);
  return { resources: [record(service, tag, name, hash)], outputs: { revision: name, ...(uri ? { url: uri } : {}) } };
}

/** Whether applying would write nothing: the tag is on a revision with exactly the plan's contents. */
function unchanged(live: LiveState | null, params: ResolvedParams): boolean {
  if (!live || firstMarker(params) !== undefined) return false;
  const s = specOf(params);
  return live.resources[0]?.hash === contentHash(s.image, s.env);
}

/** The first pending or secret marker among the values that decide the revision's contents. */
function firstMarker(params: ResolvedParams): string | undefined {
  const values = [params.service, params.tag, params.image, ...Object.values(isObject(params.env) ? params.env : {})];
  return values.find((v): v is string => markerKind(v) === "pending" || markerKind(v) === "secret");
}

function record(service: string, tag: string, name: string, hash: string): ResourceRecord {
  return { key: keyOf(service, tag), id: name, hash, label: `Cloud Run revision ${name} (tag ${tag})` };
}

function nameSide(name: string): DiffSide {
  return { state: "literal", value: name };
}

const revision: OpSpec = {
  outputs: { url: { available: "immediate" }, revision: { available: "immediate" } },

  /** The tag defaults to the scope (`pr-42`). */
  defaults(params, ctx) {
    return { tag: ctx.scope, ...params };
  },

  /** Traffic is never moved, so a line writes no environment unless its provider block says the service is production. */
  writesEnvironment(_params, _ctx, provider = {}) {
    if (provider.production !== undefined && typeof provider.production !== "boolean") {
      throw new SponsonError("PLAN_INVALID", `${ADAPTER}: providers.cloud_run.production must be true or false`, { adapter: ADAPTER, key: "providers.cloud_run.production" });
    }
    return provider.production === true ? "production" : null;
  },

  /** Every line of a service writes its one `traffic` list (ADR 0019). */
  lockOn(params, provider) {
    const { project, region } = provider;
    const service = params.service;
    if (typeof project !== "string" || typeof region !== "string" || typeof service !== "string" || markerKind(service) !== null) return null;
    return `${ADAPTER}:${project}/${region}:service:${service}`;
  },

  async read(actx, params) {
    if (markerKind(params.service) !== null || markerKind(params.tag) !== null) return null;
    const service = stringParam(params, "service", ADAPTER);
    const tag = tagParam(params);
    const p = placeOf(actx);
    const api = client(actx);
    const svc = await requireService(api, p, service);
    const live = await tagged(api, p, svc, service, tag, params);
    // Refused at plan time, before any write: making a revision would pin traffic on LATEST (unless allowed).
    if (followsLatest(svc) && !pinLatestParam(params) && !unchanged(live, params)) throw latestRefusal(svc, service);
    return live;
  },

  diff(live, params) {
    const service = String(params.service);
    const tag = String(params.tag);
    const key = keyOf(service, tag);
    const label = `Cloud Run revision of ${service} (tag ${tag})`;
    const current = live?.resources.find((r) => r.key === key);
    const before = current ? nameSide(current.id) : { state: "absent" as const };
    const kind = current ? "update" : "create";
    const marker = firstMarker(params);
    if (marker !== undefined) return [{ key, kind, label, before, after: desiredSide(marker, false) }];
    const s = specOf(params);
    const hash = contentHash(s.image, s.env);
    if (current?.hash === hash) return [{ key, kind: "unchanged", label }];
    return [{ key, kind, label, before, after: nameSide(revisionName(s, hash)) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const s = specOf(params);
    const hash = contentHash(s.image, s.env);
    const key = keyOf(s.service, s.tag);
    const current = live?.resources.find((r) => r.key === key);
    if (current?.hash === hash && live) return { resources: live.resources, outputs: live.outputs, created: [] };
    if (!current) await actx.intend([key]);
    const p = placeOf(actx);
    const api = client(actx);
    const done = await retryingConflicts(actx, `revision of ${s.service}`, () => converge(actx, api, p, s, hash));
    const outputs: Record<string, Literal> = { url: done.uri, revision: done.name };
    return { resources: [record(s.service, s.tag, done.name, hash)], outputs, created: current ? [] : [key] };
  },

  /** Removes the tag (only the tag: traffic shares stay); the revision is left for Cloud Run to delete (CR12). */
  async destroy(actx, resources) {
    const p = placeOf(actx);
    const api = client(actx);
    for (const r of resources) {
      const { service, tag } = parseKey(r.key);
      await retryingConflicts(actx, `untag ${tag}`, async () => {
        const svc = await getService(api, p, service);
        if (!svc?.traffic.some((t) => t.tag === tag)) return;
        await patch(actx, api, p, service, svc, { traffic: withoutTag(svc.traffic, tag) }, `remove tag ${tag} from ${service}`);
      });
    }
  },
};

/** The Cloud Run adapter with how its gcloud command runs injected (tests); the registered one runs gcloud from PATH. */
export function createCloudRunAdapter(deps: Partial<AuthDeps> = {}): ResourceAdapter {
  return { name: ADAPTER, ops: { revision: withDeps(revision, { ...DEFAULT_AUTH_DEPS, ...deps }) }, about: ABOUT };
}

/**
 * The Cloud Run adapter (`adapter: cloud_run` in a plan): op `revision`, a tagged revision per scope with the plan's
 * image and variables and no traffic. Registered in `createRegistry()`; needs `providers.cloud_run.project` and
 * `.region`, and `gcloud` on PATH logged in to an account allowed to update the service.
 */
export const cloudRunAdapter: ResourceAdapter = createCloudRunAdapter();
