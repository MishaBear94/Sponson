/**
 * Simulated DigitalOcean App Platform: apps built from an app spec, each create and update starting a deployment.
 *
 * Assumptions about the real API this fake encodes, checked against the official OpenAPI document
 * (https://github.com/digitalocean/openapi, `specification/resources/apps`) and the docs unless marked unverified.
 * The critical ones are pinned in scenarios/contract.test.ts (`assumption DO…`).
 *   DO1. The API is `https://api.digitalocean.com`, authenticated as `Authorization: Bearer <token>` (scopes
 *        app:create/read/update/delete); doctl reads the token from `DIGITALOCEAN_ACCESS_TOKEN`. (verified:
 *        https://docs.digitalocean.com/reference/api/digitalocean/, doctl README)
 *   DO2. `POST /v2/apps` with `{ spec }` creates an app and answers `{ app: { id, spec, pending_deployment, … } }`;
 *        `GET /v2/apps/{id}` answers `{ app }` (404 when gone); `GET /v2/apps?page=&per_page=` lists
 *        `{ apps, links: { pages: { next } }, meta }`, with no name filter. (verified: apps_create.yml, apps_get.yml,
 *        apps_list.yml)
 *   DO3. An app's `spec.name` is unique in the account (`^[a-z][a-z0-9-]{0,30}[a-z0-9]$`); the status of a
 *        duplicate create is not documented (unverified: the sim answers 409). (verified: app_spec.yml)
 *   DO4. `PUT /v2/apps/{id}` with `{ spec }` replaces the whole spec and starts a deployment. (verified:
 *        apps_update.yml; "starts a deployment" inferred from `pending_deployment` being set for UpdateApp)
 *   DO5. `pending_deployment` names the deployment a create or update started; `GET
 *        /v2/apps/{app_id}/deployments/{deployment_id}` answers `{ deployment: { id, phase } }`, the phase one of
 *        PENDING_BUILD, BUILDING, PENDING_DEPLOY, DEPLOYING, ACTIVE, SUPERSEDED, ERROR, CANCELED. (verified:
 *        app.yml, apps_get_deployment.yml, apps_deployment_response.yml, apps_deployment_phase.yml)
 *   DO6. The platform adds defaults to the spec it stores (a region, instance counts); it keeps every field the
 *        client sent, lists in the order sent. (unverified: the sim adds `region` and `instance_count`)
 *   DO7. A `type: SECRET` variable's value is encrypted on first submission and read back as `EV[…]`.
 *        (verified: app_variable_definition.yml, "encrypted on first submission"; the read-back form unverified)
 *   DO8. `DELETE /v2/apps/{id}` deletes the app and its deployments (200 `{ id }`; 404 when gone). (verified:
 *        apps_delete.yml)
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** An app as the simulated App Platform stores it. */
export interface DigitaloceanApp {
  id: string;
  spec: Record<string, unknown>;
  liveUrl: string | null;
  /** Deployments by id: phase, and polls left before the next phase. */
  deployments: Record<string, { phase: string; polls: number }>;
  pending: string | null;
  createdBy: CreatedBy;
}

/** The simulated App Platform's state. */
export interface DigitaloceanState {
  apps: DigitaloceanApp[];
  /** Polls a deployment answers BUILDING before it is ACTIVE (default 1); `fail` ends it ERROR instead. */
  deployPolls: number;
  failDeployments: boolean;
}

/** What a scenario or test seeds the simulated App Platform with (`seed: { digitalocean: … }`). */
export interface DigitaloceanSeed {
  /** Apps that exist already (unmanaged), by spec. */
  apps?: Array<Record<string, unknown>>;
  deployPolls?: number;
  failDeployments?: boolean;
}

/** The simulated App Platform API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/digitalocean`. */
export const digitaloceanSim: ProviderSim<DigitaloceanState, DigitaloceanSeed> = {
  env: { token: "DIGITALOCEAN_ACCESS_TOKEN", url: "DIGITALOCEAN_API_URL", testToken: "tok_digitalocean" },
  defaultSeed: { apps: [] },

  reset(core, seed) {
    const apps = (seed?.apps ?? []).map((spec) => ({ id: core.nextId("app_"), spec: stored(core, spec), liveUrl: `https://${String(spec.name)}.ondigitalocean.app`, deployments: {}, pending: null, createdBy: "sim" as const }));
    return { apps, deployPolls: seed?.deployPolls ?? 1, failDeployments: seed?.failDeployments ?? false };
  },

  /**
   * `app.<name>`: "delete"; `app.<name>.env.<KEY>`: a new value for that app-level variable — what a human in the
   * control panel would do.
   */
  drift(_core, state, { key, rest, value, only }) {
    if (only !== undefined || !rest.startsWith("app.")) return false;
    const [name, kind, envKey] = rest.slice("app.".length).split(".");
    const app = state.apps.find((a) => a.spec.name === name);
    if (!app) throw new Error(`drift ${key}: no app ${String(name)}`);
    if (kind === undefined && value === "delete") state.apps = state.apps.filter((a) => a !== app);
    else if (kind === "env" && envKey) {
      const env = ((app.spec.envs as Array<Record<string, unknown>> | undefined) ?? []).find((e) => e.key === envKey);
      if (!env) throw new Error(`drift ${key}: no variable ${envKey}`);
      env.value = value;
    } else throw new Error(`drift ${key}: use app.<name> = delete, or app.<name>.env.<KEY> = <value>`);
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

/** The spec as stored: defaults added (DO6), SECRET values encrypted (DO7). */
function stored(core: SimCore, spec: Record<string, unknown>): Record<string, unknown> {
  const s = structuredClone(spec);
  s.region ??= "nyc";
  for (const svc of (s.services as Array<Record<string, unknown>> | undefined) ?? []) svc.instance_count ??= 1;
  const encrypt = (envs: unknown) => {
    for (const e of (envs as Array<Record<string, unknown>> | undefined) ?? []) if (e.type === "SECRET" && typeof e.value === "string" && !e.value.startsWith("EV[")) e.value = `EV[1:${core.nextId("")}:sim]`;
  };
  encrypt(s.envs);
  for (const svc of (s.services as Array<Record<string, unknown>> | undefined) ?? []) encrypt(svc.envs);
  return s;
}

function deploy(core: SimCore, state: DigitaloceanState, app: DigitaloceanApp): void {
  const id = core.nextId("dep_");
  app.deployments[id] = { phase: "PENDING_BUILD", polls: state.deployPolls };
  app.pending = id;
}

function publicApp(a: DigitaloceanApp): Record<string, unknown> {
  return { id: a.id, spec: a.spec, ...(a.liveUrl ? { live_url: a.liveUrl } : {}), ...(a.pending ? { pending_deployment: { id: a.pending } } : {}) };
}

const NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const notFound = () => new Reply(404, { id: "not_found", message: "The resource you were accessing could not be found." });

function specOf(body: unknown): Record<string, unknown> | Reply {
  const spec = (body as { spec?: unknown } | null)?.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec) || typeof (spec as { name?: unknown }).name !== "string" || !NAME.test((spec as { name: string }).name)) {
    return new Reply(422, { id: "unprocessable_entity", message: "spec.name is invalid" });
  }
  return spec as Record<string, unknown>;
}

const routes = router<DigitaloceanState>(
  [
    route("GET", "/v2/apps", ({ state, url }) => {
      const per = Math.max(1, Number(url.searchParams.get("per_page") ?? 20));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const slice = state.apps.slice((page - 1) * per, page * per);
      const next = page * per < state.apps.length ? { next: `https://api.digitalocean.com/v2/apps?page=${page + 1}&per_page=${per}` } : {};
      return new Reply(200, { apps: slice.map(publicApp), links: { pages: next }, meta: { total: state.apps.length } });
    }),

    route("POST", "/v2/apps", ({ core, state, body }) => {
      const spec = specOf(body);
      if (spec instanceof Reply) return spec;
      if (state.apps.some((a) => a.spec.name === spec.name)) return new Reply(409, { id: "conflict", message: "an app with this name already exists" });
      const app: DigitaloceanApp = { id: core.nextId("app_"), spec: stored(core, spec), liveUrl: null, deployments: {}, pending: null, createdBy: "api" };
      deploy(core, state, app);
      state.apps.push(app);
      return new Reply(200, { app: publicApp(app) });
    }),

    route("GET", "/v2/apps/:id", ({ state, params }) => {
      const app = state.apps.find((a) => a.id === params.id);
      return app ? new Reply(200, { app: publicApp(app) }) : notFound();
    }),

    route("PUT", "/v2/apps/:id", ({ core, state, params, body }) => {
      const app = state.apps.find((a) => a.id === params.id);
      if (!app) return notFound();
      const spec = specOf(body);
      if (spec instanceof Reply) return spec;
      app.spec = stored(core, spec);
      deploy(core, state, app);
      return new Reply(200, { app: publicApp(app) });
    }),

    route("GET", "/v2/apps/:id/deployments/:deployment", ({ state, params }) => {
      const app = state.apps.find((a) => a.id === params.id);
      const d = app?.deployments[params.deployment];
      if (!app || !d) return notFound();
      if (d.polls > 0) {
        d.polls--;
        d.phase = "BUILDING";
      } else if (d.phase !== "ACTIVE" && d.phase !== "ERROR") {
        d.phase = state.failDeployments ? "ERROR" : "ACTIVE";
        if (d.phase === "ACTIVE") {
          app.liveUrl = `https://${String(app.spec.name)}-${app.id.slice(4)}.ondigitalocean.app`;
          app.pending = null;
        }
      }
      return new Reply(200, { deployment: { id: params.deployment, phase: d.phase } });
    }),

    route("DELETE", "/v2/apps/:id", ({ state, params }) => {
      const app = state.apps.find((a) => a.id === params.id);
      if (!app) return notFound();
      state.apps = state.apps.filter((a) => a !== app);
      return new Reply(200, { id: app.id });
    }),
  ],
  notFound,
);
