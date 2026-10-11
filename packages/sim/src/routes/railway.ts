/**
 * Simulated Railway public GraphQL API (`POST https://backboard.railway.com/graphql/v2`), the subset that sets the
 * variables of a service in an environment (a pull-request environment Railway created): enough to test the generic
 * `http` adapter's GraphQL requests against Railway's real operation shapes.
 *
 * Assumptions (docs/api-verification.md, "Railway and Fly.io through the generic adapter"):
 *   RW1. One endpoint; `Authorization: Bearer <account or workspace token>` (a project token goes in
 *        `Project-Access-Token`). Verified: docs.railway.com/reference/public-api.
 *   RW2. Failures are HTTP 200 with `errors[]` (`message`, `extensions.code`); a refused token is
 *        `INTERNAL_SERVER_ERROR` "Not Authorized". Verified: same page ("Always inspect the errors array").
 *   RW3. `variables(projectId: String!, environmentId: String!, serviceId: String, unrendered: Boolean)` answers the
 *        `EnvironmentVariables` scalar, a flat map of name → string; without `serviceId`, the shared variables.
 *        Verified: railwayapp/cli src/gql/schema.json.
 *   RW4. `variableUpsert(input: VariableUpsertInput!): Boolean!` (projectId, environmentId, serviceId?, name, value,
 *        skipDeploys?) creates or replaces one variable; `variableDelete(input: VariableDeleteInput!): Boolean!`
 *        (projectId, environmentId, name, serviceId?) removes it. Verified: same schema. Deleting a variable that
 *        does not exist answers `true` here: unverified (the adapter treats "not found" as gone either way).
 *   RW5. An unknown project or environment is an error "Environment not found". Unverified wording.
 */
import { graphqlData, graphqlError, graphqlOperation, isMutation } from "../graphql.js";
import { Reply, route, router, type ProviderSim } from "../provider.js";

/** One environment: its project and name (a PR environment is named after the pull request). */
export interface RailwayEnvironment {
  projectId: string;
  name: string;
}

/** Simulated Railway state: environments, and variables by `<environmentId>/<serviceId or "">`. */
export interface RailwayState {
  environments: Record<string, RailwayEnvironment>;
  variables: Record<string, Record<string, string>>;
}

/** Initial Railway state. */
export interface RailwaySeed {
  environments?: Record<string, RailwayEnvironment>;
  variables?: Record<string, Record<string, string>>;
}

/** The project and PR environment of the default seed. */
export const RAILWAY_DEMO = { projectId: "prj-railway-demo", environmentId: "env-pr-42", serviceId: "svc-web" } as const;

/** Simulated Railway GraphQL API; see the assumptions at the top of this file. */
export const railwaySim: ProviderSim<RailwayState, RailwaySeed> = {
  env: { token: "RAILWAY_TOKEN", url: "RAILWAY_API_URL", testToken: "tok_railway" },
  defaultSeed: { environments: { [RAILWAY_DEMO.environmentId]: { projectId: RAILWAY_DEMO.projectId, name: "pr-42" } } },

  reset(_core, seed) {
    return { environments: structuredClone(seed?.environments ?? {}), variables: structuredClone(seed?.variables ?? {}) };
  },

  /** `vars.<environmentId>.<serviceId or "shared">.<NAME>`: a new value, or "delete". */
  drift(_core, state, { key, rest, value, only }) {
    if (only !== undefined) return false;
    const [kind, env, service, name] = rest.split(".");
    if (kind !== "vars" || !env || !service || !name) return false;
    const k = `${env}/${service === "shared" ? "" : service}`;
    const vars = (state.variables[k] ??= {});
    if (value === "delete") {
      if (!(name in vars)) throw new Error(`drift ${key}: no variable ${name}`);
      delete vars[name];
    } else vars[name] = value;
    return true;
  },

  isWrite(req) {
    return isMutation(req.body);
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

type Scope = { key: string } | Reply;

/** The variable map a request addresses (RW3, RW5). */
function scopeOf(state: RailwayState, a: Record<string, unknown>): Scope {
  const projectId = str(a.projectId);
  const environmentId = str(a.environmentId);
  if (!projectId || !environmentId) return graphqlError("projectId and environmentId are required", "BAD_USER_INPUT", 400);
  const env = state.environments[environmentId];
  if (!env || env.projectId !== projectId) return graphqlError("Environment not found", "NOT_FOUND");
  return { key: `${environmentId}/${str(a.serviceId) ?? ""}` };
}

function input(v: Record<string, unknown>): Record<string, unknown> {
  return typeof v.input === "object" && v.input !== null ? (v.input as Record<string, unknown>) : {};
}

const RESOLVERS: Record<string, (state: RailwayState, variables: Record<string, unknown>) => Reply> = {
  variables(state, v) {
    const scope = scopeOf(state, v);
    if (scope instanceof Reply) return scope;
    return graphqlData({ variables: { ...(state.variables[scope.key] ?? {}) } });
  },
  variableUpsert(state, v) {
    const i = input(v);
    const scope = scopeOf(state, i);
    if (scope instanceof Reply) return scope;
    const name = str(i.name);
    if (!name || typeof i.value !== "string") return graphqlError("name and value are required", "BAD_USER_INPUT", 400);
    (state.variables[scope.key] ??= {})[name] = i.value;
    return graphqlData({ variableUpsert: true });
  },
  variableDelete(state, v) {
    const i = input(v);
    const scope = scopeOf(state, i);
    if (scope instanceof Reply) return scope;
    const name = str(i.name);
    if (!name) return graphqlError("name is required", "BAD_USER_INPUT", 400);
    delete state.variables[scope.key]?.[name];
    return graphqlData({ variableDelete: true });
  },
};

const routes = router<RailwayState>(
  [
    route("POST", "/", ({ state, body }) => {
      const op = graphqlOperation(body);
      if (op instanceof Reply) return op;
      const resolve = RESOLVERS[op.root];
      return resolve ? resolve(state, op.variables) : graphqlError(`Cannot query field "${op.root}" (not simulated)`, "GRAPHQL_VALIDATION_FAILED", 400);
    }),
  ],
  () => new Reply(404, { error: "not found" }),
);
