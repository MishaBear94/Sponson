/**
 * The generic adapter's run-time credentials against sims that check them for real: an OAuth2 token endpoint, a
 * command's token, SigV4 (S3 CORS in XML, Amplify in JSON) and HTTP Digest. Every token a test obtains must reach
 * `actx.secret` (the engine's redactor) before it is used.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isSponsonError, type AdapterContext, type Ctx, type OpSpec } from "@sponson/core";
import type { SimSeed } from "@sponson/sim";
import { createHttpAdapter, httpAdapter } from "./http-adapter.js";
import { COMMAND_TOKEN_TTL_MS, parseAuth } from "./http-adapter-auth.js";
import type { Exec } from "./secrets.js";
import { harness, type Harness } from "./testing.js";

const resource = httpAdapter.ops.resource!;
const listItem = httpAdapter.ops.list_item!;

let h: Harness;
let open: Harness | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function start(seed?: Partial<SimSeed>): Promise<Harness> {
  open = h = await harness(seed);
  return h;
}

/** An adapter context with extra environment, a fresh run (its own token cache) and a record of registered secrets. */
function run(extraEnv: Record<string, string>, provider: Record<string, unknown>): { actx: AdapterContext; secrets: string[] } {
  const secrets: string[] = [];
  const ctx: Ctx = { ...h.ctx };
  return { secrets, actx: h.actx("http", provider, { ctx, env: { ...h.env, ...extraEnv }, secret: (v) => void secrets.push(v) }) };
}

async function applyOnce(op: OpSpec, actx: AdapterContext, params: Record<string, unknown>) {
  const live = await op.read(actx, params);
  return op.apply(actx, params, live);
}

async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (isSponsonError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a failure");
}

// ---------------------------------------------------------------------------
// OAuth2 client credentials (Auth0 Management API shape)
// ---------------------------------------------------------------------------

const AUTH0_SEED: Partial<SimSeed> = {
  rest: { objects: { "/clients/abc123": { name: "web", callbacks: ["https://app.example.com/callback"] } }, auth: { clients: { "m2m-client": "m2m-client-secret-0042" }, token_ttl: 3600 } },
};

const AUTH0 = (extra: Record<string, unknown> = {}) => ({
  base_url: "https://tenant.eu.auth0.com/api/v2",
  base_url_env: "REST_API_URL",
  auth: {
    oauth2_client_credentials: {
      token_url: "https://tenant.eu.auth0.com/oauth/token",
      token_url_env: "AUTH0_TOKEN_URL",
      client_id_env: "AUTH0_CLIENT_ID",
      client_secret_env: "AUTH0_CLIENT_SECRET",
      audience: "https://tenant.eu.auth0.com/api/v2/",
      ...extra,
    },
  },
});

const CALLBACK = { api: "auth0", parent: { path: "/clients/abc123" }, list_path: "/callbacks", item: "https://pr-42.preview.example.app/callback" };

describe("auth: oauth2_client_credentials", () => {
  const env = () => ({ AUTH0_TOKEN_URL: `${h.sim.url}/rest/oauth/token`, AUTH0_CLIENT_ID: "m2m-client", AUTH0_CLIENT_SECRET: "m2m-client-secret-0042" });

  it("fetches one token per run (client_secret_post, audience), registers it as a secret, and the API accepts it", async () => {
    await start(AUTH0_SEED);
    const { actx, secrets } = run(env(), AUTH0());
    const r = await applyOnce(listItem, actx, CALLBACK);
    expect(r.created).toHaveLength(1);
    expect(await listItem.read(actx, CALLBACK)).not.toBeNull();
    expect(h.sim.state.rest.objects["/clients/abc123"]!.callbacks).toEqual(["https://app.example.com/callback", CALLBACK.item]);
    const auth = h.sim.state.rest.auth!;
    expect(auth.issued.map((t) => [t.token, t.method, t.audience])).toEqual([["oauth-access-token-1", "client_secret_post", "https://tenant.eu.auth0.com/api/v2/"]]);
    expect(secrets).toEqual(["oauth-access-token-1"]);
    // The token request is not a write (plan stays write-free).
    expect(h.sim.state.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /rest/clients/abc123"]);
    // A new run fetches its own token.
    await listItem.read(run(env(), AUTH0()).actx, CALLBACK);
    expect(auth.issued).toHaveLength(2);
  });

  it("a token refused with 401 is fetched again, once, and the request is sent again", async () => {
    await start(AUTH0_SEED);
    const { actx, secrets } = run(env(), AUTH0());
    await applyOnce(listItem, actx, CALLBACK);
    await h.chaos({ drift: { "rest.auth.revoke_tokens": "true" } });
    expect(await listItem.read(actx, CALLBACK)).not.toBeNull();
    expect(h.sim.state.rest.auth!.refused).toBe(1);
    expect(secrets).toEqual(["oauth-access-token-1", "oauth-access-token-2"]);
  });

  it("client_secret_basic sends the credentials as HTTP Basic, with scope and extra parameters in the form", async () => {
    await start(AUTH0_SEED);
    const { actx } = run(env(), AUTH0({ auth_method: "client_secret_basic", scope: "read:clients update:clients", extra: { resource: "urn:x" } }));
    await listItem.read(actx, CALLBACK);
    expect(h.sim.state.rest.auth!.issued[0]).toMatchObject({ method: "client_secret_basic", scope: "read:clients update:clients" });
  });

  it("a refused client is PROVIDER_AUTH naming the token endpoint, never the secret; a missing variable names the variable", async () => {
    await start(AUTH0_SEED);
    const wrong = await failure(listItem.read(run({ ...env(), AUTH0_CLIENT_SECRET: "wrong-secret-value-9999" }, AUTH0()).actx, CALLBACK));
    expect(wrong.code).toBe("PROVIDER_AUTH");
    expect(wrong.message).toMatch(/OAuth2 token request to http:\/\/127\.0\.0\.1:\d+\/rest\/oauth\/token failed: 401/);
    expect(wrong.message).not.toContain("wrong-secret-value-9999");
    const unset = await failure(listItem.read(run({ ...env(), AUTH0_CLIENT_SECRET: "" }, AUTH0()).actx, CALLBACK));
    expect(unset).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringContaining("AUTH0_CLIENT_SECRET is not set") });
  });

  it("a token endpoint answering without a bearer token is PROVIDER_RESPONSE", async () => {
    // Without an auth seed, a POST to a REST collection answers `{ data: { … } }`: no `access_token`.
    await start({ rest: { objects: AUTH0_SEED.rest!.objects! } });
    const r = await failure(listItem.read(run({ ...env(), AUTH0_TOKEN_URL: `${h.sim.url}/rest/not-a-token-endpoint` }, AUTH0({ auth_method: "client_secret_basic" })).actx, CALLBACK));
    expect(r.code).toBe("PROVIDER_RESPONSE");
  });
});

// ---------------------------------------------------------------------------
// A command's token (gcloud / az), Firebase authorized domains shape
// ---------------------------------------------------------------------------

const FIREBASE_SEED: Partial<SimSeed> = {
  rest: { objects: { "/projects/demo/config": { authorizedDomains: ["localhost", "demo.firebaseapp.com"] } }, auth: { tokens: ["ya29.cmd-token-2"] } },
};
const FIREBASE = { base_url: "https://identitytoolkit.googleapis.com/admin/v2", base_url_env: "REST_API_URL", auth: { command: ["gcloud", "auth", "print-access-token"] }, headers: { "x-goog-user-project": "demo" } };
const DOMAIN = { api: "firebase", parent: { path: "/projects/demo/config?updateMask=authorizedDomains", read_path: "/projects/demo/config" }, list_path: "/authorizedDomains", item: "pr-42.preview.example.app" };

/** A fake CLI: prints the next token each time; records how it was called. */
function fakeExec(outputs: Array<string | Error>): { exec: Exec; calls: Array<{ file: string; args: string[]; path?: string }> } {
  const calls: Array<{ file: string; args: string[]; path?: string }> = [];
  return {
    calls,
    exec: async (file, args, env) => {
      calls.push({ file, args, ...(env.PATH !== undefined ? { path: env.PATH } : {}) });
      const next = (outputs.length > 1 ? outputs.shift() : outputs[0]) ?? "";
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("auth: command", () => {
  it("runs the argv without a shell once per run, sends its trimmed stdout as the bearer token, and fetches again after a 401", async () => {
    await start(FIREBASE_SEED);
    const cli = fakeExec(["ya29.cmd-token-1\n", "ya29.cmd-token-2\n"]);
    const op = createHttpAdapter({ exec: cli.exec }).ops.list_item!;
    const { actx, secrets } = run({ PATH: "/fake/bin" }, FIREBASE);
    const r = await applyOnce(op, actx, DOMAIN);
    expect(r.created).toHaveLength(1);
    expect(await op.read(actx, DOMAIN)).not.toBeNull();
    expect(h.sim.state.rest.objects["/projects/demo/config"]!.authorizedDomains).toEqual(["localhost", "demo.firebaseapp.com", "pr-42.preview.example.app"]);
    // The first token is refused, the command runs again, and the second is used for every later request.
    expect(cli.calls).toEqual([
      { file: "gcloud", args: ["auth", "print-access-token"], path: "/fake/bin" },
      { file: "gcloud", args: ["auth", "print-access-token"], path: "/fake/bin" },
    ]);
    expect(secrets).toEqual(["ya29.cmd-token-1", "ya29.cmd-token-2"]);
  });

  it("a token is reused until its time is up, then the command runs again", async () => {
    await start(FIREBASE_SEED);
    let now = 1_000_000;
    const cli = fakeExec(["ya29.cmd-token-2"]);
    const op = createHttpAdapter({ exec: cli.exec, now: () => now }).ops.list_item!;
    const { actx } = run({}, FIREBASE);
    await op.read(actx, DOMAIN);
    await op.read(actx, DOMAIN);
    expect(cli.calls).toHaveLength(1);
    now += COMMAND_TOKEN_TTL_MS + 1;
    await op.read(actx, DOMAIN);
    expect(cli.calls).toHaveLength(2);
  });

  it("a missing CLI, a failing one, or one that prints no single token is PROVIDER_AUTH", async () => {
    await start(FIREBASE_SEED);
    const enoent = Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" });
    const cases: Array<[Array<string | Error>, RegExp]> = [
      [[enoent], /`gcloud` is not installed or not on PATH/],
      [[Object.assign(new Error("x"), { code: "EACCES" })], /not executable/],
      [[new Error("gcloud auth failed: You do not currently have an active account selected.")], /`gcloud auth print-access-token` failed: gcloud auth failed: You do not currently have an active account/],
      [["\n"], /printed nothing/],
      [["two words"], /more than one word/],
    ];
    for (const [out, message] of cases) {
      const op = createHttpAdapter({ exec: fakeExec(out).exec }).ops.list_item!;
      expect(await failure(op.read(run({}, FIREBASE).actx, DOMAIN))).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringMatching(message) });
    }
  });

  it("refuses an argv that is not a list of literal arguments", () => {
    const bad: Array<[unknown, RegExp]> = [
      ["gcloud auth print-access-token", /list of arguments/],
      [[], /list of arguments/],
      [["gcloud", { from: "x.y" }], /literal string/],
      [["gcloud", "${ctx.scope}"], /reference/],
      [["gcloud", "$PROJECT"], /reference/],
      [["-x"], /program name/],
      [["gcloud auth"], /one list element per argument/],
    ];
    for (const [command, message] of bad) expect(() => parseAuth({ command }, "providers.http.x.auth"), JSON.stringify(command)).toThrow(message);
    expect(parseAuth({ command: ["az", "account", "get-access-token", "--resource", "https://management.azure.com/", "--query", "accessToken", "-o", "tsv"] }, "w")).toMatchObject({ kind: "command" });
  });
});

// ---------------------------------------------------------------------------
// SigV4: S3 bucket CORS (XML) and Amplify branch variables (JSON)
// ---------------------------------------------------------------------------

const SIGV4 = (service: string) => ({ aws_sigv4: { region: "us-east-1", service, access_key_id_env: "AWS_SIM_ACCESS_KEY_ID", secret_access_key_env: "AWS_SIM_SECRET_ACCESS_KEY" } });
const S3 = { base_url: "https://assets.s3.us-east-1.amazonaws.com", base_url_env: "AWS_S3_URL", encoding: "xml", auth: SIGV4("s3") };
const RULE = (scope: string) => ({
  api: "s3",
  parent: { path: "/?cors", method: "PUT", if_missing: "empty", when_empty: "delete" },
  list_path: "/CORSConfiguration/CORSRule",
  key_field: "ID",
  item: { ID: `sponson-${scope}`, AllowedOrigin: `https://${scope}.preview.example.app`, AllowedMethod: ["GET", "HEAD"], MaxAgeSeconds: "3000" },
});

describe("auth: aws_sigv4", () => {
  const s3env = () => ({ AWS_S3_URL: `${h.sim.url}/aws/s3/assets` });

  it("S3 CORS: rules are added to a configuration that does not exist yet, read back from XML unchanged, and removed down to none", async () => {
    await start();
    const { actx } = run(s3env(), S3);
    expect(await listItem.read(actx, RULE("pr-42"))).toBeNull(); // 404 NoSuchCORSConfiguration reads as empty
    expect((await applyOnce(listItem, actx, RULE("pr-42"))).created).toHaveLength(1);
    expect(h.sim.state.aws.buckets.assets!.cors).toEqual([{ ID: "sponson-pr-42", AllowedOrigin: ["https://pr-42.preview.example.app"], AllowedMethod: ["GET", "HEAD"], AllowedHeader: [], ExposeHeader: [], MaxAgeSeconds: "3000" }]);
    // One rule reads back as one element, not a list of one: still the same item, unchanged.
    const live = await listItem.read(actx, RULE("pr-42"));
    expect(listItem.diff(live, RULE("pr-42")).map((d) => d.kind)).toEqual(["unchanged"]);
    const other = await applyOnce(listItem, actx, RULE("pr-43"));
    expect(h.sim.state.aws.buckets.assets!.cors!.map((r) => r.ID)).toEqual(["sponson-pr-42", "sponson-pr-43"]);
    await listItem.destroy(actx, live!.resources);
    expect(h.sim.state.aws.buckets.assets!.cors!.map((r) => r.ID)).toEqual(["sponson-pr-43"]);
    // The last rule cannot be written as an empty configuration (MalformedXML): the configuration is deleted.
    await listItem.destroy(actx, other.resources);
    expect(h.sim.state.aws.buckets.assets!.cors).toBeNull();
    expect(h.sim.state.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /aws/s3/assets/", "PUT /aws/s3/assets/", "PUT /aws/s3/assets/", "DELETE /aws/s3/assets/"]);
    await listItem.destroy(actx, other.resources); // already gone
  });

  it("a wrong secret key, or temporary credentials whose token is unset, are PROVIDER_AUTH", async () => {
    await start();
    expect(await failure(listItem.read(run({ ...s3env(), AWS_SIM_SECRET_ACCESS_KEY: "not-the-secret-key" }, S3).actx, RULE("pr-42")))).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringContaining("SignatureDoesNotMatch") });
    const temp = { ...S3, auth: { aws_sigv4: { ...SIGV4("s3").aws_sigv4, session_token_env: "AWS_SIM_SESSION_TOKEN" } } };
    expect(await failure(listItem.read(run(s3env(), temp).actx, RULE("pr-42")))).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringContaining("AWS_SIM_SESSION_TOKEN is not set") });
  });

  it("Amplify: a branch variable kept in the map UpdateBranch replaces whole (send: collection, body_list_path)", async () => {
    await start({ aws: { amplify: { d1demo: { branches: { "pr-42": { environmentVariables: { EXISTING: "keep-me" } } } } } } });
    const amplify = { base_url: "https://amplify.us-east-1.amazonaws.com", base_url_env: "AWS_AMPLIFY_URL", auth: SIGV4("amplify") };
    const line = { api: "amplify", parent: { path: "/apps/d1demo/branches/pr-42", method: "POST", send: "collection", body_list_path: "/environmentVariables" }, list_path: "/branch/environmentVariables", shape: "map", item: "API_URL", value: "https://api-pr-42.example.app" };
    const { actx } = run({ AWS_AMPLIFY_URL: `${h.sim.url}/aws/amplify` }, amplify);
    const r = await applyOnce(listItem, actx, line);
    expect(h.sim.state.aws.amplify.d1demo!.branches["pr-42"]!.environmentVariables).toEqual({ EXISTING: "keep-me", API_URL: "https://api-pr-42.example.app" });
    await listItem.destroy(actx, r.resources);
    expect(h.sim.state.aws.amplify.d1demo!.branches["pr-42"]!.environmentVariables).toEqual({ EXISTING: "keep-me" });
  });

  it("refuses a malformed block", () => {
    expect(() => parseAuth({ aws_sigv4: { region: "US East", service: "s3", access_key_id_env: "A", secret_access_key_env: "B_KEY" } }, "w")).toThrow(/lower-case AWS name/);
    expect(() => parseAuth({ aws_sigv4: { region: "us-east-1", service: "s3", access_key_id_env: "A", secret_access_key_env: "AWS_SECRET" } }, "w")).not.toThrow();
    expect(() => parseAuth({ aws_sigv4: { region: "us-east-1", service: "s3", access_key_id_env: "A", secret_access_key_env: "AWS_SECRETS" } }, "w")).toThrow(/must end in TOKEN/);
    expect(() => parseAuth({ aws_sigv4: { region: "us-east-1", service: "s3", access_key_id_env: "A", secret_access_key_env: "B_KEY", role: "x" } }, "w")).toThrow(/unknown key `role`/);
  });
});

// ---------------------------------------------------------------------------
// HTTP Digest (MongoDB Atlas Admin API keys)
// ---------------------------------------------------------------------------

describe("auth: digest", () => {
  const ATLAS = { base_url: "https://cloud.mongodb.com/api/atlas/v2", base_url_env: "REST_API_URL", media_type: "application/vnd.atlas.2023-01-01+json", auth: { digest: { user_env: "ATLAS_PUBLIC_KEY", password_env: "ATLAS_PRIVATE_KEY" } } };
  const USER = { api: "atlas", find: { path: "/groups/g1/databaseUsers", list_path: "/data", match: { username: "pr-42-app" } }, create: { path: "/groups/g1/databaseUsers" }, delete: { path: "/groups/g1/databaseUsers/{id}" }, item_path: "/data", fields: { databaseName: "admin" } };
  const seed = (algorithm: "MD5" | "SHA-256"): Partial<SimSeed> => ({ rest: { collections: { "/groups/g1/databaseUsers": [] }, auth: { digest: { users: { "atlas-public": "atlas-private-key-0042" }, algorithm } } } });

  it.each(["MD5", "SHA-256"] as const)("answers the %s challenge, then reuses it with the next nonce count", async (algorithm) => {
    await start(seed(algorithm));
    const { actx } = run({ ATLAS_PUBLIC_KEY: "atlas-public", ATLAS_PRIVATE_KEY: "atlas-private-key-0042" }, ATLAS);
    const r = await applyOnce(resource, actx, USER);
    expect(r.created).toEqual(["/groups/g1/databaseUsers[username=pr-42-app]"]);
    expect(await resource.read(actx, USER)).not.toBeNull();
    await resource.destroy(actx, r.resources);
    expect(h.sim.state.rest.collections["/groups/g1/databaseUsers"]).toEqual([]);
    // One challenge for the whole run: every later request answered it up front.
    expect(h.sim.state.rest.auth!.refused).toBe(1);
  });

  it("a wrong password is PROVIDER_AUTH, and the password never appears in the error", async () => {
    await start(seed("MD5"));
    const r = await failure(resource.read(run({ ATLAS_PUBLIC_KEY: "atlas-public", ATLAS_PRIVATE_KEY: "wrong-private-key-7777" }, ATLAS).actx, USER));
    expect(r.code).toBe("PROVIDER_AUTH");
    expect(r.message).not.toContain("wrong-private-key-7777");
    expect(h.sim.state.rest.auth!.refused).toBe(2);
  });

  it("a server that offers no usable challenge is PROVIDER_AUTH saying why", async () => {
    await start({ rest: { collections: { "/groups/g1/databaseUsers": [] }, auth: { tokens: ["x-token"] } } });
    const r = await failure(resource.read(run({ ATLAS_PUBLIC_KEY: "atlas-public", ATLAS_PRIVATE_KEY: "atlas-private-key-0042" }, ATLAS).actx, USER));
    expect(r).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringContaining("no WWW-Authenticate challenge") });
  });
});

describe("auth: the provider block", () => {
  it("each form is checked; credentials are variable names the engine masks", () => {
    const w = "providers.http.x.auth";
    expect(() => parseAuth({ bearer_env: "A_TOKEN", digest: {} }, w)).toThrow(/unknown key `bearer_env` next to `digest`/);
    expect(() => parseAuth({ digest: { user_env: "U", password_env: "P_KEY" }, command: ["x"] }, w)).toThrow(/choose one/);
    expect(() => parseAuth({ digest: { user_env: "U", password_env: "P" } }, w)).toThrow(/must end in TOKEN/);
    expect(() => parseAuth({ digest: "u:p" }, w)).toThrow(/must be a map/);
    const oauth = { token_url: "https://t/oauth/token", client_id_env: "ID", client_secret_env: "SECRET" };
    expect(parseAuth({ oauth2_client_credentials: oauth }, w)).toMatchObject({ kind: "oauth2", method: "client_secret_post", extra: {} });
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, token_url: "t/oauth" } }, w)).toThrow(/http\(s\) URL/);
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, client_secret_env: "CLIENT" } }, w)).toThrow(/must end in TOKEN/);
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, auth_method: "private_key_jwt" } }, w)).toThrow(/not supported/);
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, extra: { client_secret: "x" } } }, w)).toThrow(/set by Sponson/);
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, extra: { a: 1 } } }, w)).toThrow(/map of parameter name to string/);
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, scope: "" } }, w)).toThrow(/non-empty string/);
    expect(() => parseAuth({ oauth2_client_credentials: { ...oauth, client_secret: "x" } }, w)).toThrow(/unknown key `client_secret`/);
  });
});

// ---------------------------------------------------------------------------
// Header credentials: a scheme prefix (Flagsmith), several headers (Datadog)
// ---------------------------------------------------------------------------

describe("auth: header with a prefix, and several headers", () => {
  const FLAG = { api: "x", find: { path: "/flags", list_path: "/data", match: { name: "checkout" } }, create: { path: "/flags" }, delete: { path: "/flags/{id}" }, item_path: "/data", fields: { enabled: true } };

  it("a prefix is sent before the credential (`Authorization: Api-Key <key>`) and the server accepts exactly that", async () => {
    await start({ rest: { collections: { "/flags": [] }, auth: { headers: [{ authorization: "Api-Key fs-server-key-0042" }] } } });
    const block = { base_url: "https://api.flagsmith.com/api/v1", base_url_env: "REST_API_URL", auth: { header: "Authorization", value_env: "FLAGSMITH_API_KEY", prefix: "Api-Key " } };
    const { actx } = run({ FLAGSMITH_API_KEY: "fs-server-key-0042" }, block);
    expect((await applyOnce(resource, actx, FLAG)).created).toHaveLength(1);
    // Without the prefix (or with another one) the same key is refused.
    const bare = { ...block, auth: { header: "Authorization", value_env: "FLAGSMITH_API_KEY" } };
    expect(await failure(resource.read(run({ FLAGSMITH_API_KEY: "fs-server-key-0042" }, bare).actx, FLAG))).toMatchObject({ code: "PROVIDER_AUTH" });
    const token = { ...block, auth: { ...block.auth, prefix: "Token " } };
    expect(await failure(resource.read(run({ FLAGSMITH_API_KEY: "fs-server-key-0042" }, token).actx, FLAG))).toMatchObject({ code: "PROVIDER_AUTH" });
  });

  it("several credential headers are all sent; the server needs every one", async () => {
    await start({ rest: { collections: { "/flags": [] }, auth: { headers: [{ "dd-api-key": "dd-api-key-0042", "dd-application-key": "dd-app-key-0042" }] } } });
    const block = { base_url: "https://api.datadoghq.com/api/v1", base_url_env: "REST_API_URL", auth: { headers: [{ header: "DD-API-KEY", value_env: "DATADOG_API_KEY" }, { header: "DD-APPLICATION-KEY", value_env: "DATADOG_APP_KEY" }] } };
    const { actx } = run({ DATADOG_API_KEY: "dd-api-key-0042", DATADOG_APP_KEY: "dd-app-key-0042" }, block);
    expect((await applyOnce(resource, actx, FLAG)).created).toHaveLength(1);
    const unset = await failure(resource.read(run({ DATADOG_API_KEY: "dd-api-key-0042", DATADOG_APP_KEY: "" }, block).actx, FLAG));
    expect(unset).toMatchObject({ code: "PROVIDER_AUTH", message: expect.stringContaining("DATADOG_APP_KEY is not set") });
    const wrong = await failure(resource.read(run({ DATADOG_API_KEY: "dd-api-key-0042", DATADOG_APP_KEY: "wrong-app-key-9999" }, block).actx, FLAG));
    expect(wrong.code).toBe("PROVIDER_AUTH");
    expect(wrong.message).not.toContain("wrong-app-key-9999");
  });

  it("refuses a prefix that is not literal text, and a header list that is malformed", () => {
    const w = "providers.http.x.auth";
    const header = { header: "Authorization", value_env: "FLAGSMITH_API_KEY" };
    expect(parseAuth({ ...header, prefix: "Token " }, w)).toEqual({ kind: "header", header: "Authorization", env: "FLAGSMITH_API_KEY", prefix: "Token " });
    for (const prefix of [{ from: "x.y" }, "", "${ctx.scope} ", "$KEY ", "Api-Key\n", "x".repeat(65)]) expect(() => parseAuth({ ...header, prefix }, w), JSON.stringify(prefix)).toThrow(/prefix/);
    expect(() => parseAuth({ ...header, value: "x" }, w)).toThrow(/unknown key `value`/);
    expect(() => parseAuth({ bearer_env: "A_TOKEN", prefix: "x" }, w)).toThrow(/unknown key `prefix`/);
    expect(() => parseAuth({ header: "Content-Type", value_env: "A_KEY" }, w)).toThrow(/set by Sponson/);
    expect(() => parseAuth({ headers: [] }, w)).toThrow(/list of/);
    expect(() => parseAuth({ headers: ["DD-API-KEY"] }, w)).toThrow(/header, value_env/);
    expect(() => parseAuth({ headers: [{ header: "DD-API-KEY", value_env: "DD_KEY" }, { header: "dd-api-key", value_env: "OTHER_KEY" }] }, w)).toThrow(/twice/);
    expect(() => parseAuth({ headers: [{ header: "DD-API-KEY", value_env: "DD_ID" }] }, w)).toThrow(/must end in TOKEN/);
    expect(() => parseAuth({ headers: [{ header: "DD-API-KEY", value_env: "DD_KEY" }], bearer_env: "X_TOKEN" }, w)).toThrow(/unknown key/);
  });
});
