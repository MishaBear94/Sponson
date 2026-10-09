import { execFile } from "node:child_process";
import { sha256, type SecretSource } from "@sponson/core";

/** Runs a CLI and returns its stdout. Injected in tests so no real `doppler`/`op` is needed. */
export type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

export const defaultExec: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });

function fingerprintOf(value: string): string {
  return sha256(value).slice(0, 16);
}

function stripScheme(ref: string, scheme: string): string {
  const prefix = `${scheme}://`;
  if (!ref.startsWith(prefix)) throw new Error(`secret source ${scheme}: expected ${prefix}…, got ${ref}`);
  return ref.slice(prefix.length);
}

/** `env://NAME` → process environment. Zero configuration; the CI default. */
export const envSecretSource: SecretSource = {
  scheme: "env",
  async resolve(ref, env) {
    const name = stripScheme(ref, "env");
    const v = env[name];
    if (v === undefined || v === "") throw new Error(`secret ${ref}: environment variable ${name} is not set`);
    return v;
  },
  async fingerprint(ref, env) {
    return fingerprintOf(await envSecretSource.resolve(ref, env));
  },
};

/** `doppler://project/config/NAME` → `doppler secrets get`. Uses the CLI's login or DOPPLER_TOKEN from the env. */
export function dopplerSecretSource(exec: Exec = defaultExec): SecretSource {
  const resolve = async (ref: string, env: NodeJS.ProcessEnv): Promise<string> => {
    const parts = stripScheme(ref, "doppler").split("/");
    if (parts.length !== 3 || parts.some((p) => p === "")) throw new Error(`secret ${ref}: expected doppler://project/config/NAME`);
    const [project, config, name] = parts as [string, string, string];
    const out = await exec("doppler", ["secrets", "get", name, "--project", project, "--config", config, "--plain"], env);
    return out.replace(/\r?\n$/, "");
  };
  return {
    scheme: "doppler",
    resolve,
    fingerprint: async (ref, env) => fingerprintOf(await resolve(ref, env)),
  };
}

/** `op://vault/item/field` → `op read`, which accepts the reference as-is. */
export function opSecretSource(exec: Exec = defaultExec): SecretSource {
  const resolve = async (ref: string, env: NodeJS.ProcessEnv): Promise<string> => {
    const path = stripScheme(ref, "op");
    if (path.split("/").length < 3) throw new Error(`secret ${ref}: expected op://vault/item/field`);
    const out = await exec("op", ["read", ref, "--no-newline"], env);
    return out.replace(/\r?\n$/, "");
  };
  return {
    scheme: "op",
    resolve,
    fingerprint: async (ref, env) => fingerprintOf(await resolve(ref, env)),
  };
}
