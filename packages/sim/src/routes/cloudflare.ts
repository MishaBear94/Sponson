/**
 * Simulated Cloudflare: Pages projects and their per-environment variables (`deployment_configs.<env>.env_vars`).
 *
 * Assumptions about the real API that this fake encodes. Sources (fetched 2026-10-11): the official OpenAPI document
 * https://github.com/cloudflare/api-schemas (`openapi.json`), the API reference pages
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/ and …/methods/edit/,
 * and the Pages docs cited per item. The critical ones are pinned in scenarios/contract.test.ts
 * (`assumption CF<n>: …`) so `pnpm test:live` checks them against a real account.
 *
 *   CF1. Base URL `https://api.cloudflare.com/client/v4`, `Authorization: Bearer <API token>` — verified
 *        (https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/). The token needs the
 *        account permission "Cloudflare Pages Edit" (fundamentals/api/reference/permissions/; schema token groups
 *        "Pages Read"/"Pages Write").
 *   CF2. `GET /accounts/{account_id}/pages/projects/{project_name}` answers `200 { success, errors, messages, result }`,
 *        `result` a project with `id`, `name`, `subdomain` and `deployment_configs.{preview,production}.env_vars`, a
 *        nullable map NAME → `{ type: "plain_text" | "secret_text", value }` — verified (schema `pages_project`,
 *        `pages_plain_text_env_var`, `pages_secret_text_env_var`).
 *   CF3. A `secret_text` value is never returned: the entry is listed with its type and `value: ""` — partly
 *        verified: the docs say secrets cannot be seen after they are set (pages/functions/bindings/), and the
 *        schema's example is `{"type":"secret_text","value":""}`; whether the key comes back with `""`, null or
 *        no `value` is not stated (the adapter accepts all three). Pinned.
 *   CF4. `PATCH` of the same path merges: `deployment_configs.<env>.env_vars` keys not in the body are left alone, a
 *        key set to `null` is deleted, and the answer is `200` with the updated project — `null` deletes and `200`
 *        verified ("To delete an environment variable, set its key to `null`"); merging is implied by that rule and
 *        by a body with no required fields, but not stated. Pinned: the adapter also re-reads and refuses to go on
 *        if a variable it did not send disappeared.
 *   CF5. No precondition (ETag / If-Match) exists for that PATCH — verified (only path parameters, no 412). Two
 *        writers of the same key race; last write wins. Sponson's own writers take turns through the parent lock
 *        (`lockOn`, ADR 0019).
 *   CF6. Failures answer `4XX { success: false, errors: [{ code, message }], result: null }` — verified (schema
 *        `pages_api-response-common-failure`). An unknown project answers `404` with code `8000007` — unverified:
 *        the schema declares only `4XX`; the status and code come from Wrangler's error reports.
 *   CF7. A write is visible to the next GET at once — unverified. Pinned.
 *   CF8. Preview variables are one set shared by every preview deployment; there are no per-branch values —
 *        verified ("This will set the configuration for all preview deployments, not just the deployments from a
 *        specific branch", pages/functions/wrangler-configuration/).
 *   CF9. Variable names: the schema gives no pattern (free-form map keys); the sim accepts any non-empty name.
 *   CF10. Changing a variable does not change existing deployments; it applies to the next one — indirectly
 *        documented ("Redeploy your project for the binding to take effect", pages/functions/bindings/). The sim
 *        has no deployments, so nothing here depends on it.
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** The two variable sets of a Pages project. */
export type CloudflarePagesEnv = "preview" | "production";

/** One variable as the simulated Cloudflare stores it (the secret's value included: the sim must compare it). */
export interface CloudflareEnvVar {
  type: "plain_text" | "secret_text";
  value: string;
}

/** A Pages project, with the bookkeeping the sim adds (`createdBy`). */
export interface CloudflarePagesProject {
  id: string;
  name: string;
  subdomain: string;
  createdBy: CreatedBy;
  deployment_configs: Record<CloudflarePagesEnv, { env_vars: Record<string, CloudflareEnvVar> }>;
}

/** The simulated Cloudflare's state: Pages projects per account id. */
export interface CloudflareState {
  accounts: Record<string, { projects: Record<string, CloudflarePagesProject> }>;
}

/** Variables of one environment in a seed: NAME → a plain value, or `{ type, value }`. */
export type CloudflareSeedVars = Record<string, string | { type?: CloudflareEnvVar["type"]; value: string }>;

/** What a scenario or test seeds the simulated Cloudflare with (`seed: { cloudflare: … }`). */
export interface CloudflareSeed {
  /** Account id → project name → the variables that already exist (set "by a human", so unmanaged). */
  accounts: Record<string, Record<string, { preview?: CloudflareSeedVars; production?: CloudflareSeedVars }>>;
}

const ENVS: readonly CloudflarePagesEnv[] = ["preview", "production"];

/** The simulated Cloudflare API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/cloudflare`. */
export const cloudflareSim: ProviderSim<CloudflareState, CloudflareSeed> = {
  env: { token: "CLOUDFLARE_API_TOKEN", url: "CLOUDFLARE_API_URL", testToken: "tok_cloudflare" },
  defaultSeed: { accounts: { acc_demo: { demo: {} } } },

  reset(core, seed) {
    const accounts: CloudflareState["accounts"] = {};
    for (const [account, projects] of Object.entries(seed?.accounts ?? {})) {
      accounts[account] = { projects: {} };
      for (const [name, vars] of Object.entries(projects)) accounts[account].projects[name] = project(core, name, vars);
    }
    return { accounts };
  },

  /**
   * `pages_env.<env>.<NAME>` or `cloudflare:<project>.pages_env.<env>.<NAME>`, what a human in the dashboard would do:
   * `delete`; `plain:<value>` or `secret:<value>` (set, choosing the type); any other value replaces the value and
   * keeps the type. Setting a variable that does not exist creates it as plain text.
   */
  drift(_core, state, { key, rest, value, only }) {
    const m = /^pages_env\.(preview|production)\.(.+)$/.exec(rest);
    if (!m) return false;
    const env = m[1] as CloudflarePagesEnv;
    const name = m[2]!;
    const projects = Object.values(state.accounts).flatMap((a) => Object.values(a.projects)).filter((p) => only === undefined || p.name === only);
    if (projects.length === 0) throw new Error(`drift ${key}: no Pages project${only ? ` named ${only}` : ""}`);
    for (const p of projects) {
      const vars = p.deployment_configs[env].env_vars;
      if (value === "delete") delete vars[name];
      else if (value.startsWith("plain:")) vars[name] = { type: "plain_text", value: value.slice("plain:".length) };
      else if (value.startsWith("secret:")) vars[name] = { type: "secret_text", value: value.slice("secret:".length) };
      else vars[name] = { type: vars[name]?.type ?? "plain_text", value };
    }
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

const PROJECT = "/accounts/:account/pages/projects/:project";

const routes = router<CloudflareState>(
  [
    route("GET", PROJECT, ({ state, params }) => {
      const p = state.accounts[params.account]?.projects[params.project];
      return p ? ok(publicProject(p)) : notFound();
    }),

    route("PATCH", PROJECT, ({ state, params, body }) => {
      const p = state.accounts[params.account]?.projects[params.project];
      if (!p) return notFound();
      const problem = patchProblem(body);
      if (problem) return failure(400, 8000000, problem);
      const configs = (body as { deployment_configs?: Record<string, { env_vars?: Record<string, CloudflareEnvVar | null> | null }> }).deployment_configs ?? {};
      for (const env of ENVS) {
        // CF4: a merge. Keys absent from the body stay; `null` deletes.
        for (const [name, v] of Object.entries(configs[env]?.env_vars ?? {})) {
          if (v === null) delete p.deployment_configs[env].env_vars[name];
          else p.deployment_configs[env].env_vars[name] = { type: v.type, value: v.value };
        }
      }
      return ok(publicProject(p));
    }),
  ],
  () => failure(404, 7003, "No route for the URI"),
);

/** Why a PATCH body is refused, or undefined. Only what the schema says about `env_vars` entries is checked. */
function patchProblem(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
  const configs = (body as Record<string, unknown>).deployment_configs;
  if (configs === undefined) return undefined;
  if (configs === null || typeof configs !== "object") return "deployment_configs must be an object";
  for (const env of Object.keys(configs)) {
    if (!(ENVS as readonly string[]).includes(env)) return `unknown deployment config ${env}`;
    const problem = envVarsProblem(env, (configs as Record<string, { env_vars?: unknown }>)[env]?.env_vars);
    if (problem) return problem;
  }
  return undefined;
}

/** Why one `env_vars` map of a PATCH body is refused, or undefined. */
function envVarsProblem(env: string, vars: unknown): string | undefined {
  if (vars === undefined || vars === null) return undefined;
  if (typeof vars !== "object" || Array.isArray(vars)) return `deployment_configs.${env}.env_vars must be an object`;
  for (const [name, v] of Object.entries(vars as Record<string, unknown>)) {
    if (name === "") return "environment variable names must not be empty";
    if (v === null) continue;
    const e = v as Partial<CloudflareEnvVar>;
    if ((e.type !== "plain_text" && e.type !== "secret_text") || typeof e.value !== "string") return `deployment_configs.${env}.env_vars.${name} must be { type: plain_text | secret_text, value: string }`;
  }
  return undefined;
}

function ok(result: unknown): Reply {
  return new Reply(200, { success: true, errors: [], messages: [], result });
}

function failure(status: number, code: number, message: string): Reply {
  return new Reply(status, { success: false, errors: [{ code, message }], messages: [], result: null });
}

/** CF6: what Wrangler reports for an unknown project. */
function notFound(): Reply {
  return failure(404, 8000007, "Project not found. The specified project name does not match any of your existing projects.");
}

function project(core: SimCore, name: string, seed: { preview?: CloudflareSeedVars; production?: CloudflareSeedVars }): CloudflarePagesProject {
  const vars = (s: CloudflareSeedVars | undefined): Record<string, CloudflareEnvVar> =>
    Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, typeof v === "string" ? { type: "plain_text", value: v } : { type: v.type ?? "plain_text", value: v.value }]));
  return {
    id: core.nextId("cf_"),
    name,
    subdomain: `${name}.pages.dev`,
    createdBy: "sim",
    deployment_configs: { preview: { env_vars: vars(seed.preview) }, production: { env_vars: vars(seed.production) } },
  };
}

/** The project as GET answers it: CF3, a secret's value is never returned. */
function publicProject(p: CloudflarePagesProject): Record<string, unknown> {
  const config = (env: CloudflarePagesEnv) => ({
    env_vars: Object.fromEntries(Object.entries(p.deployment_configs[env].env_vars).map(([k, v]) => [k, v.type === "secret_text" ? { type: v.type, value: "" } : { ...v }])),
  });
  return { id: p.id, name: p.name, subdomain: p.subdomain, production_branch: "main", deployment_configs: { preview: config("preview"), production: config("production") } };
}
