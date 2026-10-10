import { execFile } from "node:child_process";
import { SponsonError, type SecretSource } from "@sponson/core";

/** Runs a CLI and returns its stdout. Injected in tests so no real `doppler`/`op`/`aws` is needed. */
export type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

/** Runs the real binary from PATH; rejects with its stderr when it fails. */
export const defaultExec: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });

function unresolved(ref: string, why: string): SponsonError {
  return new SponsonError("SECRET_UNRESOLVED", `secret ${ref}: ${why}`, { ref });
}

function stripScheme(ref: string, scheme: string): string {
  const prefix = `${scheme}://`;
  if (!ref.startsWith(prefix)) throw unresolved(ref, `expected ${prefix}…`);
  return ref.slice(prefix.length);
}

/** CLIs end their output with one newline (LF or CRLF); the secret is what comes before it. */
function stripTrailingNewline(out: string): string {
  return out.replace(/(\r\n|\n|\r)$/, "");
}

/** Run a secret CLI; any failure (missing binary, not signed in, unknown item) is SECRET_UNRESOLVED naming the ref. */
async function runCli(exec: Exec, ref: string, file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return stripTrailingNewline(await exec(file, args, env));
  } catch (e) {
    throw unresolved(ref, (e as Error).message);
  }
}

/** `env://NAME` → process environment. Zero configuration; the CI default. */
export const envSecretSource: SecretSource = {
  scheme: "env",
  async resolve(ref, env) {
    const name = stripScheme(ref, "env");
    const v = env[name];
    if (v === undefined || v === "") throw new SponsonError("SECRET_UNRESOLVED", `secret ${ref}: environment variable ${name} is not set`, { ref, variable: name });
    return v;
  },
};

/** `doppler://project/config/NAME` → `doppler secrets get`. Uses the CLI's login or DOPPLER_TOKEN from the env. */
export function dopplerSecretSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "doppler",
    async resolve(ref, env) {
      const parts = stripScheme(ref, "doppler").split("/");
      if (parts.length !== 3 || parts.some((p) => p === "")) throw unresolved(ref, "expected doppler://project/config/NAME");
      const [project, config, name] = parts as [string, string, string];
      return runCli(exec, ref, "doppler", ["secrets", "get", name, "--project", project, "--config", config, "--plain"], env);
    },
  };
}

/** `op://vault/item/field` → `op read`, which accepts the reference as-is. */
export function opSecretSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "op",
    async resolve(ref, env) {
      const path = stripScheme(ref, "op");
      if (path.split("/").length < 3) throw unresolved(ref, "expected op://vault/item/field");
      return runCli(exec, ref, "op", ["read", ref, "--no-newline"], env);
    },
  };
}

/**
 * `aws-sm://<secret-id>` → `aws secretsmanager get-secret-value`, through the `aws` CLI so the AWS SDK stays out of
 * the dependency tree. The secret id is a name or an ARN; region, profile and credentials come from the CLI's own
 * conventions (`AWS_REGION`, `AWS_PROFILE`, ...). `aws-sm://<secret-id>#<key>` picks one key of a JSON secret, the
 * shape the AWS console creates for key/value secrets.
 */
export function awsSecretsManagerSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "aws-sm",
    async resolve(ref, env) {
      const path = stripScheme(ref, "aws-sm");
      const hash = path.indexOf("#");
      const id = hash < 0 ? path : path.slice(0, hash);
      const key = hash < 0 ? undefined : path.slice(hash + 1);
      if (id === "" || key === "") throw unresolved(ref, "expected aws-sm://<secret-id> or aws-sm://<secret-id>#<key>");
      // JSON output, not text: text prints a binary secret's missing SecretString as the word "None".
      const out = await runCli(exec, ref, "aws", ["secretsmanager", "get-secret-value", "--secret-id", id, "--query", "SecretString", "--output", "json"], env);
      const value = parseJson(out);
      if (typeof value !== "string") throw unresolved(ref, "the secret has no string value (binary secrets are not supported)");
      if (key === undefined) return value;
      // Never echo the secret (or a fragment of it) in these messages: they end up in the receipt.
      const fields = parseJson(value);
      if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw unresolved(ref, `#${key} needs a JSON object secret, and this one is not`);
      const picked = (fields as Record<string, unknown>)[key];
      if (picked === undefined) throw unresolved(ref, `the secret has no key ${key}`);
      if (typeof picked !== "string" && typeof picked !== "number" && typeof picked !== "boolean") throw unresolved(ref, `key ${key} is not a string, number or boolean`);
      return String(picked);
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
