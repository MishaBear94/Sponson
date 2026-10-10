/**
 * Simulated Netlify: site environment variables (one object per key, one value per deploy context) and deploys.
 *
 * Assumptions about the real API that this fake encodes. "Verified" means against Netlify's OpenAPI document
 * (https://github.com/netlify/open-api/blob/master/swagger.yml, rendered at https://open-api.netlify.com/) or its
 * docs (cited), fetched 2026-10-11; docs/api-verification.md has the per-call table. scenarios/contract.test.ts pins
 * the risky ones against a live account (`pnpm test:live`). NL, not N: N… are Neon's.
 *   NL1. Base URL https://api.netlify.com/api/v1, bearer token (OpenAPI `host`, `basePath`; the API guide's
 *        `Authorization: Bearer`). Verified.
 *   NL2. Site variables live under /accounts/{account_id}/env with `?site_id=`: GET lists them (getEnvVars), POST
 *        creates a list of them (createEnvVars, 201), GET/PATCH/DELETE /accounts/{account_id}/env/{key} read one,
 *        set one context's value (setEnvVarValue, 201: "updates or creates a new value for an existing
 *        environment variable") and delete the variable (204); DELETE …/env/{key}/value/{id} deletes one value
 *        (deleteEnvVarValue, 204). Verified (OpenAPI paths, statuses; the docs' API guide). `{account_id}` may be
 *        the account slug (verified: the API guide). GET /sites/{site_id} carries `account_id`, `account_slug` and
 *        `name` (verified field names; that `name` is the `<name>.netlify.app` subdomain is the docs' example, not a
 *        statement: unverified, pinned).
 *   NL3. A variable is `{ key, scopes, values: [{ id, value, context, context_parameter }], is_secret, updated_at }`;
 *        `context` is all | dev | dev-server | branch-deploy | deploy-preview | production | branch, and `branch`
 *        needs the branch name in `context_parameter` (verified: envVar / envVarValue definitions). Omitting
 *        `scopes` gives all scopes (verified: "By default, environment variables apply to all scopes", env var
 *        overview). Unverified: that PATCH leaves the other contexts' values (and their ids) alone and keeps the id
 *        of the value it replaces (the sim keeps it; the adapter re-reads ids from the answer anyway).
 *   NL4. Secret values (`is_secret`) are write-only except in the `dev` context (verified: Secrets Controller
 *        docs). How a masked value is returned is not documented; the sim omits `value` (unverified; the adapter
 *        ignores `value` of a secret either way).
 *   NL5. POST of a key that already exists is refused with 400 and writes nothing (unverified: status not
 *        documented). A variable with an `all` value and a context value together is refused with 400
 *        (unverified). The adapter re-lists after a 400/409 and never writes next to an `all` value.
 *   NL6. A variable whose last value is deleted stays, with no values (unverified; the adapter deletes it then, and
 *        a 404 on the follow-up read is fine).
 *   NL7. GET /sites/{site_id}/deploys lists deploys newest first, `page`/`per_page` (verified: the API guide;
 *        order unverified, the adapter sorts by `created_at`). A deploy carries `id`, `state`, `context`,
 *        `commit_ref`, `review_id`, `branch`, `created_at` (verified field names); `context` is production |
 *        deploy-preview | branch-deploy (unverified: no enum in the spec) and `review_id` is the pull request
 *        number (unverified).
 *   NL8. Deploy states: new, pending_review, accepted, rejected, enqueued, building, uploading, uploaded,
 *        preparing, prepared, processing, processed, ready, error, retrying (verified: the `state` filter's enum).
 *        The sim uses enqueued → building → ready, or error.
 *   NL9. URLs: `<deploy id>--<site name>.netlify.app` is a deploy's permalink and `deploy-preview-<n>--<site
 *        name>.netlify.app` the Deploy Preview of pull request n (verified: deploy overview docs).
 *   NL10. A build reads the variable values set when it started ("Environment variable changes require a build
 *        and deploy to take effect": verified, env var docs); `updated_at` is when a variable's values last
 *        changed (verified field; that a PATCH bumps it is unverified, pinned).
 *   NL11. POST /sites/{site_id}/builds starts a build of the production branch, or with `?branch=` a branch deploy
 *        of that branch's head (verified: createSiteBuild's `branch` description). Unverified: that it works for
 *        a branch whose branch deploys are not enabled in the site's settings. Deploy Previews cannot be rebuilt
 *        through the documented API.
 *   NL12. A `branch` value applies to "deploy permalinks, Deploy Previews, and branch deploys for the specified
 *        branch" (verified: env var overview), so a pull request's Deploy Preview reads its head branch's value.
 *
 * The git integration is modelled by `pushes` in the seed: the first deploy list of a site deploys every push it
 * has not deployed yet (a pull request push as a Deploy Preview, `main` as production, other branches as branch
 * deploys), following chaos `deploy` (ok | never | fail | stale | delay:<s>) and `deploy_ms` as Vercel's sim does.
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One value of a simulated variable. */
export interface NetlifyEnvValue {
  id: string;
  value: string;
  context: string;
  context_parameter?: string;
}

/** One simulated site variable. */
export interface NetlifyEnvVar {
  key: string;
  is_secret: boolean;
  values: NetlifyEnvValue[];
  updatedAt: number;
  createdBy: CreatedBy;
}

/** One simulated deploy. */
export interface NetlifyDeploy {
  id: string;
  state: string;
  context: "production" | "deploy-preview" | "branch-deploy";
  branch: string;
  commit_ref: string;
  review_id: number | null;
  createdAt: number;
  /** While building: `building` until `readyAt`, then `finalState`. */
  readyAt?: number;
  finalState?: string;
  createdBy: CreatedBy;
}

/** A commit the git integration has seen: what Netlify would build on its own. */
export interface NetlifyPush {
  sha: string;
  branch: string;
  pr?: number;
}

/** One simulated site. */
export interface NetlifySite {
  name: string;
  accountId: string;
  accountSlug: string;
  envs: NetlifyEnvVar[];
  deploys: NetlifyDeploy[];
  pushes: NetlifyPush[];
  /** Pushes already deployed by the git integration (by `<sha> <branch>`). */
  built: string[];
}

/** The simulated Netlify's state: sites by id. */
export interface NetlifyState {
  sites: Record<string, NetlifySite>;
}

/** What a scenario or test seeds the simulated Netlify with (`seed: { netlify: … }`). */
export interface NetlifySeed {
  sites: Record<
    string,
    {
      name?: string;
      account?: string;
      /** Variables that exist already (set "by a human", so unmanaged). */
      envs?: Array<{ key: string; is_secret?: boolean; values: Array<{ context: string; value: string; context_parameter?: string }> }>;
      pushes?: NetlifyPush[];
    }
  >;
}

const PRODUCTION_BRANCH = "main";
const CONTEXTS = new Set(["all", "dev", "dev-server", "branch-deploy", "deploy-preview", "production", "branch"]);

/** The simulated Netlify API (env vars, deploys), registered in `PROVIDERS` and served under `/netlify`. */
export const netlifySim: ProviderSim<NetlifyState, NetlifySeed> = {
  env: { token: "NETLIFY_AUTH_TOKEN", url: "NETLIFY_API_URL", testToken: "tok_netlify" },
  defaultSeed: { sites: { site_demo: { name: "demo-site", account: "acme" } } },

  reset(core, seed) {
    const sites: NetlifyState["sites"] = {};
    for (const [id, s] of Object.entries(seed?.sites ?? {})) {
      const slug = s.account ?? "acme";
      sites[id] = {
        name: s.name ?? id,
        accountSlug: slug,
        accountId: `acct_${slug}`,
        envs: (s.envs ?? []).map((e) => ({ key: e.key, is_secret: e.is_secret ?? false, values: e.values.map((v) => ({ ...v, id: core.nextId("nlv_") })), updatedAt: Date.now() - 60_000, createdBy: "sim" })),
        deploys: [],
        pushes: [...(s.pushes ?? [])],
        built: [],
      };
    }
    return { sites };
  },

  /**
   * `env.<context>.<NAME>`           the value of NAME in that context (any branch for `branch`)
   * `env.branch@<branch>.<NAME>`     the `branch` value for that branch
   * Value: a new value, "delete" (the value), or "recreate" (delete it and add it again with a new id).
   */
  drift(core, state, { key, rest, value, only }) {
    if (!rest.startsWith("env.")) return false;
    const spec = rest.slice("env.".length);
    const dot = spec.lastIndexOf(".");
    if (dot < 0) throw new Error(`bad drift key: ${key}`);
    const [context, branch] = splitOnce(spec.slice(0, dot), "@");
    const name = spec.slice(dot + 1);
    let hit = false;
    for (const [id, site] of Object.entries(state.sites)) {
      if (only !== undefined && id !== only) continue;
      for (const e of site.envs.filter((x) => x.key === name)) {
        const match = (v: NetlifyEnvValue) => v.context === context && (branch === undefined || v.context_parameter === branch);
        for (const v of e.values.filter(match)) {
          hit = true;
          if (value === "delete") e.values = e.values.filter((x) => x !== v);
          else if (value === "recreate") e.values = [...e.values.filter((x) => x !== v), { ...v, id: core.nextId("nlv_") }];
          else v.value = value;
          e.updatedAt = Date.now();
        }
      }
    }
    if (!hit) throw new Error(`drift ${key}: no value matches`);
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

type Ctx = { core: SimCore; state: NetlifyState; params: { account: string }; url: URL };

/** The site of `?site_id=` when it belongs to the account in the path (by id or slug). */
function siteFor({ state, params, url }: Ctx): NetlifySite | Reply {
  const siteId = url.searchParams.get("site_id");
  const site = siteId ? state.sites[siteId] : undefined;
  if (!site) return notFound("site");
  if (params.account !== site.accountId && params.account !== site.accountSlug) return notFound("account");
  return site;
}

const routes = router<NetlifyState>(
  [
    route("GET", "/sites/:site", ({ state, params }) => {
      const s = state.sites[params.site];
      if (!s) return notFound("site");
      return new Reply(200, { id: params.site, site_id: params.site, name: s.name, account_id: s.accountId, account_slug: s.accountSlug, url: `http://${s.name}.netlify.app`, ssl_url: `https://${s.name}.netlify.app` });
    }),

    route("GET", "/accounts/:account/env", (ctx) => {
      const site = siteFor(ctx);
      return site instanceof Reply ? site : new Reply(200, site.envs.map(publicEnv));
    }),

    route("POST", "/accounts/:account/env", (ctx) => {
      const site = siteFor(ctx);
      return site instanceof Reply ? site : createEnvs(ctx.core, site, ctx.body);
    }),

    route("GET", "/accounts/:account/env/:key", (ctx) => {
      const site = siteFor(ctx);
      if (site instanceof Reply) return site;
      const e = site.envs.find((x) => x.key === ctx.params.key);
      return e ? new Reply(200, publicEnv(e)) : notFound("environment variable");
    }),

    route("PATCH", "/accounts/:account/env/:key", (ctx) => {
      const site = siteFor(ctx);
      if (site instanceof Reply) return site;
      const e = site.envs.find((x) => x.key === ctx.params.key);
      if (!e) return notFound("environment variable");
      return setValue(ctx.core, e, ctx.body);
    }),

    route("DELETE", "/accounts/:account/env/:key", (ctx) => {
      const site = siteFor(ctx);
      if (site instanceof Reply) return site;
      if (!site.envs.some((x) => x.key === ctx.params.key)) return notFound("environment variable");
      site.envs = site.envs.filter((x) => x.key !== ctx.params.key);
      return new Reply(204, null);
    }),

    route("DELETE", "/accounts/:account/env/:key/value/:id", (ctx) => {
      const site = siteFor(ctx);
      if (site instanceof Reply) return site;
      const e = site.envs.find((x) => x.key === ctx.params.key);
      if (!e?.values.some((v) => v.id === ctx.params.id)) return notFound("environment variable value");
      e.values = e.values.filter((v) => v.id !== ctx.params.id);
      e.updatedAt = Date.now();
      return new Reply(204, null);
    }),

    route("GET", "/sites/:site/deploys", ({ core, state, params, url }) => {
      const s = state.sites[params.site];
      if (!s) return notFound("site");
      gitIntegration(core, s);
      refresh(s.deploys);
      const perPage = Number(url.searchParams.get("per_page") ?? 100);
      const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const list = [...s.deploys].sort((a, b) => b.createdAt - a.createdAt).slice((pageNo - 1) * perPage, pageNo * perPage);
      return new Reply(200, list.map((d) => publicDeploy(s, d)));
    }),

    route("POST", "/sites/:site/builds", ({ core, state, params, url }) => {
      const s = state.sites[params.site];
      if (!s) return notFound("site");
      const branch = url.searchParams.get("branch") ?? PRODUCTION_BRANCH;
      const head = s.pushes.filter((p) => p.branch === branch).at(-1);
      if (!head) return new Reply(422, { code: 422, message: `branch ${branch} has no commits` });
      const d = deploy(core, s, { sha: head.sha, branch }, branch === PRODUCTION_BRANCH ? "production" : "branch-deploy", Date.now());
      return new Reply(200, { id: core.nextId("bld_"), deploy_id: d.id, sha: head.sha, done: false });
    }),
  ],
  () => notFound("route"),
);

/** One `values` item of a create or a PATCH body, validated. */
function valueInput(core: SimCore, v: unknown): NetlifyEnvValue | string {
  if (!v || typeof v !== "object") return "a value must be an object";
  const x = v as Record<string, unknown>;
  if (typeof x.value !== "string" || typeof x.context !== "string" || !CONTEXTS.has(x.context)) return "a value needs `value` and a known `context`";
  if (x.context === "branch" && (typeof x.context_parameter !== "string" || x.context_parameter === "")) return "context `branch` must be provided with a value in `context_parameter`";
  return { id: core.nextId("nlv_"), value: x.value, context: x.context, ...(x.context === "branch" ? { context_parameter: x.context_parameter as string } : {}) };
}

function sameSlot(a: NetlifyEnvValue, b: NetlifyEnvValue): boolean {
  return a.context === b.context && (a.context_parameter ?? "") === (b.context_parameter ?? "");
}

/** `all` cannot sit next to a context value, and no slot twice (NL5). */
function badValues(values: NetlifyEnvValue[]): string | undefined {
  if (values.some((v) => v.context === "all") && values.length > 1) return "a value for all contexts cannot be combined with contextual values";
  if (values.some((v, i) => values.findIndex((w) => sameSlot(v, w)) !== i)) return "two values for the same context";
  return undefined;
}

function createEnvs(core: SimCore, site: NetlifySite, body: unknown): Reply {
  if (!Array.isArray(body)) return badRequest("expected a list of environment variables");
  const created: NetlifyEnvVar[] = [];
  // Validate the whole batch first: a rejected request writes nothing.
  for (const item of body) {
    const it = (item ?? {}) as { key?: unknown; values?: unknown; is_secret?: unknown };
    if (typeof it.key !== "string" || it.key === "" || !Array.isArray(it.values)) return badRequest("each variable needs `key` and `values`");
    if (site.envs.some((e) => e.key === it.key) || created.some((e) => e.key === it.key)) return badRequest(`Environment variable ${it.key} already exists`);
    const values = it.values.map((v) => valueInput(core, v));
    const wrong = values.find((v): v is string => typeof v === "string") ?? badValues(values as NetlifyEnvValue[]);
    if (wrong) return badRequest(wrong);
    created.push({ key: it.key, is_secret: it.is_secret === true, values: values as NetlifyEnvValue[], updatedAt: Date.now(), createdBy: "api" });
  }
  site.envs.push(...created);
  return new Reply(201, created.map(publicEnv));
}

/** PATCH: replace the value of one context (keeping its id) or add it. */
function setValue(core: SimCore, e: NetlifyEnvVar, body: unknown): Reply {
  const v = valueInput(core, body);
  if (typeof v === "string") return badRequest(v);
  const existing = e.values.find((x) => sameSlot(x, v));
  const next = existing ? e.values : [...e.values, v];
  const wrong = badValues(next);
  if (wrong) return badRequest(wrong);
  if (existing) existing.value = v.value;
  e.values = next;
  e.updatedAt = Math.max(Date.now(), e.updatedAt + 1);
  return new Reply(201, publicEnv(e));
}

/** The git integration: deploy each push once, per chaos `deploy`. */
function gitIntegration(core: SimCore, s: NetlifySite): void {
  const mode = core.chaos.deploy;
  if (mode === "never") return;
  for (const p of s.pushes) {
    const id = `${p.sha} ${p.branch}`;
    if (s.built.includes(id)) continue;
    s.built.push(id);
    const context = p.pr !== undefined ? "deploy-preview" : p.branch === PRODUCTION_BRANCH ? "production" : "branch-deploy";
    const now = Date.now();
    if (mode === "fail") deploy(core, s, p, context, now, "error");
    else if (mode === "stale") deploy(core, s, p, context, now - 60_000);
    else {
      const delay = /^delay:(\d+(?:\.\d+)?)$/.exec(mode);
      const d = deploy(core, s, p, context, now);
      if (delay) Object.assign(d, { state: "building", readyAt: now + Number(delay[1]) * 1000, finalState: "ready" });
    }
  }
}

function deploy(core: SimCore, s: NetlifySite, p: NetlifyPush, context: NetlifyDeploy["context"], createdAt: number, state = "ready"): NetlifyDeploy {
  const buildMs = core.chaos.deploy_ms;
  const d: NetlifyDeploy = {
    id: core.nextId("dpl"),
    state: buildMs > 0 ? "enqueued" : state,
    context,
    branch: p.branch,
    commit_ref: p.sha,
    review_id: context === "deploy-preview" ? (p.pr ?? null) : null,
    createdAt,
    ...(buildMs > 0 ? { readyAt: createdAt + buildMs, finalState: state } : {}),
    createdBy: "api",
  };
  s.deploys.push(d);
  return d;
}

function refresh(list: NetlifyDeploy[], now = Date.now()): void {
  for (const d of list) {
    if (d.readyAt === undefined || d.finalState === undefined) continue;
    if (now >= d.readyAt) {
      d.state = d.finalState;
      delete d.finalState;
    } else d.state = "building";
  }
}

function publicEnv(e: NetlifyEnvVar) {
  return {
    key: e.key,
    scopes: ["builds", "functions", "runtime", "post-processing"],
    is_secret: e.is_secret,
    updated_at: new Date(e.updatedAt).toISOString(),
    // A secret's values are write-only, except in `dev` (NL4).
    values: e.values.map((v) => (e.is_secret && v.context !== "dev" ? { id: v.id, context: v.context, ...(v.context_parameter ? { context_parameter: v.context_parameter } : {}) } : { ...v })),
  };
}

function publicDeploy(s: NetlifySite, d: NetlifyDeploy) {
  return {
    id: d.id,
    name: s.name,
    state: d.state,
    context: d.context,
    branch: d.branch,
    commit_ref: d.commit_ref,
    review_id: d.review_id,
    created_at: new Date(d.createdAt).toISOString(),
    deploy_ssl_url: `https://${d.id}--${s.name}.netlify.app`,
  };
}

/** Netlify's error body: `{ code, message }`. */
function badRequest(message: string): Reply {
  return new Reply(400, { code: 400, message });
}

function notFound(what: string): Reply {
  return new Reply(404, { code: 404, message: `${what} not found` });
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
