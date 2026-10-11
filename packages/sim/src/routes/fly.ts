/**
 * Simulated Fly.io GraphQL API (`POST https://api.fly.io/graphql`), the subset that sets an app's secrets: enough
 * to test the generic `http` adapter's GraphQL requests against Fly's real operation shapes.
 *
 * Assumptions (docs/api-verification.md, "Railway and Fly.io through the generic adapter"):
 *   F1. `Authorization: Bearer <token>`, or `FlyV1 <macaroon>` for the tokens `fly tokens create` prints (sent as
 *       they are). Verified: superfly/fly-go tokens/tokens.go.
 *   F2. `app(name: String!) { secrets { name digest createdAt } }` lists an app's secrets; values are never
 *       returned. Verified: fly-go resource_secrets.go and schema.graphql.
 *   F3. `setSecrets(input: SetSecretsInput!)` (appId: the app name, secrets: [{ key, value }], replaceAll?) and
 *       `unsetSecrets(input: UnsetSecretsInput!)` (appId, keys) answer `{ app, release }`; each makes a new
 *       release. Verified: fly-go schema.graphql. Unsetting a key that is not set is not an error here: unverified.
 *   F4. Failures are HTTP 200 with `errors[]`; an unknown app is "Could not find App". Unverified wording.
 */
import { createHash } from "node:crypto";
import { graphqlData, graphqlError, graphqlOperation, isMutation } from "../graphql.js";
import { Reply, route, router, type ProviderSim } from "../provider.js";

/** One secret as stored: the value (never answered), its digest and when it was set. */
export interface FlySecret {
  value: string;
  digest: string;
  createdAt: string;
}

/** Simulated Fly.io state: apps by name, with their secrets and release counter. */
export interface FlyState {
  apps: Record<string, { secrets: Record<string, FlySecret>; releases: number }>;
}

/** Initial Fly.io state: apps by name, with secret values. */
export interface FlySeed {
  apps?: Record<string, { secrets?: Record<string, string> }>;
}

/** Simulated Fly.io GraphQL API; see the assumptions at the top of this file. */
export const flySim: ProviderSim<FlyState, FlySeed> = {
  env: { token: "FLY_API_TOKEN", url: "FLY_API_URL", testToken: "tok_fly" },
  defaultSeed: { apps: { "demo-pr-42": {} } },

  reset(_core, seed) {
    const apps: FlyState["apps"] = {};
    for (const [name, a] of Object.entries(seed?.apps ?? {})) {
      apps[name] = { secrets: Object.fromEntries(Object.entries(a.secrets ?? {}).map(([k, v]) => [k, secret(v)])), releases: 0 };
    }
    return { apps };
  },

  /** `secrets.<app>.<NAME>`: a new value, or "delete". */
  drift(_core, state, { key, rest, value, only }) {
    if (only !== undefined) return false;
    const [kind, app, name] = rest.split(".");
    if (kind !== "secrets" || !app || !name) return false;
    const a = state.apps[app];
    if (!a) throw new Error(`drift ${key}: no app ${app}`);
    if (value === "delete") delete a.secrets[name];
    else a.secrets[name] = secret(value);
    return true;
  },

  authorized(headers) {
    return /^(Bearer|FlyV1)\s+\S+/.test(headers.authorization ?? "");
  },

  isWrite(req) {
    return isMutation(req.body);
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function secret(value: string): FlySecret {
  return { value, digest: createHash("sha256").update(value).digest("hex").slice(0, 16), createdAt: "2026-10-11T00:00:00Z" };
}

function input(v: Record<string, unknown>): Record<string, unknown> {
  return typeof v.input === "object" && v.input !== null ? (v.input as Record<string, unknown>) : {};
}

function appOf(state: FlyState, name: unknown): FlyState["apps"][string] | Reply {
  const app = typeof name === "string" ? state.apps[name] : undefined;
  return app ?? graphqlError("Could not find App", "NOT_FOUND");
}

function release(app: FlyState["apps"][string], name: string, field: string): Reply {
  app.releases += 1;
  return graphqlData({ [field]: { app: { name }, release: { id: `rel_${app.releases}`, version: app.releases } } });
}

const RESOLVERS: Record<string, (state: FlyState, variables: Record<string, unknown>) => Reply> = {
  app(state, v) {
    const name = v.appName ?? v.name;
    const app = appOf(state, name);
    if (app instanceof Reply) return app;
    return graphqlData({ app: { name, secrets: Object.entries(app.secrets).map(([n, s]) => ({ name: n, digest: s.digest, createdAt: s.createdAt })) } });
  },
  setSecrets(state, v) {
    const i = input(v);
    const app = appOf(state, i.appId);
    if (app instanceof Reply) return app;
    const list = Array.isArray(i.secrets) ? (i.secrets as Array<Record<string, unknown>>) : [];
    if (list.length === 0 || !list.every((s) => typeof s.key === "string" && typeof s.value === "string")) return graphqlError("secrets must be a non-empty list of { key, value }", "BAD_USER_INPUT");
    if (i.replaceAll === true) app.secrets = {};
    for (const s of list) app.secrets[s.key as string] = secret(s.value as string);
    return release(app, i.appId as string, "setSecrets");
  },
  unsetSecrets(state, v) {
    const i = input(v);
    const app = appOf(state, i.appId);
    if (app instanceof Reply) return app;
    const keys = Array.isArray(i.keys) ? i.keys.filter((k): k is string => typeof k === "string") : [];
    if (keys.length === 0) return graphqlError("keys must be a non-empty list", "BAD_USER_INPUT");
    for (const k of keys) delete app.secrets[k];
    return release(app, i.appId as string, "unsetSecrets");
  },
};

const routes = router<FlyState>(
  [
    route("POST", "/", ({ state, body }) => {
      const op = graphqlOperation(body);
      if (op instanceof Reply) return op;
      const resolve = RESOLVERS[op.root];
      return resolve ? resolve(state, op.variables) : graphqlError(`Cannot query field "${op.root}" on type "${op.kind === "mutation" ? "Mutations" : "Queries"}"`, "GRAPHQL_VALIDATION_FAILED");
    }),
  ],
  () => new Reply(404, { error: "not found" }),
);
