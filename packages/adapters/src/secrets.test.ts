import { sha256 } from "@sponson/core";
import { describe, expect, it, vi } from "vitest";
import { dopplerSecretSource, envSecretSource, opSecretSource, type Exec } from "./secrets.js";

describe("env secret source", () => {
  it("resolves and fingerprints without exposing the value", async () => {
    const env = { STRIPE_KEY: "sk_test_123" };
    expect(await envSecretSource.resolve("env://STRIPE_KEY", env)).toBe("sk_test_123");
    const fp = await envSecretSource.fingerprint("env://STRIPE_KEY", env);
    expect(fp).toBe(sha256("sk_test_123").slice(0, 16));
    expect(fp).not.toContain("sk_test");
  });

  it("names the missing variable", async () => {
    await expect(envSecretSource.resolve("env://NOPE", {})).rejects.toThrow(/NOPE/);
    await expect(envSecretSource.resolve("doppler://a/b/c", {})).rejects.toThrow(/env:\/\//);
  });
});

describe("doppler secret source", () => {
  it("shells out with project/config/name and passes the env through", async () => {
    const exec = vi.fn<Exec>(async () => "value\n");
    const src = dopplerSecretSource(exec);
    const env = { DOPPLER_TOKEN: "dp.st.x" };
    expect(await src.resolve("doppler://proj/cfg/KEY", env)).toBe("value");
    expect(exec).toHaveBeenCalledWith("doppler", ["secrets", "get", "KEY", "--project", "proj", "--config", "cfg", "--plain"], env);
    expect(await src.fingerprint("doppler://proj/cfg/KEY", env)).toBe(sha256("value").slice(0, 16));
  });

  it("rejects malformed references before running anything", async () => {
    const exec = vi.fn<Exec>(async () => "x");
    await expect(dopplerSecretSource(exec).resolve("doppler://proj/KEY", {})).rejects.toThrow(/project\/config\/NAME/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("op secret source", () => {
  it("passes the reference to `op read`", async () => {
    const exec = vi.fn<Exec>(async () => "s3cret");
    const src = opSecretSource(exec);
    expect(await src.resolve("op://vault/item/field", {})).toBe("s3cret");
    expect(exec).toHaveBeenCalledWith("op", ["read", "op://vault/item/field", "--no-newline"], {});
  });

  it("surfaces CLI failures", async () => {
    const src = opSecretSource(async () => {
      throw new Error("op read failed: not signed in");
    });
    await expect(src.resolve("op://v/i/f", {})).rejects.toThrow(/not signed in/);
  });
});
