import { execFile } from "node:child_process";
import { SponsonError, type SecretSource } from "@sponson/core";

/** Runs a CLI and returns its stdout. Injected in tests so no real `doppler`/`op`/`aws` is needed. */
export type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

/**
 * Runs the real binary from PATH; rejects with its stderr when it fails. A binary that cannot be started keeps the
 * system error's `code` (`ENOENT`, `EACCES`), so the caller can say what is wrong instead of echoing it.
 */
export const defaultExec: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const spawnCode = typeof err.code === "string" ? err.code : undefined;
      const failure = new Error(`${file} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`) as NodeJS.ErrnoException;
      if (spawnCode) failure.code = spawnCode;
      reject(failure);
    });
  });

/**
 * The one shape of every SECRET_UNRESOLVED a built-in source throws: the reason only. The engine prefixes the
 * reference when it reports the line (`aws-sm://x: <reason>`), so the message never names the ref twice; the ref is
 * in `details.ref` for callers that use a source directly. Never put the value, or any part of it, in `why`.
 */
function unresolved(ref: string, why: string, details: Record<string, unknown> = {}): SponsonError {
  return new SponsonError("SECRET_UNRESOLVED", why, { ref, ...details });
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

/**
 * Run a secret CLI; any failure is SECRET_UNRESOLVED. Every CLI-backed source goes through here, so a missing binary
 * reads the same for all of them ("the `aws` CLI is not installed or not on PATH"), and any other failure (not signed
 * in, unknown item) carries the CLI's own error text, which never contains the value it failed to read.
 *
 * `fromRef` lists every argument taken from the reference. A plan is reviewed as data, so none of them may read as an
 * option to the CLI: one starting with `-` is refused before anything runs.
 */
async function runCli(exec: Exec, ref: string, file: string, args: string[], env: NodeJS.ProcessEnv, fromRef: string[]): Promise<string> {
  const flag = fromRef.find((a) => a.startsWith("-"));
  if (flag !== undefined) throw unresolved(ref, `a reference segment may not start with "-" (it would reach the \`${file}\` CLI as an option)`);
  try {
    return stripTrailingNewline(await exec(file, args, env));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw unresolved(ref, `the \`${file}\` CLI is not installed or not on PATH`);
    if (code === "EACCES") throw unresolved(ref, `the \`${file}\` CLI on PATH is not executable`);
    throw unresolved(ref, (e as Error).message);
  }
}

/** `env://NAME` → process environment. Zero configuration; the CI default. */
export const envSecretSource: SecretSource = {
  scheme: "env",
  form: "`env://NAME`",
  resolvedBy: "the process environment; unset or empty is `SECRET_UNRESOLVED`",
  async resolve(ref, env) {
    const name = stripScheme(ref, "env");
    const v = env[name];
    if (v === undefined || v === "") throw unresolved(ref, `environment variable ${name} is not set`, { variable: name });
    return v;
  },
};

/** `doppler://project/config/NAME` → `doppler secrets get`. Uses the CLI's login or DOPPLER_TOKEN from the env. */
export function dopplerSecretSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "doppler",
    form: "`doppler://project/config/NAME`",
    resolvedBy: "`doppler secrets get NAME --project project --config config --plain` (Doppler CLI)",
    async resolve(ref, env) {
      const parts = stripScheme(ref, "doppler").split("/");
      if (parts.length !== 3 || parts.some((p) => p === "")) throw unresolved(ref, "expected doppler://project/config/NAME");
      const [project, config, name] = parts as [string, string, string];
      return runCli(exec, ref, "doppler", ["secrets", "get", name, "--project", project, "--config", config, "--plain"], env, [name, project, config]);
    },
  };
}

/** `op://vault/item/field` → `op read`, which accepts the reference as-is. */
export function opSecretSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "op",
    form: "`op://vault/item/field`",
    resolvedBy: "`op read op://vault/item/field --no-newline` (1Password CLI)",
    async resolve(ref, env) {
      const path = stripScheme(ref, "op");
      if (path.split("/").length < 3) throw unresolved(ref, "expected op://vault/item/field");
      // The reference is passed whole and always starts with `op://`, so it can never read as an option.
      return runCli(exec, ref, "op", ["read", ref, "--no-newline"], env, [ref]);
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
    form: "`aws-sm://secret-id` or `aws-sm://secret-id#KEY`",
    resolvedBy:
      "`aws secretsmanager get-secret-value --secret-id secret-id --query SecretString --output json` (AWS CLI; region and credentials from `AWS_REGION`, `AWS_PROFILE` and the CLI's other conventions). `secret-id` is a name or an ARN; `#KEY` picks one key of a JSON key/value secret. Binary secrets are not supported.",
    async resolve(ref, env) {
      const path = stripScheme(ref, "aws-sm");
      const hash = path.indexOf("#");
      const id = hash < 0 ? path : path.slice(0, hash);
      const key = hash < 0 ? undefined : path.slice(hash + 1);
      if (id === "" || key === "") throw unresolved(ref, "expected aws-sm://<secret-id> or aws-sm://<secret-id>#<key>");
      // JSON output, not text: text prints a binary secret's missing SecretString as the word "None".
      const out = await runCli(exec, ref, "aws", ["secretsmanager", "get-secret-value", "--secret-id", id, "--query", "SecretString", "--output", "json"], env, [id]);
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

const GCP_SM_FORM = "expected gcp-sm://<project>/<secret> or gcp-sm://<project>/<secret>/<version>";
/** Project ids (including domain-scoped `example.com:proj`) and project numbers; no leading `-`, so never a flag. */
const GCP_PROJECT = /^[a-z0-9][a-z0-9.:-]*$/;
/** Secret Manager's own rule for secret ids. */
const GCP_SECRET = /^[A-Za-z0-9_-]{1,255}$/;
const GCP_VERSION = /^(latest|[1-9][0-9]*)$/;

/**
 * `gcp-sm://<project>/<secret>[/<version>]` → `gcloud secrets versions access`, through the `gcloud` CLI so the Google
 * SDK stays out of the dependency tree. The version defaults to `latest`; credentials come from the CLI's own
 * conventions (`gcloud auth`, `CLOUDSDK_*`, `GOOGLE_APPLICATION_CREDENTIALS`). The project is part of the reference
 * so a plan never depends on whichever project the runner's gcloud happens to have configured.
 */
export function gcpSecretManagerSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "gcp-sm",
    form: "`gcp-sm://project/secret` or `gcp-sm://project/secret/version`",
    resolvedBy:
      "`gcloud secrets versions access version --secret=secret --project=project --format=json` (Google Cloud CLI; credentials from `gcloud auth` and the CLI's other conventions). `version` is a number or `latest` (the default). The payload must be UTF-8 text.",
    async resolve(ref, env) {
      const parts = stripScheme(ref, "gcp-sm").split("/");
      if (parts.length < 2 || parts.length > 3) throw unresolved(ref, GCP_SM_FORM);
      const [project, secret, version = "latest"] = parts as [string, string, string?];
      if (!GCP_PROJECT.test(project) || !GCP_SECRET.test(secret) || !GCP_VERSION.test(version)) throw unresolved(ref, GCP_SM_FORM);
      // JSON, not the default raw output: the payload arrives base64-encoded, so a value ending in a newline survives
      // and a binary payload is recognised instead of being passed on as mangled text.
      const out = await runCli(exec, ref, "gcloud", ["secrets", "versions", "access", version, `--secret=${secret}`, `--project=${project}`, "--format=json"], env, [version, secret, project]);
      const response = parseJson(out);
      const data = isRecord(response) && isRecord(response.payload) ? response.payload.data : undefined;
      if (typeof data !== "string") throw unresolved(ref, "gcloud returned no payload");
      // Never echo the payload (or a fragment of it) in these messages: they end up in the receipt.
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64"));
      } catch {
        throw unresolved(ref, "the secret is not UTF-8 text (binary secrets are not supported)");
      }
      if (value === "") throw unresolved(ref, "the secret is empty");
      return value;
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
