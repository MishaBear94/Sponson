/**
 * GraphQL requests of `http.resource`, against sims of Railway and Fly.io that answer the operations their official
 * clients send (see the assumptions at the top of packages/sim/src/routes/railway.ts and fly.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { isSponsonError, pendingMarker, resolveParams } from "@sponson/core";
import { httpAdapter } from "./http-adapter.js";
import { classifyGraphqlError, fillVariables, parseGraphql, rootField } from "./http-adapter-graphql.js";
import { harness, type Harness } from "./testing.js";

const resource = httpAdapter.ops.resource!;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// Railway: https://docs.railway.com/reference/public-api; operations from railwayapp/cli src/gql.
const RAILWAY_API = { base_url: "https://backboard.railway.com/graphql/v2", base_url_env: "RAILWAY_API_URL", auth: { bearer_env: "RAILWAY_TOKEN" } };
const SCOPE = { projectId: "prj-railway-demo", environmentId: "env-pr-42", serviceId: "svc-web" };
const VARIABLES = "query variables($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }";
const UPSERT = "mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }";
const DELETE = "mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }";
const railwayVar = (value: unknown) => ({
  api: "railway",
  read: { graphql: { query: VARIABLES, variables: SCOPE, data_path: "/variables/API_URL" } },
  create: { graphql: { query: UPSERT, variables: { input: { ...SCOPE, name: "API_URL", value } } } },
  update: { graphql: { query: UPSERT, variables: { input: { ...SCOPE, name: "API_URL", value } } } },
  delete: { graphql: { query: DELETE, variables: { input: { ...SCOPE, name: "API_URL" } } } },
  fields: { value },
});
const RAILWAY_KEY = 'graphql:variables({"environmentId":"env-pr-42","projectId":"prj-railway-demo","serviceId":"svc-web"})/variables/API_URL';

// Fly.io: operations from superfly/fly-go resource_secrets.go and schema.graphql.
const FLY_API = { base_url: "https://api.fly.io/graphql", base_url_env: "FLY_API_URL", auth: { header: "Authorization", value_env: "FLY_API_TOKEN" } };
const APP_SECRETS = "query ($appName: String!) { app(name: $appName) { secrets { name digest createdAt } } }";
const SET = "mutation($input: SetSecretsInput!) { setSecrets(input: $input) { release { id version } } }";
const UNSET = "mutation($input: UnsetSecretsInput!) { unsetSecrets(input: $input) { release { id version } } }";
const flySecret = (app: string) => ({
  api: "fly",
  find: { graphql: { query: APP_SECRETS, variables: { appName: app }, data_path: "/app/secrets" }, match: { name: "DATABASE_URL" } },
  create: { graphql: { query: SET, variables: { input: { appId: app, secrets: [{ key: "DATABASE_URL", value: "postgres://u:p4ssw0rd-0042@db/pr42" }] } } } },
  delete: { graphql: { query: UNSET, variables: { input: { appId: app, keys: ["DATABASE_URL"] } } } },
});

async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (isSponsonError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a failure");
}

describe("http.resource over GraphQL: Railway variables", () => {
  it("creates with variableUpsert, reads the variable from the `variables` map, updates on drift, deletes with variableDelete", async () => {
    h = await harness();
    const actx = h.actx("http", RAILWAY_API);
    const line = railwayVar("https://api-pr-42.example.app");
    expect(await resource.read(actx, line)).toBeNull();
    expect(resource.diff(null, line)).toEqual([{ key: RAILWAY_KEY, kind: "create", label: `railway ${RAILWAY_KEY}`, before: { state: "absent" }, after: { state: "literal", value: '{"value":"https://api-pr-42.example.app"}' } }]);

    const r = await resource.apply(actx, line, null);
    expect(r.created).toEqual([RAILWAY_KEY]);
    expect(r.outputs).toEqual({ id: RAILWAY_KEY });
    expect(r.resources[0]!.id).toBe(`GRAPHQL {"query":${JSON.stringify(DELETE)},"variables":{"input":{"environmentId":"env-pr-42","name":"API_URL","projectId":"prj-railway-demo","serviceId":"svc-web"}}}`);
    expect(h.sim.state.railway.variables["env-pr-42/svc-web"]).toEqual({ API_URL: "https://api-pr-42.example.app" });
    expect(h.intents).toEqual([{ keys: [RAILWAY_KEY], writesBefore: 0 }]);

    // apply; apply: queries are not writes, and nothing differs.
    const live = await resource.read(actx, line);
    expect(resource.diff(live, line).map((d) => d.kind)).toEqual(["unchanged"]);
    expect((await resource.apply(actx, line, live)).created).toEqual([]);
    expect(h.sim.state.writes).toHaveLength(1);

    // Edited in the dashboard: changed, and an update puts it back.
    await h.chaos({ drift: { "railway.vars.env-pr-42.svc-web.API_URL": "https://elsewhere.example" } });
    const drifted = await resource.read(actx, line);
    expect(resource.diff(drifted, line)[0]).toMatchObject({ kind: "update", before: { value: '{"value":"https://elsewhere.example"}' } });
    await resource.apply(actx, line, drifted);
    expect(h.sim.state.railway.variables["env-pr-42/svc-web"]!.API_URL).toBe("https://api-pr-42.example.app");

    await resource.destroy(actx, r.resources);
    expect(h.sim.state.railway.variables["env-pr-42/svc-web"]).toEqual({});
    expect(await resource.read(actx, line)).toBeNull();
    expect(h.sim.state.writes.map((w) => w.method)).toEqual(["POST", "POST", "POST"]);
  });

  it("a reference in the mutation's variables is pending until known; the key is known from the read alone", () => {
    const line = resolveParams(railwayVar({ from: "api.url" }), new Map(), new Map()).params;
    expect(resource.diff(null, line)).toEqual([{ key: RAILWAY_KEY, kind: "create", label: `railway ${RAILWAY_KEY}`, before: { state: "absent" }, after: { state: "pending", ref: "api.url" } }]);
    const pendingScope = { ...railwayVar("x"), read: { graphql: { query: VARIABLES, variables: { ...SCOPE, environmentId: pendingMarker("env.id") }, data_path: "/variables/API_URL" } } };
    expect(resource.diff(null, pendingScope)[0]).toMatchObject({ key: "(pending)", after: { state: "pending" } });
  });

  it("errors[] are provider errors: an unknown environment fails the create with PROVIDER_NOT_FOUND", async () => {
    h = await harness();
    const line = railwayVar("x");
    const wrongEnv = JSON.parse(JSON.stringify(line).replaceAll("env-pr-42", "env-nope")) as Record<string, unknown>;
    expect(await resource.read(h.actx("http", RAILWAY_API), wrongEnv)).toBeNull();
    expect(await failure(resource.apply(h.actx("http", RAILWAY_API), wrongEnv, null))).toMatchObject({ code: "PROVIDER_NOT_FOUND", message: "http: GraphQL variableUpsert → NOT_FOUND: Environment not found" });
    const unknownField = { ...line, read: { graphql: { query: "query { nope }" } } };
    expect(await failure(resource.read(h.actx("http", RAILWAY_API), unknownField))).toMatchObject({ code: "PROVIDER_INVALID", message: expect.stringContaining("400") });
  });
});

describe("http.resource over GraphQL: Fly.io secrets", () => {
  it("finds a secret by name in the app's list, sets it with setSecrets, removes it with unsetSecrets; the value is never compared", async () => {
    h = await harness();
    const actx = h.actx("http", FLY_API, { env: { ...h.env, FLY_API_TOKEN: "FlyV1 fm2_sim-macaroon-0042" } });
    const line = flySecret("demo-pr-42");
    const key = 'graphql:app({"appName":"demo-pr-42"})/app/secrets[name=DATABASE_URL]';
    expect(await resource.read(actx, line)).toBeNull();
    const r = await resource.apply(actx, line, null);
    expect(r.created).toEqual([key]);
    expect(h.sim.state.fly.apps["demo-pr-42"]!.secrets.DATABASE_URL!.value).toBe("postgres://u:p4ssw0rd-0042@db/pr42");
    const live = await resource.read(actx, line);
    expect(live!.resources[0]).toMatchObject({ key, hash: r.resources[0]!.hash });
    expect(resource.diff(live, line).map((d) => d.kind)).toEqual(["unchanged"]);
    await resource.destroy(actx, r.resources);
    expect(h.sim.state.fly.apps["demo-pr-42"]!.secrets).toEqual({});
    await resource.destroy(actx, r.resources); // unsetting a key that is not set is fine
  });

  it("an existing secret is taken over, not set again; an unknown app is PROVIDER_NOT_FOUND", async () => {
    h = await harness({ fly: { apps: { "demo-pr-42": { secrets: { DATABASE_URL: "set-by-hand" } } } } });
    const actx = h.actx("http", FLY_API, { env: { ...h.env, FLY_API_TOKEN: "Bearer tok_fly" } });
    // The header form sends the variable as it is: a token without its scheme is refused.
    expect(await failure(resource.read(h.actx("http", FLY_API), flySecret("demo-pr-42")))).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringMatching(/^http: GraphQL app → 401/) });
    const live = await resource.read(actx, flySecret("demo-pr-42"));
    expect(live).not.toBeNull();
    expect(h.sim.state.fly.apps["demo-pr-42"]!.secrets.DATABASE_URL!.value).toBe("set-by-hand");
    // As a REST find whose list is 404, a find whose query answers "not found" fails: the app must exist first.
    expect(await failure(resource.read(actx, flySecret("ghost")))).toMatchObject({ code: "PROVIDER_NOT_FOUND", message: "http: GraphQL app → NOT_FOUND: Could not find App" });
  });
});

describe("GraphQL request syntax", () => {
  it("parses a request and names it by its root field (after an alias), never by its text", () => {
    expect(parseGraphql({ query: VARIABLES, variables: SCOPE, data_path: "/variables/X", idempotent: true }, "read.graphql", true)).toEqual({ query: VARIABLES, variables: SCOPE, dataPath: "/variables/X", idempotent: true });
    expect(rootField("# comment {\nquery { renamed: app(name: $n) { id } }")).toBe("app");
    expect(rootField("mutation M($i: I!) {\n  setSecrets(input: $i) { release { id } } }")).toBe("setSecrets");
    expect(fillVariables({ input: { id: "{id}", list: ["{id}", "x"], n: 1 } }, "abc")).toEqual({ input: { id: "abc", list: ["abc", "x"], n: 1 } });
  });

  const bad: Array<[string, unknown, boolean, RegExp]> = [
    ["not a map", "query { x }", true, /must be a map/],
    ["no query", { variables: {} }, true, /GraphQL document/],
    ["no selection", { query: "query" }, true, /GraphQL document/],
    ["unknown key", { query: "{ x }", operationName: "X" }, true, /operationName` is not known/],
    ["variables not a map", { query: "{ x }", variables: [1] }, true, /map of variable name/],
    ["{id} before the id exists", { query: "{ x }", variables: { id: "{id}" } }, false, /not known here/],
    ["data_path not a pointer", { query: "{ x }", data_path: "app.secrets" }, true, /JSON pointer/],
    ["idempotent not a boolean", { query: "{ x }", idempotent: "yes" }, true, /true or false/],
  ];
  it.each(bad)("refuses %s", (_why, v, idAllowed, message) => {
    expect(() => parseGraphql(v, "create.graphql", idAllowed)).toThrow(message);
  });

  it("a GraphQL request stands alone; find takes no cursor; a GraphQL read needs an explicit delete; no secret in a key or a delete", () => {
    const line = railwayVar("x");
    expect(() => resource.diff(null, { ...line, create: { path: "/x", graphql: { query: UPSERT } } })).toThrow(/`create.path` does not apply to a GraphQL request/);
    expect(() => resource.diff(null, { ...line, delete: undefined })).toThrow(/`delete` is required/);
    expect(() => resource.diff(null, { ...line, update: {} })).toThrow(/`update.path` must be a path/);
    expect(() => resource.diff(null, { ...flySecret("a"), find: { ...flySecret("a").find, next: "/cursor" } })).toThrow(/`find.next` does not apply to a GraphQL find/);
    expect(() => resource.diff(null, { ...flySecret("a"), find: { ...flySecret("a").find, match: {} } })).toThrow(/at least one field/);
    expect(() => resource.diff(null, { ...line, read: { graphql: { query: VARIABLES, variables: { id: "{id}" } } } })).toThrow(/can only be located with `find`/);
    const secret = resolveParams({ ...line, delete: { graphql: { query: DELETE, variables: { token: { secret: "env://RAILWAY_TOKEN" } } } } }, new Map(), new Map()).params;
    expect(() => resource.diff(null, secret)).toThrow(/may not hold a `\{ secret \}`/);
  });

  it("classifies errors by message first, then by extensions.code", () => {
    expect(classifyGraphqlError("Not Authorized", "INTERNAL_SERVER_ERROR")).toBe("PROVIDER_AUTH");
    expect(classifyGraphqlError("Could not find App", undefined)).toBe("PROVIDER_NOT_FOUND");
    expect(classifyGraphqlError("name already exists", undefined)).toBe("PROVIDER_CONFLICT");
    expect(classifyGraphqlError("boom", "INTERNAL_SERVER_ERROR")).toBe("PROVIDER_TRANSIENT");
    expect(classifyGraphqlError("slow down", "RATE_LIMITED")).toBe("PROVIDER_TRANSIENT");
    expect(classifyGraphqlError("bad", "BAD_USER_INPUT")).toBe("PROVIDER_INVALID");
    expect(classifyGraphqlError("bad", "SOMETHING_ELSE")).toBe("PROVIDER_INVALID");
  });
});
