import { describe, expect, it, vi } from "vitest";
import { dopplerSecretSource, envSecretSource, opSecretSource, type Exec } from "./secrets.js";

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
    await expect(src.resolve("doppler://p/c/K", {})).rejects.toMatchObject({ code: "SECRET_UNRESOLVED", message: "secret doppler://p/c/K: doppler secrets failed: Could not find requested secret" });
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
