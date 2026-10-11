import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awsSecretsManagerSource,
  azureKeyVaultSource,
  bitwardenSecretsManagerSource,
  dopplerSecretSource,
  envSecretSource,
  gcpSecretManagerSource,
  infisicalSecretSource,
  opConnectSecretSource,
  opSecretSource,
  vaultSecretSource,
  type Exec,
} from "./secrets.js";

const BWS_UUID = "be8e0ad8-d545-4017-a55a-b02f014d4158";
/** The built-in sources that call an HTTP API instead of a CLI; each has its own describe below. */
const HTTP_BACKED: string[] = ["vault", "op-connect"];

/** A recorded request and the reply a test chose for it. */
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}
type Route = (seen: Seen) => { status: number; body: unknown } | undefined;

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A local HTTP server answering from `route` (404 when it returns nothing); returns its base URL and the requests it saw. */
async function serve(route: Route): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers };
    seen.push(s);
    const reply = route(s) ?? { status: 404, body: { errors: [] } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The rejection of a promise that must reject. */
async function rejection(p: Promise<unknown>): Promise<Error & { code?: string; details?: Record<string, unknown> }> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: Error) => e,
  );
}

/** No retries and a short timeout: unit tests must not wait for the HTTP client's backoff. */
const FAST = { SPONSON_HTTP_RETRIES: "0", SPONSON_HTTP_TIMEOUT_MS: "2000" };

describe("env secret source", () => {
  it("resolves from the environment", async () => {
    expect(await envSecretSource.resolve("env://STRIPE_KEY", { STRIPE_KEY: "fake_ts_123" })).toBe("fake_ts_123");
    expect(envSecretSource).not.toHaveProperty("fingerprint");
  });

  it("a missing variable is SECRET_UNRESOLVED naming it", async () => {
    await expect(envSecretSource.resolve("env://NOPE", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/NOPE/), details: { ref: "env://NOPE", variable: "NOPE" } });
    await expect(envSecretSource.resolve("doppler://a/b/c", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/env:\/\//) });
  });
});

describe("doppler secret source", () => {
  it("shells out with project/config/name, passes the env through, and strips one trailing LF or CRLF", async () => {
    const exec = vi.fn<Exec>(async () => "value\n");
    const src = dopplerSecretSource(exec);
    const env = { DOPPLER_TOKEN: "dp.st.x" };
    expect(await src.resolve("doppler://proj/cfg/KEY", env)).toBe("value");
    expect(exec).toHaveBeenCalledWith("doppler", ["secrets", "get", "KEY", "--project", "proj", "--config", "cfg", "--plain"], env);
    expect(await dopplerSecretSource(async () => "value\r\n").resolve("doppler://proj/cfg/KEY", env)).toBe("value");
    expect(await dopplerSecretSource(async () => "line1\nline2\n").resolve("doppler://proj/cfg/KEY", env)).toBe("line1\nline2");
  });

  it("rejects malformed references before running anything", async () => {
    const exec = vi.fn<Exec>(async () => "x");
    await expect(dopplerSecretSource(exec).resolve("doppler://proj/KEY", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/project\/config\/NAME/) });
    expect(exec).not.toHaveBeenCalled();
  });

  it("a CLI failure is SECRET_UNRESOLVED naming the reference", async () => {
    const src = dopplerSecretSource(async () => {
      throw new Error("doppler secrets failed: Could not find requested secret");
    });
    await expect(src.resolve("doppler://p/c/K", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: "doppler secrets failed: Could not find requested secret", details: { ref: "doppler://p/c/K" } });
  });
});

describe("op secret source", () => {
  it("passes the reference to `op read`", async () => {
    const exec = vi.fn<Exec>(async () => "s3cret");
    const src = opSecretSource(exec);
    expect(await src.resolve("op://vault/item/field", {})).toBe("s3cret");
    expect(exec).toHaveBeenCalledWith("op", ["read", "op://vault/item/field", "--no-newline"], {});
    expect(await opSecretSource(async () => "s3cret\r\n").resolve("op://vault/item/field", {})).toBe("s3cret");
  });

  it("surfaces CLI failures as SECRET_UNRESOLVED", async () => {
    const src = opSecretSource(async () => {
      throw new Error("op read failed: not signed in");
    });
    await expect(src.resolve("op://v/i/f", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/not signed in/) });
  });
});

describe("aws-sm secret source", () => {
  const ARGS = (id: string) => ["secretsmanager", "get-secret-value", "--secret-id", id, "--query", "SecretString", "--output", "json"];

  it("asks the aws CLI for the SecretString as JSON and passes the env through", async () => {
    const exec = vi.fn<Exec>(async () => '"s3cret\\nline2"\n');
    const env = { AWS_REGION: "eu-west-1", AWS_PROFILE: "ci" };
    expect(await awsSecretsManagerSource(exec).resolve("aws-sm://prod/stripe", env)).toBe("s3cret\nline2");
    expect(exec).toHaveBeenCalledWith("aws", ARGS("prod/stripe"), env);
  });

  it("accepts an ARN as the secret id", async () => {
    const exec = vi.fn<Exec>(async () => '"v"');
    const arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/stripe-AbCdEf";
    expect(await awsSecretsManagerSource(exec).resolve(`aws-sm://${arn}`, {})).toBe("v");
    expect(exec).toHaveBeenCalledWith("aws", ARGS(arn), {});
  });

  it("#key picks one key of a JSON secret; numbers and booleans become strings", async () => {
    const secret = JSON.stringify(JSON.stringify({ STRIPE_KEY: "fake_ts_abc", PORT: 5432, TLS: true }));
    const src = awsSecretsManagerSource(async () => secret);
    expect(await src.resolve("aws-sm://prod/app#STRIPE_KEY", {})).toBe("fake_ts_abc");
    expect(await src.resolve("aws-sm://prod/app#PORT", {})).toBe("5432");
    expect(await src.resolve("aws-sm://prod/app#TLS", {})).toBe("true");
  });

  it("a missing key, a non-object secret or a nested value is SECRET_UNRESOLVED, and the message never contains the value", async () => {
    const nested = awsSecretsManagerSource(async () => JSON.stringify(JSON.stringify({ A: "fake_ts_top", N: { deep: "fake_ts_nested" } })));
    const plain = awsSecretsManagerSource(async () => JSON.stringify("fake_ts_plain_not_json"));
    for (const [src, ref, why] of [
      [nested, "aws-sm://app#B", /no key B/],
      [nested, "aws-sm://app#N", /key N is not a string/],
      [plain, "aws-sm://app#A", /needs a JSON object secret/],
    ] as const) {
      const err = await src.resolve(ref, {}).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(why), details: { ref } });
      expect(err!.message).not.toMatch(/fake_ts_/);
    }
  });

  it("a binary secret (SecretString null) is SECRET_UNRESOLVED, not the word None", async () => {
    await expect(awsSecretsManagerSource(async () => "null\n").resolve("aws-sm://bin", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/binary/) });
  });

  it("rejects malformed references before running anything", async () => {
    const exec = vi.fn<Exec>(async () => '"x"');
    for (const ref of ["aws-sm://", "aws-sm://#KEY", "aws-sm://app#"]) {
      await expect(awsSecretsManagerSource(exec).resolve(ref, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/aws-sm:\/\/<secret-id>/) });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("a CLI failure (not signed in, unknown secret) is SECRET_UNRESOLVED naming the reference", async () => {
    const src = awsSecretsManagerSource(async () => {
      throw new Error("aws secretsmanager failed: An error occurred (ResourceNotFoundException)");
    });
    await expect(src.resolve("aws-sm://nope", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: "aws secretsmanager failed: An error occurred (ResourceNotFoundException)", details: { ref: "aws-sm://nope" } });
  });
});

describe("gcp-sm secret source", () => {
  const ARGS = (version: string, secret: string, project: string) => ["secrets", "versions", "access", version, `--secret=${secret}`, `--project=${project}`, "--format=json"];
  /** What `gcloud secrets versions access --format=json` prints: the payload base64-encoded (URL-safe alphabet). */
  const response = (value: string | Buffer) =>
    `${JSON.stringify({ name: "projects/123/secrets/s/versions/4", payload: { data: Buffer.from(value).toString("base64url"), dataCrc32c: "1" } }, null, 2)}\n`;

  it("asks gcloud for the latest version as JSON, decodes the payload exactly, and passes the env through", async () => {
    const exec = vi.fn<Exec>(async () => response("s3cret\nline2\n"));
    const env = { CLOUDSDK_CONFIG: "/tmp/gcloud" };
    // The trailing newline is part of the secret: the JSON form keeps it, where raw output could not tell.
    expect(await gcpSecretManagerSource(exec).resolve("gcp-sm://my-proj/stripe-key", env)).toBe("s3cret\nline2\n");
    expect(exec).toHaveBeenCalledWith("gcloud", ARGS("latest", "stripe-key", "my-proj"), env);
  });

  it("accepts an explicit version and a domain-scoped project, and decodes the URL-safe base64 alphabet", async () => {
    const exec = vi.fn<Exec>(async () => response("fake_ts_??>>~~"));
    expect(await gcpSecretManagerSource(exec).resolve("gcp-sm://example.com:proj/STRIPE_KEY/7", {})).toBe("fake_ts_??>>~~");
    expect(exec).toHaveBeenCalledWith("gcloud", ARGS("7", "STRIPE_KEY", "example.com:proj"), {});
  });

  it("a binary, empty or missing payload is SECRET_UNRESOLVED, and the message never contains the value", async () => {
    for (const [out, why] of [
      [response(Buffer.from([0x66, 0x61, 0x6b, 0x65, 0xff, 0xfe])), /not UTF-8/],
      [response(""), /empty/],
      ['{"name":"projects/1/secrets/s/versions/1"}', /no payload/],
      ["not json fake_ts_garbage", /no payload/],
    ] as const) {
      const err = await gcpSecretManagerSource(async () => out).resolve("gcp-sm://p1/s", {}).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(why), details: { ref: "gcp-sm://p1/s" } });
      expect(err!.message).not.toMatch(/fake/);
    }
  });

  it("rejects malformed references before running anything, including segments gcloud would read as flags", async () => {
    const exec = vi.fn<Exec>(async () => response("x"));
    for (const ref of ["gcp-sm://", "gcp-sm://only-secret", "gcp-sm://p//", "gcp-sm://p/s/v/extra", "gcp-sm://-p/s", "gcp-sm://p/--impersonate-service-account=x", "gcp-sm://p/s/0", "gcp-sm://p/s/latest-1"]) {
      await expect(gcpSecretManagerSource(exec).resolve(ref, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/gcp-sm:\/\/<project>\/<secret>/) });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("a CLI failure (not authenticated, unknown secret) is SECRET_UNRESOLVED naming the reference", async () => {
    const src = gcpSecretManagerSource(async () => {
      throw new Error("gcloud secrets failed: ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [projects/1/secrets/nope] not found");
    });
    await expect(src.resolve("gcp-sm://p1/nope", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/NOT_FOUND/), details: { ref: "gcp-sm://p1/nope" } });
  });
});

describe("infisical secret source", () => {
  const ARGS = (name: string, project: string, env: string, path: string) => ["secrets", "get", name, "--projectId", project, "--env", env, "--path", path, "--output", "json", "--silent"];
  /** What `infisical secrets get NAME --output json` prints. */
  const answer = (name: string, value: string) => `${JSON.stringify([{ secretKey: name, secretValue: value }])}\n`;

  it("asks for one name in the project, environment and folder as JSON, and passes the env through", async () => {
    const exec = vi.fn<Exec>(async () => answer("STRIPE_KEY", "fake_ts_inf\nline2\n"));
    const env = { INFISICAL_TOKEN: "st.x" };
    expect(await infisicalSecretSource(exec).resolve("infisical://6f1c-proj/prod/STRIPE_KEY", env)).toBe("fake_ts_inf\nline2\n");
    expect(exec).toHaveBeenCalledWith("infisical", ARGS("STRIPE_KEY", "6f1c-proj", "prod", "/"), env);
  });

  it("folders between the environment and the name become --path", async () => {
    const exec = vi.fn<Exec>(async () => answer("DB_URL", "v"));
    expect(await infisicalSecretSource(exec).resolve("infisical://p/staging/backend/payments/DB_URL", {})).toBe("v");
    expect(exec).toHaveBeenCalledWith("infisical", ARGS("DB_URL", "p", "staging", "/backend/payments"), {});
  });

  it("an unknown name (the CLI prints `*not found*` and exits 0) is SECRET_UNRESOLVED, never a value", async () => {
    for (const out of [answer("NOPE", "*not found*"), "[]", "null", "[{\"secretKey\":\"OTHER\",\"secretValue\":\"fake_ts_other\"}]"]) {
      const err = await rejection(infisicalSecretSource(async () => out).resolve("infisical://p/dev/NOPE", {}));
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: "no secret NOPE in environment dev at /", details: { ref: "infisical://p/dev/NOPE" } });
    }
  });

  it("output that is not the expected JSON is SECRET_UNRESOLVED without echoing it", async () => {
    const err = await rejection(infisicalSecretSource(async () => '[{"secretKey":"K","secretValue":42}] fake_ts_garbage').resolve("infisical://p/dev/K", {}));
    expect(err).toMatchObject({ code: "SECRET_UNRESOLVED" });
    expect(err.message).not.toMatch(/fake_ts_/);
  });

  it("rejects malformed references before running anything", async () => {
    const exec = vi.fn<Exec>(async () => "[]");
    for (const ref of ["infisical://", "infisical://p/dev", "infisical://p//K", "infisical://p/dev/K/", "infisical:///dev/K"]) {
      await expect(infisicalSecretSource(exec).resolve(ref, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/^expected infisical:\/\/<projectId>/) });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("a CLI failure (not logged in, unknown project) is SECRET_UNRESOLVED carrying the CLI's text", async () => {
    const src = infisicalSecretSource(async () => {
      throw new Error("infisical secrets failed: error: To fetch all secrets: CallGetRawSecretsV3: Unsuccessful response [GET https://app.infisical.com/api/v3/secrets/raw] [status-code=403]");
    });
    await expect(src.resolve("infisical://p/dev/K", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/status-code=403/), details: { ref: "infisical://p/dev/K" } });
  });
});

describe("azure-kv secret source", () => {
  const VERSION = "4387e9f3d6e14c459867679a90fd0f79";
  const ARGS = (vault: string, name: string, version?: string) => ["keyvault", "secret", "show", "--vault-name", vault, "--name", name, ...(version ? ["--version", version] : []), "--query", "value", "--output", "json"];

  it("asks az for the latest value as JSON, keeps a trailing newline, and passes the env through", async () => {
    const exec = vi.fn<Exec>(async () => '"fake_ts_azkv\\n"\n');
    const env = { AZURE_CONFIG_DIR: "/tmp/az" };
    expect(await azureKeyVaultSource(exec).resolve("azure-kv://shop-prod-kv/stripe-key", env)).toBe("fake_ts_azkv\n");
    expect(exec).toHaveBeenCalledWith("az", ARGS("shop-prod-kv", "stripe-key"), env);
  });

  it("a version pins it", async () => {
    const exec = vi.fn<Exec>(async () => '"v"');
    expect(await azureKeyVaultSource(exec).resolve(`azure-kv://shop-prod-kv/stripe-key/${VERSION}`, {})).toBe("v");
    expect(exec).toHaveBeenCalledWith("az", ARGS("shop-prod-kv", "stripe-key", VERSION), {});
  });

  it("a null or unparseable answer is SECRET_UNRESOLVED without echoing it", async () => {
    for (const out of ["null", "fake_ts_not_json"]) {
      const err = await rejection(azureKeyVaultSource(async () => out).resolve("azure-kv://kv1/k", {}));
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: "the secret has no value" });
    }
  });

  it("rejects references Key Vault's naming rules forbid before running anything", async () => {
    const exec = vi.fn<Exec>(async () => '"x"');
    for (const ref of ["azure-kv://", "azure-kv://kv", "azure-kv://kv/name", "azure-kv://my--vault/name", "azure-kv://a-vault-name-longer-than-24/n", "azure-kv://kv1/under_score", "azure-kv://kv1/n/notaversion", `azure-kv://kv1/n/${VERSION}/x`]) {
      await expect(azureKeyVaultSource(exec).resolve(ref, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/^expected azure-kv:\/\/<vault>\/<name>/) });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("a CLI failure (not logged in, SecretNotFound) is SECRET_UNRESOLVED carrying the CLI's text", async () => {
    const src = azureKeyVaultSource(async () => {
      throw new Error("az keyvault failed: ERROR: (SecretNotFound) A secret with (name/id) nope was not found in this key vault.");
    });
    await expect(src.resolve("azure-kv://kv1/nope", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/SecretNotFound/), details: { ref: "azure-kv://kv1/nope" } });
  });
});

describe("bws secret source", () => {
  /** What `bws secret get <id> --output json` prints (pretty-printed, one trailing newline). */
  const answer = (value: string) =>
    `${JSON.stringify({ object: "secret", id: BWS_UUID, organizationId: "10e8d5b6-1c63-4f4a-b0d5-b02f014d4158", projectId: null, key: "STRIPE_KEY", value, note: "", creationDate: "2026-01-01T00:00:00Z", revisionDate: "2026-01-01T00:00:00Z" }, null, 2)}\n`;

  it("asks bws for the secret as uncoloured JSON and passes the env through", async () => {
    const exec = vi.fn<Exec>(async () => answer("fake_ts_bws\n"));
    const env = { BWS_ACCESS_TOKEN: "0.x" };
    expect(await bitwardenSecretsManagerSource(exec).resolve(`bws://${BWS_UUID}`, env)).toBe("fake_ts_bws\n");
    expect(exec).toHaveBeenCalledWith("bws", ["secret", "get", BWS_UUID, "--output", "json", "--color", "no"], env);
  });

  it("an answer without a string value is SECRET_UNRESOLVED without echoing it", async () => {
    for (const out of ['{"object":"secret","key":"K"}', "fake_ts_not_json"]) {
      const err = await rejection(bitwardenSecretsManagerSource(async () => out).resolve(`bws://${BWS_UUID}`, {}));
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: "the Bitwarden CLI returned no value" });
    }
  });

  it("rejects anything but a UUID before running anything", async () => {
    const exec = vi.fn<Exec>(async () => answer("x"));
    for (const ref of ["bws://", "bws://STRIPE_KEY", `bws://${BWS_UUID}/x`, `bws://${BWS_UUID.slice(1)}`]) {
      await expect(bitwardenSecretsManagerSource(exec).resolve(ref, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/^expected bws:\/\/<secret-id>/) });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("a CLI failure (bad token, unknown id) is SECRET_UNRESOLVED carrying the CLI's text", async () => {
    const src = bitwardenSecretsManagerSource(async () => {
      throw new Error("bws secret failed: Error: Resource not found");
    });
    await expect(src.resolve(`bws://${BWS_UUID}`, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/Resource not found/), details: { ref: `bws://${BWS_UUID}` } });
  });
});

describe("vault secret source", () => {
  const TOKEN = "hvs.fake_vault_token_123";
  const kv = (data: Record<string, unknown> | null) => ({ request_id: "r", data: { data, metadata: { version: 3, destroyed: false, deletion_time: "" } } });

  it("reads the latest version of a KV v2 secret with X-Vault-Token and returns one key; numbers and booleans become strings", async () => {
    const { url, seen } = await serve((s) => (s.url === "/v1/secret/data/shop/stripe" ? { status: 200, body: kv({ STRIPE_KEY: "fake_ts_vault\n", PORT: 5432, TLS: true }) } : undefined));
    const env = { ...FAST, VAULT_ADDR: `${url}/`, VAULT_TOKEN: TOKEN };
    expect(await vaultSecretSource.resolve("vault://secret/shop/stripe#STRIPE_KEY", env)).toBe("fake_ts_vault\n");
    expect(await vaultSecretSource.resolve("vault://secret/shop/stripe#PORT", env)).toBe("5432");
    expect(await vaultSecretSource.resolve("vault://secret/shop/stripe#TLS", env)).toBe("true");
    expect(seen[0]).toMatchObject({ method: "GET", headers: { "x-vault-token": TOKEN } });
    expect(seen[0]!.headers["x-vault-namespace"]).toBeUndefined();
  });

  it("sends VAULT_NAMESPACE as X-Vault-Namespace and encodes each path segment", async () => {
    const { url, seen } = await serve(() => ({ status: 200, body: kv({ k: "v" }) }));
    expect(await vaultSecretSource.resolve("vault://kv/team a/app?x#k", { ...FAST, VAULT_ADDR: url, VAULT_TOKEN: TOKEN, VAULT_NAMESPACE: "admin" })).toBe("v");
    expect(seen[0]).toMatchObject({ url: "/v1/kv/data/team%20a/app%3Fx", headers: { "x-vault-namespace": "admin" } });
  });

  it("a missing path (404), a missing key or a deleted version is SECRET_UNRESOLVED, and the message never contains a value", async () => {
    const { url } = await serve((s) => {
      if (s.url === "/v1/secret/data/app") return { status: 200, body: kv({ A: "fake_ts_top", N: { deep: "fake_ts_nested" } }) };
      if (s.url === "/v1/secret/data/gone") return { status: 200, body: kv(null) };
      return undefined;
    });
    const env = { ...FAST, VAULT_ADDR: url, VAULT_TOKEN: TOKEN };
    for (const [ref, why] of [
      ["vault://secret/nope#A", /^no secret at secret\/nope/],
      ["vault://secret/app#B", /^secret\/app has no key B$/],
      ["vault://secret/app#N", /key N of secret\/app is not a string/],
      ["vault://secret/gone#A", /deleted or destroyed/],
    ] as const) {
      const err = await rejection(vaultSecretSource.resolve(ref, env));
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(why), details: { ref } });
      expect(err.message).not.toMatch(/fake_/);
    }
  });

  it("a refused token is SECRET_UNRESOLVED carrying Vault's error, with the token masked", async () => {
    const { url } = await serve(() => ({ status: 403, body: { errors: [`permission denied for ${TOKEN}`] } }));
    const err = await rejection(vaultSecretSource.resolve("vault://secret/app#A", { ...FAST, VAULT_ADDR: url, VAULT_TOKEN: TOKEN }));
    expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/403.*permission denied/), details: { status: 403 } });
    expect(err.message).not.toContain(TOKEN);
  });

  it("an answer that is not JSON is reported without its text", async () => {
    const { url } = await serve(() => ({ status: 200, body: "fake_ts_raw_body" }));
    const err = await rejection(vaultSecretSource.resolve("vault://secret/app#A", { ...FAST, VAULT_ADDR: url, VAULT_TOKEN: TOKEN }));
    expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/not JSON/) });
    expect(err.message).not.toMatch(/fake_ts_/);
  });

  it("Vault unreachable, sealed (503) or unconfigured is SECRET_UNRESOLVED", async () => {
    const { url } = await serve(() => ({ status: 503, body: { errors: ["Vault is sealed"] } }));
    await expect(vaultSecretSource.resolve("vault://secret/app#A", { ...FAST, VAULT_ADDR: url, VAULT_TOKEN: TOKEN })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/503.*sealed/) });
    await expect(vaultSecretSource.resolve("vault://secret/app#A", { ...FAST, VAULT_ADDR: "http://127.0.0.1:1", VAULT_TOKEN: TOKEN })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/ECONNREFUSED|temporarily unavailable/) });
    await expect(vaultSecretSource.resolve("vault://secret/app#A", { VAULT_TOKEN: TOKEN })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: "VAULT_ADDR is not set", details: { variable: "VAULT_ADDR" } });
    await expect(vaultSecretSource.resolve("vault://secret/app#A", { VAULT_ADDR: "vault.internal:8200", VAULT_TOKEN: TOKEN })).rejects.toMatchObject({ message: "VAULT_ADDR is not an http(s) URL" });
    await expect(vaultSecretSource.resolve("vault://secret/app#A", { VAULT_ADDR: "http://127.0.0.1:1" })).rejects.toMatchObject({ message: "VAULT_TOKEN is not set" });
  });

  it("rejects malformed references, including ones that would climb out of the mount, before sending anything", async () => {
    for (const ref of ["vault://", "vault://secret#k", "vault://secret/app", "vault://secret/app#", "vault://secret//app#k", "vault://secret/../sys/raw#k", "vault://secret/./app#k"]) {
      await expect(vaultSecretSource.resolve(ref, { VAULT_ADDR: "http://127.0.0.1:1", VAULT_TOKEN: TOKEN })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: "expected vault://<mount>/<path>#<key>" });
    }
  });
});

describe("op-connect secret source", () => {
  const TOKEN = "eyJ_fake_connect_token";
  const VAULT = "ytrfte14kw1uex5txaore1emkz";
  const ITEM = "wepiqdxdzncjtnvmv5fegud4qy";
  const item = {
    id: ITEM,
    title: "Stripe",
    vault: { id: VAULT },
    sections: [
      { id: "95cdbc3b-7742-47ec-9056-44d6af82d562", label: "test" },
      { id: "c9f6a1a6-1a2b-4c3d-8e9f-0a1b2c3d4e5f", label: "live" },
    ],
    fields: [
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "fake_ts_opc_main" },
      { id: "k1", type: "CONCEALED", label: "secret key", value: "fake_ts_opc_test", section: { id: "95cdbc3b-7742-47ec-9056-44d6af82d562" } },
      { id: "k2", type: "CONCEALED", label: "secret key", value: "fake_ts_opc_live", section: { id: "c9f6a1a6-1a2b-4c3d-8e9f-0a1b2c3d4e5f" } },
      { id: "empty", type: "STRING", label: "notes" },
    ],
  };
  const route: Route = (s) => {
    const u = new URL(s.url, "http://x");
    if (u.pathname === "/v1/vaults") return { status: 200, body: [{ id: VAULT, name: "Shop CI" }, { id: "aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Shop CI old" }] };
    if (u.pathname === `/v1/vaults/${VAULT}/items`) return { status: 200, body: [{ id: ITEM, title: "Stripe" }, { id: "b1", title: "Dup" }, { id: "b2", title: "Dup" }] };
    if (u.pathname === `/v1/vaults/${VAULT}/items/${ITEM}`) return { status: 200, body: item };
    return undefined;
  };

  it("reads a field by id or label with a bearer token, vault and item named by id", async () => {
    const { url, seen } = await serve(route);
    const env = { ...FAST, OP_CONNECT_HOST: url, OP_CONNECT_TOKEN: TOKEN };
    expect(await opConnectSecretSource.resolve(`op-connect://${VAULT}/${ITEM}/password`, env)).toBe("fake_ts_opc_main");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: `/v1/vaults/${VAULT}/items/${ITEM}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await opConnectSecretSource.resolve(`op-connect://${VAULT}/${ITEM}/k2`, env)).toBe("fake_ts_opc_live");
  });

  it("looks a vault and an item up by name with a filter, and a section by label disambiguates a field", async () => {
    const { url, seen } = await serve(route);
    const env = { ...FAST, OP_CONNECT_HOST: url, OP_CONNECT_TOKEN: TOKEN };
    expect(await opConnectSecretSource.resolve("op-connect://Shop CI/Stripe/test/secret key", env)).toBe("fake_ts_opc_test");
    expect(decodeURIComponent(seen[0]!.url)).toBe('/v1/vaults?filter=name eq "Shop CI"');
    expect(decodeURIComponent(seen[1]!.url)).toBe(`/v1/vaults/${VAULT}/items?filter=title eq "Stripe"`);
  });

  it("an unknown or ambiguous vault, item, section or field, or an empty one, is SECRET_UNRESOLVED, and the message never contains a value", async () => {
    const { url } = await serve(route);
    const env = { ...FAST, OP_CONNECT_HOST: url, OP_CONNECT_TOKEN: TOKEN };
    for (const [ref, why] of [
      ["op-connect://Nope/Stripe/password", /^no vault named Nope$/],
      ["op-connect://Shop CI/Nope/password", /^no item named Nope$/],
      ["op-connect://Shop CI/Dup/password", /^2 items are named Dup/],
      [`op-connect://${VAULT}/zzzzzzzzzzzzzzzzzzzzzzzzzz/password`, /^no item zzz/],
      [`op-connect://${VAULT}/${ITEM}/nope`, /^the item has no field nope$/],
      [`op-connect://${VAULT}/${ITEM}/secret key`, /^2 fields of the item are labelled secret key/],
      [`op-connect://${VAULT}/${ITEM}/prod/secret key`, /^the item has no section prod$/],
      [`op-connect://${VAULT}/${ITEM}/notes`, /^field notes has no value$/],
    ] as const) {
      const err = await rejection(opConnectSecretSource.resolve(ref, env));
      expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(why), details: { ref } });
      expect(err.message).not.toMatch(/fake_ts_/);
    }
  });

  it("a refused token is SECRET_UNRESOLVED with the token masked; unconfigured or unreachable too", async () => {
    const { url } = await serve(() => ({ status: 401, body: { status: 401, message: `Invalid token ${TOKEN}` } }));
    const err = await rejection(opConnectSecretSource.resolve(`op-connect://${VAULT}/${ITEM}/password`, { ...FAST, OP_CONNECT_HOST: url, OP_CONNECT_TOKEN: TOKEN }));
    expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/401/), details: { status: 401 } });
    expect(err.message).not.toContain(TOKEN);
    await expect(opConnectSecretSource.resolve(`op-connect://${VAULT}/${ITEM}/password`, { OP_CONNECT_TOKEN: TOKEN })).rejects.toMatchObject({ message: "OP_CONNECT_HOST is not set" });
    await expect(opConnectSecretSource.resolve(`op-connect://${VAULT}/${ITEM}/password`, { OP_CONNECT_HOST: "http://127.0.0.1:1" })).rejects.toMatchObject({ message: "OP_CONNECT_TOKEN is not set" });
    await expect(opConnectSecretSource.resolve(`op-connect://${VAULT}/${ITEM}/password`, { ...FAST, OP_CONNECT_HOST: "http://127.0.0.1:1", OP_CONNECT_TOKEN: TOKEN })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/ECONNREFUSED|temporarily unavailable/) });
  });

  it("rejects malformed references before sending anything", async () => {
    for (const ref of ["op-connect://", "op-connect://v/i", "op-connect://v//f", "op-connect://v/i/s/f/x"]) {
      await expect(opConnectSecretSource.resolve(ref, { OP_CONNECT_HOST: "http://127.0.0.1:1", OP_CONNECT_TOKEN: TOKEN })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: expect.stringMatching(/^expected op-connect:\/\/<vault>/) });
    }
  });
});

/** An `Exec` for tests where the CLI must not be started at all. */
const neverRuns = async (): Promise<string> => {
  throw new Error("the CLI must not run");
};

describe("CLI-backed sources share one message shape", () => {
  const sources = [
    ["doppler", dopplerSecretSource(), "doppler://p/c/K"],
    ["op", opSecretSource(), "op://v/i/f"],
    ["aws", awsSecretsManagerSource(), "aws-sm://prod/app#K"],
    ["gcloud", gcpSecretManagerSource(), "gcp-sm://my-proj/K"],
    ["infisical", infisicalSecretSource(), "infisical://proj-1/dev/K"],
    ["az", azureKeyVaultSource(), "azure-kv://my-vault/K"],
    ["bws", bitwardenSecretsManagerSource(), `bws://${BWS_UUID}`],
  ] as const;

  it.each(sources)("a missing `%s` binary says so, without repeating the ref or leaking ENOENT", async (bin, src, ref) => {
    const err = await src.resolve(ref, { PATH: "/sponson-test-no-such-dir" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: `the \`${bin}\` CLI is not installed or not on PATH`, details: { ref } });
  });

  it("covers every built-in source that runs a CLI", async () => {
    const { createRegistry } = await import("./index.js");
    const cliSchemes = createRegistry()
      .secretSchemes()
      .filter((s) => s !== "env" && !HTTP_BACKED.includes(s));
    expect(sources.map(([, src]) => src.scheme).sort(), "add the new source to this table").toEqual(cliSchemes.sort());
  });

  // A reference segment that reads as an option is refused before the CLI runs (`op` passes the whole `op://…`
  // reference as one argument, so it cannot start with "-").
  it.each([
    ["doppler", dopplerSecretSource(neverRuns), "doppler://p/c/--help"],
    ["aws", awsSecretsManagerSource(neverRuns), "aws-sm://--debug"],
    ["gcloud", gcpSecretManagerSource(neverRuns), "gcp-sm://-p/K"],
    ["infisical", infisicalSecretSource(neverRuns), "infisical://proj/dev/--token=x"],
    ["infisical", infisicalSecretSource(neverRuns), "infisical://proj/dev/-folder/K"],
    ["az", azureKeyVaultSource(neverRuns), "azure-kv://my-vault/--debug"],
    ["bws", bitwardenSecretsManagerSource(neverRuns), "bws://--access-token=x"],
  ] as const)("`%s`: a reference segment starting with - never reaches the CLI", async (_bin, src, ref) => {
    await expect(src.resolve(ref, {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", details: { ref }, message: expect.stringMatching(/may not start with "-"|^expected (gcp-sm|azure-kv|bws):/) });
  });

  it("a binary that cannot be executed is named too", async () => {
    const src = opSecretSource(async () => {
      throw Object.assign(new Error("spawn op EACCES"), { code: "EACCES" });
    });
    await expect(src.resolve("op://v/i/f", {})).rejects.toMatchObject({ message: "the `op` CLI on PATH is not executable" });
  });
});

describe("createRegistry", () => {
  it("lists every built-in secret scheme, and each resolves to its own source", async () => {
    const { createRegistry } = await import("./index.js");
    const registry = createRegistry();
    expect(registry.secretSchemes()).toContain("env");
    for (const scheme of registry.secretSchemes()) expect(registry.secretSource(`${scheme}://x`).scheme).toBe(scheme);
  });
});
