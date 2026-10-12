/**
 * Simulated Contentful Content Management API: the environments of a space, copied asynchronously from a source
 * environment, and the delivery API keys whose `environments` links decide which environments they can read.
 *
 * Assumptions about the real API this fake encodes (verified against Contentful's CMA reference, read through the
 * Wayback Machine because contentful.com answers automated fetches with 429, its official SDKs' source and the
 * official Python SDK's recorded API traffic, unless marked unverified). The critical ones are pinned in
 * scenarios/contract.test.ts (`assumption CF…`).
 *   CF1. The CMA is served at `https://api.contentful.com` (`https://api.eu.contentful.com` for EU data residency),
 *        authenticated with a personal access token or a CMA token as `Authorization: Bearer`; Contentful's
 *        Terraform provider and contentful-migration read it from `CONTENTFUL_MANAGEMENT_TOKEN`. (verified:
 *        https://www.contentful.com/developers/docs/references/authentication/,
 *        https://github.com/labd/terraform-provider-contentful/blob/master/README.md; the EU host unverified)
 *   CF2. `PUT /spaces/{space}/environments/{id}` with `{ name }` creates an environment with that id (at most 40
 *        characters of `[a-zA-Z0-9-_.]`), copied from the environment the `X-Contentful-Source-Environment` header
 *        names, `master` without it; it answers 201 with the environment, its `sys.status.sys.id` `queued`.
 *        (verified: CMA reference, "Environments"; contentful-management.js `createWithId`;
 *        contentful-management.py fixtures/environment/create.yaml and create_different_source.yaml)
 *   CF3. Requests carry `Content-Type: application/vnd.contentful.management.v1+json`; without it Contentful routes
 *        the request to the latest API version. (verified: CMA reference, "API versioning"; the sim refuses other
 *        types of a body, which is stricter than Contentful: whether plain JSON is refused is unverified)
 *   CF4. The copy is asynchronous: `GET /spaces/{space}/environments/{id}` answers the environment, whose
 *        `sys.status.sys.id` goes `queued` → `inProgress` → `ready` (or `failed`); it is usable only when `ready`,
 *        and copying takes time in proportion to the source's content. The official CLI's `--await-processing`
 *        polls this read every 3 seconds. (verified: CMA reference, "Environment states"; contentful-cli
 *        lib/cmds/space_cmds/environment_cmds/create.js)
 *   CF5. A missing environment or API key answers 404 `{ sys: { type: "Error", id: "NotFound" } }`; `DELETE` of an
 *        environment answers 204; the `master` environment cannot be deleted. (verified: fixtures/environment/
 *        not_found.yaml and delete.yaml; https://www.contentful.com/developers/docs/concepts/multiple-environments/)
 *   CF6. A `PUT` to an environment that exists updates it and needs `X-Contentful-Version` equal to its
 *        `sys.version`; otherwise 409 `VersionMismatch`. (the version rule verified: CMA reference; that a PUT
 *        without the header to an existing environment is 409 and not another 4xx is unverified)
 *   CF7. A delivery API key (`GET /spaces/{space}/api_keys/{id}`) lists the environments it can read in
 *        `environments`, links `{ sys: { type: "Link", linkType: "Environment", id } }`; any other environment is
 *        404 to it. `PUT` of the key with `X-Contentful-Version` and `{ name, description, environments }` replaces
 *        that list, for its preview API key too, and answers the key with `sys.version` raised. (verified: CMA
 *        reference, "API keys"; contentful-management.js endpoints/api-key.ts, which sends exactly those fields;
 *        fixtures/api_key/create_with_environment.yaml)
 *   CF8. `GET /spaces/{space}/environments` lists them as `{ sys: { type: "Array" }, total, skip, limit, items }`,
 *        and `GET /spaces` the spaces the token reaches in the same envelope (the credential check). (verified:
 *        fixtures/environment/all.yaml; CMA reference, "Spaces")
 *   CF9. A space holds at most 151 environments, and at most 12 are created per 5 minutes; the plan's sandbox
 *        environments are fewer (2 to 4 below Enterprise). (verified: https://www.contentful.com/developers/docs/technical-limits/;
 *        the per-plan counts unverified)
 *   CF10. A copy of a small space is ready within seconds (a recorded run: queued, then ready 2 s later); a large
 *        one may take minutes. (unverified beyond that recording: the adapter waits up to
 *        SPONSON_CONTENTFUL_READY_TIMEOUT_MS, ten minutes by default)
 */
import { Reply, route, router, type CreatedBy, type ProviderSim } from "../provider.js";

/** The CMA's media type (CF3). */
export const CONTENTFUL_MEDIA_TYPE = "application/vnd.contentful.management.v1+json";

/** An environment as the simulated Contentful stores it. */
export interface ContentfulEnvironment {
  id: string;
  name: string;
  /** The environment it was copied from. */
  source: string;
  version: number;
  status: "queued" | "inProgress" | "ready" | "failed";
  /** Reads left before a queued copy is ready (CF4). */
  pending: number;
  createdBy: CreatedBy;
}

/** A delivery API key: the environments it can read (CF7). */
export interface ContentfulApiKey {
  id: string;
  name: string;
  description: string;
  environments: string[];
  version: number;
}

/** One space: its environments by id and its delivery API keys by id. */
export interface ContentfulSpace {
  environments: Record<string, ContentfulEnvironment>;
  apiKeys: Record<string, ContentfulApiKey>;
}

/** The simulated Contentful's state: spaces by id, and how long a copy takes. */
export interface ContentfulState {
  spaces: Record<string, ContentfulSpace>;
  /** Reads of a new environment that answer it not ready yet (default 1). */
  readyPolls: number;
  /** Copies that end `failed` instead of `ready`, by environment id. */
  failing: string[];
}

/** What a scenario or test seeds the simulated Contentful with (`seed: { contentful: … }`). */
export interface ContentfulSeed {
  /** Space id → its environments (ready, made "by a human") and API keys (id → the environments it reads). */
  spaces?: Record<string, { environments?: string[]; api_keys?: Record<string, string[]> }>;
  readyPolls?: number;
  failing?: string[];
}

/** The simulated Contentful API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/contentful`. */
export const contentfulSim: ProviderSim<ContentfulState, ContentfulSeed> = {
  env: { token: "CONTENTFUL_MANAGEMENT_TOKEN", url: "CONTENTFUL_API_URL", testToken: "tok_contentful" },
  defaultSeed: { spaces: { space1: { environments: ["master"], api_keys: { key1: ["master"] } } } },

  reset(_core, seed) {
    const spaces: ContentfulState["spaces"] = {};
    for (const [id, s] of Object.entries(seed?.spaces ?? {})) {
      const environments = Object.fromEntries((s.environments ?? ["master"]).map((e) => [e, environment(e, "master", "ready", 0, "sim")]));
      const apiKeys = Object.fromEntries(Object.entries(s.api_keys ?? {}).map(([k, envs]) => [k, { id: k, name: `Key ${k}`, description: "", environments: [...envs], version: 1 }]));
      spaces[id] = { environments, apiKeys };
    }
    return { spaces, readyPolls: seed?.readyPolls ?? 1, failing: [...(seed?.failing ?? [])] };
  },

  /**
   * `environment.<id>`: "delete"; `api_key.<key>.<environment>`: "remove" (its link dropped) — what a human in the
   * Contentful web app would do. `only` is the space.
   */
  drift(_core, state, { key, rest, value, only }) {
    const [kind, a, b] = rest.split(".");
    const spaces = Object.entries(state.spaces).filter(([id]) => only === undefined || id === only);
    if (kind === "environment" && a && value === "delete") {
      const hit = spaces.filter(([, s]) => s.environments[a]);
      for (const [, s] of hit) delete s.environments[a];
      if (hit.length === 0) throw new Error(`drift ${key}: no environment ${a}`);
      return true;
    }
    if (kind === "api_key" && a && b && value === "remove") {
      const hit = spaces.filter(([, s]) => s.apiKeys[a]);
      for (const [, s] of hit) s.apiKeys[a]!.environments = s.apiKeys[a]!.environments.filter((e) => e !== b);
      if (hit.length === 0) throw new Error(`drift ${key}: no API key ${a}`);
      return true;
    }
    return false;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function environment(id: string, source: string, status: ContentfulEnvironment["status"], pending: number, createdBy: CreatedBy): ContentfulEnvironment {
  return { id, name: id, source, version: 1, status, pending, createdBy };
}

const link = (linkType: string, id: string) => ({ sys: { type: "Link", linkType, id } });

function environmentBody(space: string, e: ContentfulEnvironment): Record<string, unknown> {
  return { name: e.name, sys: { type: "Environment", id: e.id, version: e.version, space: link("Space", space), status: link("Status", e.status) } };
}

function apiKeyBody(space: string, k: ContentfulApiKey): Record<string, unknown> {
  return { name: k.name, description: k.description, accessToken: `cda_sim_${k.id}`, environments: k.environments.map((e) => link("Environment", e)), preview_api_key: link("PreviewApiKey", `preview_${k.id}`), sys: { type: "ApiKey", id: k.id, version: k.version, space: link("Space", space) } };
}

const notFound = () => new Reply(404, { requestId: "sim", message: "The resource could not be found.", sys: { type: "Error", id: "NotFound" } });
const versionMismatch = () => new Reply(409, { requestId: "sim", message: "", sys: { type: "Error", id: "VersionMismatch" } });

/** CF3: a write's body must be in the CMA's media type. */
function wrongType(headers: Record<string, string>): Reply | null {
  const type = headers["content-type"] ?? "";
  return type.startsWith(CONTENTFUL_MEDIA_TYPE) ? null : new Reply(415, { sys: { type: "Error", id: "UnsupportedMediaType" }, message: `expected ${CONTENTFUL_MEDIA_TYPE}` });
}

/** A read of a copy in progress moves it along (CF4): queued → inProgress → ready (or failed). */
function advance(state: ContentfulState, e: ContentfulEnvironment): void {
  if (e.status === "ready" || e.status === "failed") return;
  if (e.pending > 0) {
    e.pending--;
    e.status = "inProgress";
    return;
  }
  e.status = state.failing.includes(e.id) ? "failed" : "ready";
  e.version++;
}

/** The environments of an API key's PUT body, or null when it is not a list of environment links (CF7). */
function linkedEnvironments(body: unknown): string[] | null {
  const envs = (body as { environments?: unknown } | null)?.environments;
  if (!Array.isArray(envs)) return null;
  const ids = envs.map((l: unknown) => (l as { sys?: { linkType?: unknown; id?: unknown } } | null)?.sys).map((s) => (s?.linkType === "Environment" && typeof s.id === "string" ? s.id : null));
  return ids.every((i): i is string => i !== null) ? ids : null;
}

const routes = router<ContentfulState>(
  [
    route("GET", "/spaces", ({ state }) => {
      const items = Object.keys(state.spaces).map((id) => ({ name: id, sys: { type: "Space", id } }));
      return new Reply(200, { sys: { type: "Array" }, total: items.length, skip: 0, limit: 100, items });
    }),

    route("GET", "/spaces/:space/environments",({ state, params }) => {
      const s = state.spaces[params.space];
      if (!s) return notFound();
      const items = Object.values(s.environments).map((e) => environmentBody(params.space, e));
      return new Reply(200, { sys: { type: "Array" }, total: items.length, skip: 0, limit: 100, items });
    }),

    route("GET", "/spaces/:space/environments/:env", ({ state, params }) => {
      const e = state.spaces[params.space]?.environments[params.env];
      if (!e) return notFound();
      advance(state, e);
      return new Reply(200, environmentBody(params.space, e));
    }),

    route("PUT", "/spaces/:space/environments/:env", ({ state, params, body, headers }) => {
      const s = state.spaces[params.space];
      if (!s) return notFound();
      const bad = wrongType(headers);
      if (bad) return bad;
      const existing = s.environments[params.env];
      if (existing) {
        if (headers["x-contentful-version"] !== String(existing.version)) return versionMismatch();
        existing.name = String((body as { name?: unknown } | null)?.name ?? existing.name);
        existing.version++;
        return new Reply(200, environmentBody(params.space, existing));
      }
      if (!/^[a-zA-Z0-9-_.]{1,40}$/.test(params.env)) return new Reply(422, { sys: { type: "Error", id: "ValidationFailed" }, message: "environment id" });
      const source = headers["x-contentful-source-environment"] ?? "master";
      if (!s.environments[source]) return notFound();
      const e = environment(params.env, source, "queued", state.readyPolls, "api");
      e.name = String((body as { name?: unknown } | null)?.name ?? params.env);
      s.environments[params.env] = e;
      return new Reply(201, environmentBody(params.space, e));
    }),

    route("DELETE", "/spaces/:space/environments/:env", ({ state, params }) => {
      const s = state.spaces[params.space];
      if (!s?.environments[params.env]) return notFound();
      if (params.env === "master") return new Reply(422, { sys: { type: "Error", id: "ValidationFailed" }, message: "the master environment cannot be deleted" });
      delete s.environments[params.env];
      return new Reply(204, null);
    }),

    route("GET", "/spaces/:space/api_keys/:key", ({ state, params }) => {
      const k = state.spaces[params.space]?.apiKeys[params.key];
      return k ? new Reply(200, apiKeyBody(params.space, k)) : notFound();
    }),

    route("PUT", "/spaces/:space/api_keys/:key", ({ state, params, body, headers }) => {
      const k = state.spaces[params.space]?.apiKeys[params.key];
      if (!k) return notFound();
      const bad = wrongType(headers);
      if (bad) return bad;
      if (headers["x-contentful-version"] !== String(k.version)) return versionMismatch();
      const envs = linkedEnvironments(body);
      if (envs === null) return new Reply(422, { sys: { type: "Error", id: "ValidationFailed" }, message: "environments must be a list of environment links" });
      k.environments = envs;
      k.version++;
      return new Reply(200, apiKeyBody(params.space, k));
    }),
  ],
  notFound,
);

/** The ids of a space's environments, for assertions. */
export function contentfulEnvironmentIds(state: ContentfulState, space: string): string[] {
  return Object.keys(state.spaces[space]?.environments ?? {});
}
