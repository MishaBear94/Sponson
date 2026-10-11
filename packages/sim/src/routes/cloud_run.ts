/**
 * Simulated Google Cloud Run Admin API v2: services whose every template change makes an immutable revision, their
 * traffic targets and tags, and the long-running operations a patch answers with.
 *
 * Assumptions about the real API this fake encodes, checked against the official REST reference and discovery
 * document (https://run.googleapis.com/$discovery/rest?version=v2, called DISC below) unless marked unverified. The
 * critical ones are pinned in scenarios/contract.test.ts (`assumption CR…`).
 *   CR1. The API is `https://run.googleapis.com/v2`; every method takes an OAuth access token with the
 *        `cloud-platform` scope as `Authorization: Bearer`, which `gcloud auth print-access-token` prints for the
 *        active account. (verified: DISC; https://docs.cloud.google.com/sdk/gcloud/reference/auth/print-access-token)
 *   CR2. `GET /v2/projects/{project}/locations/{region}/services/{service}` answers the Service: `etag` ("may be used
 *        to detect modification conflict during updates"), `template`, `traffic`, `trafficStatuses`,
 *        `latestReadyRevision`, `latestCreatedRevision`, `reconciling`, and `generation` as a JSON string (int64).
 *        (verified: DISC, https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services)
 *   CR3. `PATCH /v2/{service.name}?updateMask=<fields>` takes a Service and answers a long-running Operation; only the
 *        fields the mask names are written. (verified: https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch;
 *        the sim refuses a patch without a mask, which the adapter never sends)
 *   CR4. Each change of `template` makes a new, immutable revision; `template.revision` names it ("If this field is
 *        omitted, it will be automatically generated based on the Service name"). A name starts with the service's
 *        name and `-`, has only lowercase letters, digits and `-`, does not end with `-` and is at most 63 characters.
 *        (verified: DISC; https://docs.cloud.google.com/run/docs/configuring/services/containers) A name already
 *        taken is refused (unverified: the sim answers 409 ALREADY_EXISTS).
 *   CR5. A TrafficTarget is `{ type, revision, percent, tag }`, `type` `TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST` or
 *        `…_REVISION`, `percent` zero when left out; empty `traffic` means 100% to the latest ready revision. LATEST
 *        follows the latest ready revision, so a template change alone moves its share to the new revision; gcloud's
 *        `--no-traffic` "assigns any traffic assigned to the LATEST revision to the specific revision bound to LATEST
 *        before the deployment", after which "the LATEST revision will not receive traffic on future deployments".
 *        (verified: DISC; https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)
 *   CR6. A `tag` gives its revision a URL of its own with no traffic ("test the new revision at a specific URL,
 *        without serving traffic"), shown in `trafficStatuses[].uri` ("Displays the target URI"); its form is not to be
 *        parsed ("Don't parse the SERVICE_IDENTIFIER"), so it is read, never built. (verified:
 *        https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration,
 *        https://docs.cloud.google.com/run/docs/triggering/https-request)
 *   CR7. Whether `latestReadyRevision`, `latestCreatedRevision` and `TrafficTarget.revision` hold a revision's short
 *        name or its full resource name is not documented (unverified): clients take the last path segment; the sim
 *        answers full names in `latest*Revision` and the names it was sent in `traffic`.
 *   CR8. The `etag` sent in a patch body is a precondition: a patch whose etag is no longer the service's is refused
 *        and changes nothing. (unverified: the docs say only that it "may be used to detect modification conflict";
 *        the sim answers 409 ABORTED)
 *   CR9. `GET /v2/{name=projects/*\/locations/*\/operations/*}` answers `{ name, done, error, response }`; when `done`,
 *        "either `error` or `response` is available". (verified: DISC) The operation of a template change ends when
 *        the new revision is ready, or with an `error` when it cannot become ready (unverified: the sim ends it after
 *        `operationPolls` polls, failing it for an image in `failImages`).
 *   CR10. `GET …/services/{service}/revisions/{revision}` answers the Revision: `containers` (`name`, `image`, `env`
 *        of `{ name, value }` or `{ name, valueSource: { secretKeyRef } }`) and `conditions` of `{ type, state }`,
 *        where type "Ready" is "True when the Resource is ready" and state is CONDITION_SUCCEEDED, CONDITION_FAILED,
 *        CONDITION_PENDING or CONDITION_RECONCILING. (verified: DISC)
 *   CR11. Once an operation has succeeded, the Service answers the new `traffic` and its `trafficStatuses`
 *        (`reconciling` false: then they "will match"). (verified: DISC, `reconciling`)
 *   CR12. Cloud Run deletes revisions by itself: past 1000 per service, "non-addressable revisions are automatically
 *        deleted in historical order"; past 2000 tags per project and region, "tags that don't have a specified
 *        traffic percentage are automatically deleted". (verified: https://docs.cloud.google.com/run/quotas) Whether
 *        a tagged revision counts as addressable is not documented. The sim does not delete anything by itself.
 *   CR13. A tag is lowercase (the only documented rule, "your lowercase tag name"); the sim also refuses one that is
 *        not a DNS label (`^[a-z]([a-z0-9-]*[a-z0-9])?$`) or that two targets share. (unverified)
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One traffic target, as sent and stored (CR5). */
export interface CloudRunTrafficTarget {
  type: string;
  revision?: string;
  percent?: number;
  tag?: string;
}

/** A revision: the template it was made from, and whether it came up (CR4, CR10). */
export interface CloudRunRevision {
  name: string;
  /** `<project>/<region>/<service>`. */
  service: string;
  template: Record<string, unknown>;
  state: "pending" | "ready" | "failed";
  createdBy: CreatedBy;
}

/** A Cloud Run service. */
export interface CloudRunService {
  project: string;
  region: string;
  name: string;
  generation: number;
  etag: string;
  template: Record<string, unknown>;
  traffic: CloudRunTrafficTarget[];
  latestCreated: string;
  latestReady: string;
  /** The part of its URLs Cloud Run makes up (CR6). */
  identifier: string;
  createdBy: CreatedBy;
}

/** A long-running operation a patch started (CR9). */
export interface CloudRunOperation {
  name: string;
  service: string;
  /** The revision it brings up, for a template change. */
  revision: string | null;
  polls: number;
  done: boolean;
  error?: { code: number; message: string };
}

/** The simulated Cloud Run's state. */
export interface CloudRunState {
  services: CloudRunService[];
  revisions: CloudRunRevision[];
  operations: CloudRunOperation[];
  /** Polls an operation answers `done: false` before it ends (default 1). */
  operationPolls: number;
  /** Images whose revisions never become ready. */
  failImages: string[];
}

/** One service a scenario or test seeds (`seed: { cloud_run: { services: [...] } }`). */
export interface CloudRunSeedService {
  /** Default `demo-project`. */
  project?: string;
  /** Default `us-central1`. */
  region?: string;
  name: string;
  image?: string;
  env?: Record<string, string>;
  /** `latest` (default): all traffic to LATEST; `pinned`: all traffic to the first revision by name. */
  traffic?: "latest" | "pinned";
}

/** What a scenario or test seeds the simulated Cloud Run with. */
export interface CloudRunSeed {
  services?: CloudRunSeedService[];
  operationPolls?: number;
  failImages?: string[];
}

const LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const BY_REVISION = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
const DEFAULT_IMAGE = "us-docker.pkg.dev/demo-project/web/app:main";

/** The simulated Cloud Run Admin API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/cloud_run`. */
export const cloudRunSim: ProviderSim<CloudRunState, CloudRunSeed> = {
  // The adapter takes its token from `gcloud auth print-access-token` (CR1); this variable is only the placeholder.
  env: { token: "CLOUD_RUN_SIM_ACCESS_TOKEN", url: "CLOUD_RUN_API_URL", testToken: "tok_cloud_run" },
  defaultSeed: { services: [{ name: "web", env: { NODE_ENV: "production", DATABASE_URL: "postgres://prod.example.com/app" } }] },

  reset(core, seed) {
    const state: CloudRunState = { services: [], revisions: [], operations: [], operationPolls: seed?.operationPolls ?? 1, failImages: [...(seed?.failImages ?? [])] };
    for (const s of seed?.services ?? []) seedService(core, state, s);
    return state;
  },

  /**
   * `service.<name>.tag.<tag>.env.<NAME>`: someone deploys the tagged revision again with that variable changed and
   * the tag moved to the new revision (`gcloud run deploy --no-traffic --tag <tag> --update-env-vars`);
   * `service.<name>.tag.<tag>` = "delete": the tag removed (`update-traffic --remove-tags`); `service.<name>.deploy`
   * = an image: a deploy of the service's template with that image (traffic as it stands, CR5).
   */
  drift(core, state, { key, rest, value, only }) {
    if (only !== undefined || !rest.startsWith("service.")) return false;
    const [name, kind, tag, sub, envName] = rest.slice("service.".length).split(".");
    const svc = state.services.find((s) => s.name === name);
    if (!svc) throw new Error(`drift ${key}: no service ${String(name)}`);
    if (kind === "deploy" && tag === undefined) deployImage(core, state, svc, value);
    else if (kind === "tag" && tag && sub === undefined && value === "delete") removeTag(core, svc, tag);
    else if (kind === "tag" && tag && sub === "env" && envName) redeployTagged(core, state, svc, tag, envName, value);
    else throw new Error(`drift ${key}: use service.<name>.deploy = <image>, service.<name>.tag.<tag> = delete, or service.<name>.tag.<tag>.env.<NAME> = <value>`);
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function keyOf(s: { project: string; region: string; name: string }): string {
  return `${s.project}/${s.region}/${s.name}`;
}

function fullName(s: CloudRunService): string {
  return `projects/${s.project}/locations/${s.region}/services/${s.name}`;
}

function revisionFullName(s: CloudRunService, revision: string): string {
  return `${fullName(s)}/revisions/${revision}`;
}

function bump(core: SimCore, svc: CloudRunService): void {
  svc.generation += 1;
  svc.etag = `"${core.nextId("etag-")}"`;
}

function seedService(core: SimCore, state: CloudRunState, s: CloudRunSeedService): void {
  const project = s.project ?? "demo-project";
  const region = s.region ?? "us-central1";
  const first = `${s.name}-00001-abc`;
  const template = { containers: [{ name: "app", image: s.image ?? DEFAULT_IMAGE, ports: [{ containerPort: 8080 }], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) }] };
  const svc: CloudRunService = {
    project,
    region,
    name: s.name,
    generation: 1,
    etag: `"${core.nextId("etag-")}"`,
    template,
    traffic: s.traffic === "pinned" ? [{ type: BY_REVISION, revision: first, percent: 100 }] : [{ type: LATEST, percent: 100 }],
    latestCreated: first,
    latestReady: first,
    identifier: `${core.nextId("h")}x3bz5a7c2q-uc`,
    createdBy: "sim",
  };
  state.services.push(svc);
  state.revisions.push({ name: first, service: keyOf(svc), template: structuredClone(template), state: "ready", createdBy: "sim" });
}

/** A revision of `svc` made outside the API (a human's deploy), ready at once. */
function addReadyRevision(core: SimCore, state: CloudRunState, svc: CloudRunService, template: Record<string, unknown>): string {
  const name = `${svc.name}-${String(svc.generation + 1).padStart(5, "0")}-${core.nextId("r")}`;
  const t = structuredClone(template);
  delete t.revision;
  state.revisions.push({ name, service: keyOf(svc), template: structuredClone(t), state: "ready", createdBy: "sim" });
  svc.template = t;
  svc.latestCreated = name;
  svc.latestReady = name;
  bump(core, svc);
  return name;
}

function deployImage(core: SimCore, state: CloudRunState, svc: CloudRunService, image: string): void {
  const t = structuredClone(svc.template);
  const c = (t.containers as Array<Record<string, unknown>>)[0]!;
  c.image = image;
  addReadyRevision(core, state, svc, t);
}

function removeTag(core: SimCore, svc: CloudRunService, tag: string): void {
  const t = svc.traffic.find((x) => x.tag === tag);
  if (!t) throw new Error(`drift: service ${svc.name} has no tag ${tag}`);
  if (!t.percent) svc.traffic = svc.traffic.filter((x) => x !== t);
  else delete t.tag;
  bump(core, svc);
}

function redeployTagged(core: SimCore, state: CloudRunState, svc: CloudRunService, tag: string, envName: string, value: string): void {
  const target = svc.traffic.find((x) => x.tag === tag);
  const base = target ? state.revisions.find((r) => r.service === keyOf(svc) && r.name === lastSegment(target.revision ?? svc.latestReady)) : undefined;
  if (!target || !base) throw new Error(`drift: service ${svc.name} has no tagged revision ${tag}`);
  // `--no-traffic`: LATEST's share stays with the revision it pointed at (CR5).
  svc.traffic = svc.traffic.map((x) => (x.type === LATEST ? { ...x, type: BY_REVISION, revision: svc.latestReady } : x));
  const t = structuredClone(base.template);
  const c = (t.containers as Array<Record<string, unknown>>)[0]!;
  const env = ((c.env as Array<Record<string, unknown>> | undefined) ?? []).filter((e) => e.name !== envName);
  c.env = [...env, { name: envName, value }];
  const name = addReadyRevision(core, state, svc, t);
  const moved = svc.traffic.find((x) => x.tag === tag)!;
  moved.type = BY_REVISION;
  moved.revision = name;
}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function imageOf(template: Record<string, unknown>): string | undefined {
  const c = (template.containers as Array<Record<string, unknown>> | undefined)?.[0];
  return typeof c?.image === "string" ? c.image : undefined;
}

/** End an operation: its revision comes up (or fails to, CR9). */
function settle(state: CloudRunState, op: CloudRunOperation): void {
  op.done = true;
  const svc = state.services.find((s) => keyOf(s) === op.service);
  const rev = op.revision ? state.revisions.find((r) => r.service === op.service && r.name === op.revision) : undefined;
  if (!svc || !rev) return;
  if (state.failImages.includes(imageOf(rev.template) ?? "")) {
    rev.state = "failed";
    op.error = { code: 9, message: `Revision '${rev.name}' is not ready and cannot serve traffic. The user-provided container failed to start and listen on the port defined provided by the PORT=8080 environment variable.` };
    return;
  }
  rev.state = "ready";
  svc.latestReady = rev.name;
}

/** One poll of an operation: it ends after `operationPolls` of them. */
function tick(state: CloudRunState, op: CloudRunOperation): void {
  if (op.done) return;
  if (op.polls > 0) op.polls -= 1;
  else settle(state, op);
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function googleError(status: number, code: string, message: string): Reply {
  return new Reply(status, { error: { code: status, message, status: code } });
}

const notFound = () => googleError(404, "NOT_FOUND", "Requested entity was not found.");

function trafficStatuses(svc: CloudRunService): Array<Record<string, unknown>> {
  return svc.traffic.map((t) => ({
    type: t.type,
    revision: t.type === LATEST ? svc.latestReady : lastSegment(t.revision ?? ""),
    ...(t.percent ? { percent: t.percent } : {}),
    ...(t.tag ? { tag: t.tag, uri: `https://${t.tag}---${svc.name}-${svc.identifier}.a.run.app` } : {}),
  }));
}

function publicService(state: CloudRunState, svc: CloudRunService): Record<string, unknown> {
  const reconciling = state.operations.some((o) => o.service === keyOf(svc) && !o.done);
  return {
    name: fullName(svc),
    generation: String(svc.generation),
    observedGeneration: String(reconciling ? svc.generation - 1 : svc.generation),
    etag: svc.etag,
    template: svc.template,
    traffic: svc.traffic,
    trafficStatuses: trafficStatuses(svc),
    uri: `https://${svc.name}-${svc.identifier}.a.run.app`,
    latestCreatedRevision: revisionFullName(svc, svc.latestCreated),
    latestReadyRevision: revisionFullName(svc, svc.latestReady),
    reconciling,
    terminalCondition: { type: "Ready", state: reconciling ? "CONDITION_RECONCILING" : "CONDITION_SUCCEEDED" },
  };
}

const CONDITION: Record<CloudRunRevision["state"], string> = { pending: "CONDITION_RECONCILING", ready: "CONDITION_SUCCEEDED", failed: "CONDITION_FAILED" };

function publicRevision(svc: CloudRunService, rev: CloudRunRevision): Record<string, unknown> {
  return {
    name: revisionFullName(svc, rev.name),
    service: fullName(svc),
    containers: rev.template.containers,
    reconciling: rev.state === "pending",
    conditions: [{ type: "Ready", state: CONDITION[rev.state] }],
  };
}

function publicOperation(state: CloudRunState, op: CloudRunOperation): Record<string, unknown> {
  const svc = state.services.find((s) => keyOf(s) === op.service);
  const outcome = !op.done ? {} : op.error ? { error: op.error } : { response: svc ? { "@type": "type.googleapis.com/google.cloud.run.v2.Service", ...publicService(state, svc) } : {} };
  return { name: op.name, metadata: { "@type": "type.googleapis.com/google.cloud.run.v2.Service", name: svc ? fullName(svc) : "" }, done: op.done, ...outcome };
}

// ---------------------------------------------------------------------------
// The patch (CR3, CR4, CR5, CR8)
// ---------------------------------------------------------------------------

const MASK_FIELDS = new Set(["template", "traffic"]);
const TAG = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

function maskOf(url: URL): Set<string> | Reply {
  const raw = url.searchParams.get("updateMask");
  if (!raw) return googleError(400, "INVALID_ARGUMENT", "updateMask is required (the sim's own strictness)");
  const fields = raw.split(",").map((f) => f.trim());
  const unknown = fields.find((f) => !MASK_FIELDS.has(f));
  if (unknown) return googleError(400, "INVALID_ARGUMENT", `updateMask: field \`${unknown}\` is not one the sim can update`);
  return new Set(fields);
}

/** The revision a template change makes: its name (CR4), or what is wrong with the template. */
function newRevisionName(core: SimCore, state: CloudRunState, svc: CloudRunService, template: unknown): string | Reply {
  const containers = (template as { containers?: unknown } | null)?.containers as unknown;
  if (!Array.isArray(containers) || containers.length === 0 || !containers.every((c: unknown) => typeof (c as { image?: unknown } | null)?.image === "string")) {
    return googleError(400, "INVALID_ARGUMENT", "template.containers: at least one container with an image is required");
  }
  const named = (template as { revision?: unknown }).revision;
  if (named === undefined || named === "") return `${svc.name}-${String(svc.generation + 1).padStart(5, "0")}-${core.nextId("r")}`;
  if (typeof named !== "string" || !named.startsWith(`${svc.name}-`) || named.length > 63 || !/^[a-z0-9-]*[a-z0-9]$/.test(named)) {
    return googleError(400, "INVALID_ARGUMENT", `template.revision: ${String(named)} must start with ${svc.name}-, use lowercase letters, digits and -, not end with - and be at most 63 characters`);
  }
  if (state.revisions.some((r) => r.service === keyOf(svc) && r.name === named)) return googleError(409, "ALREADY_EXISTS", `Revision ${named} already exists.`);
  return named;
}

/** What is wrong with one traffic target (CR5), or undefined. */
function targetProblem(t: Record<string, unknown>, known: Set<string>): string | undefined {
  if (t.type !== LATEST && t.type !== BY_REVISION) return `traffic: unknown type ${String(t.type)}`;
  if (t.type === BY_REVISION && (typeof t.revision !== "string" || !known.has(lastSegment(t.revision)))) return `traffic: revision ${String(t.revision)} does not exist`;
  const percent = t.percent ?? 0;
  if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) return "traffic: percent must be 0 to 100";
  if (t.tag !== undefined && (typeof t.tag !== "string" || !TAG.test(t.tag))) return `traffic: tag ${String(t.tag)} is not a lowercase DNS label`;
  return undefined;
}

/** What is wrong with a traffic list (CR5, CR13), or undefined. */
function trafficProblem(traffic: unknown, known: Set<string>): string | undefined {
  if (!Array.isArray(traffic)) return "traffic must be a list";
  const targets = traffic as Array<Record<string, unknown>>;
  const problem = targets.map((t) => targetProblem(t, known)).find((p) => p !== undefined);
  if (problem) return problem;
  const tags = targets.flatMap((t) => (t.tag === undefined ? [] : [t.tag]));
  if (new Set(tags).size !== tags.length) return "traffic: a tag is used twice";
  const sum = targets.reduce((n, t) => n + ((t.percent as number | undefined) ?? 0), 0);
  return targets.length > 0 && sum !== 100 ? `traffic: percentages add up to ${sum}, not 100` : undefined;
}

function patchService(core: SimCore, state: CloudRunState, svc: CloudRunService, url: URL, body: unknown): Reply {
  const mask = maskOf(url);
  if (mask instanceof Reply) return mask;
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.etag !== undefined && b.etag !== svc.etag) return googleError(409, "ABORTED", "The etag does not match the service's: it was changed since it was read.");
  const changesTemplate = mask.has("template") && JSON.stringify(b.template) !== JSON.stringify(svc.template);
  const revision = changesTemplate ? newRevisionName(core, state, svc, b.template) : null;
  if (revision instanceof Reply) return revision;
  const known = new Set(state.revisions.filter((r) => r.service === keyOf(svc)).map((r) => r.name).concat(revision ? [revision] : []));
  const problem = mask.has("traffic") ? trafficProblem(b.traffic, known) : undefined;
  if (problem) return googleError(400, "INVALID_ARGUMENT", problem);

  if (revision) {
    const template = structuredClone(b.template as Record<string, unknown>);
    state.revisions.push({ name: revision, service: keyOf(svc), template: structuredClone(template), state: "pending", createdBy: "api" });
    svc.template = template;
    svc.latestCreated = revision;
  }
  if (mask.has("traffic")) svc.traffic = structuredClone(b.traffic as CloudRunTrafficTarget[]);
  bump(core, svc);
  const op: CloudRunOperation = { name: `projects/${svc.project}/locations/${svc.region}/operations/${core.nextId("op-")}`, service: keyOf(svc), revision, polls: state.operationPolls, done: false };
  state.operations.push(op);
  return new Reply(200, publicOperation(state, op));
}

function serviceAt(state: CloudRunState, p: { project: string; location: string; service: string }): CloudRunService | undefined {
  return state.services.find((s) => s.project === p.project && s.region === p.location && s.name === p.service);
}

const SERVICE = "/v2/projects/:project/locations/:location/services/:service";

const routes = router<CloudRunState>(
  [
    route("GET", SERVICE, ({ state, params }) => {
      const svc = serviceAt(state, params);
      if (!svc) return notFound();
      for (const op of state.operations) if (op.service === keyOf(svc)) tick(state, op);
      return new Reply(200, publicService(state, svc));
    }),

    route("PATCH", SERVICE, ({ core, state, params, url, body }) => {
      const svc = serviceAt(state, params);
      return svc ? patchService(core, state, svc, url, body) : notFound();
    }),

    route("GET", `${SERVICE}/revisions/:revision`, ({ state, params }) => {
      const svc = serviceAt(state, params);
      const rev = svc ? state.revisions.find((r) => r.service === keyOf(svc) && r.name === params.revision) : undefined;
      return svc && rev ? new Reply(200, publicRevision(svc, rev)) : notFound();
    }),

    route("GET", "/v2/projects/:project/locations/:location/operations/:operation", ({ state, params }) => {
      const op = state.operations.find((o) => o.name === `projects/${params.project}/locations/${params.location}/operations/${params.operation}`);
      if (!op) return notFound();
      tick(state, op);
      return new Reply(200, publicOperation(state, op));
    }),
  ],
  notFound,
);
