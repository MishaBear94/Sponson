import { describe, expect, it, vi } from "vitest";
import { awsSecretsManagerSource, dopplerSecretSource, envSecretSource, gcpSecretManagerSource, opSecretSource, type Exec } from "./secrets.js";

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

describe("CLI-backed sources share one message shape", () => {
  const sources = [
    ["doppler", dopplerSecretSource(), "doppler://p/c/K"],
    ["op", opSecretSource(), "op://v/i/f"],
    ["aws", awsSecretsManagerSource(), "aws-sm://prod/app#K"],
    ["gcloud", gcpSecretManagerSource(), "gcp-sm://my-proj/K"],
  ] as const;

  it.each(sources)("a missing `%s` binary says so, without repeating the ref or leaking ENOENT", async (bin, src, ref) => {
    const err = await src.resolve(ref, { PATH: "/sponson-test-no-such-dir" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toMatchObject({ code: "SECRET_UNRESOLVED", message: `the \`${bin}\` CLI is not installed or not on PATH`, details: { ref } });
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
