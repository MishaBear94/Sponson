import { execFile } from "node:child_process";
import { SponsonError, type SecretSource } from "@sponson/core";
import { apiClient, isProviderError, type ApiClient, type ApiClientOptions } from "./http.js";

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

const INFISICAL_FORM = "expected infisical://<projectId>/<env>/<NAME> or infisical://<projectId>/<env>/<folder>/…/<NAME>";
/**
 * What `infisical secrets get` prints for a name the folder does not hold, in place of a value (Infisical CLI,
 * packages/cmd/secrets.go `getSecretsByNames`). It exits 0 with it, so it must be recognised here, never passed on.
 */
const INFISICAL_NOT_FOUND = "*not found*";

/**
 * `infisical://<projectId>/<env>/[<folder>/…/]<NAME>` → `infisical secrets get`, through the Infisical CLI
 * (https://infisical.com/docs/cli/commands/secrets). The folders become `--path` (default `/`). Credentials come
 * from the CLI's own conventions: `INFISICAL_TOKEN` (or `INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN`) for a machine
 * identity, else the CLI's login; `INFISICAL_DOMAIN` for EU Cloud or a self-hosted instance. The project id is part of
 * the reference because a machine identity has no `.infisical.json` to take it from.
 *
 * JSON output, not `--plain`: with `--plain` an unknown name prints nothing at all (exit 0), indistinguishable from
 * an empty secret; with `--output json` it prints the entry with the value `*not found*`, which is refused here.
 */
export function infisicalSecretSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "infisical",
    form: "`infisical://projectId/env/NAME` or `infisical://projectId/env/folder/…/NAME`",
    resolvedBy:
      "`infisical secrets get NAME --projectId projectId --env env --path /folder/… --output json --silent` (Infisical CLI; credentials from `INFISICAL_TOKEN` or the CLI's login, the instance from `INFISICAL_DOMAIN`). A name the folder does not hold is `SECRET_UNRESOLVED`, never a value.",
    async resolve(ref, env) {
      const parts = stripScheme(ref, "infisical").split("/");
      if (parts.length < 3 || parts.some((p) => p === "")) throw unresolved(ref, INFISICAL_FORM);
      const [projectId, environment, ...rest] = parts as [string, string, ...string[]];
      const name = rest.pop() as string;
      const path = `/${rest.join("/")}`;
      const args = ["secrets", "get", name, "--projectId", projectId, "--env", environment, "--path", path, "--output", "json", "--silent"];
      const out = await runCli(exec, ref, "infisical", args, env, [name, projectId, environment, ...rest]);
      // Never echo the output (or a fragment of it) in these messages: it holds the value.
      const entries = parseJson(out);
      const entry = Array.isArray(entries) ? (entries as unknown[]).find((e) => isRecord(e) && e.secretKey === name) : undefined;
      const value = isRecord(entry) ? entry.secretValue : undefined;
      if (entry === undefined || value === INFISICAL_NOT_FOUND) throw unresolved(ref, `no secret ${name} in environment ${environment} at ${path}`);
      if (typeof value !== "string") throw unresolved(ref, "the Infisical CLI returned no value");
      return value;
    },
  };
}

const AZURE_KV_FORM = "expected azure-kv://<vault>/<name> or azure-kv://<vault>/<name>/<version>";
/** Key Vault's own rules: vault names 3-24 of 0-9 a-z A-Z and non-consecutive `-`; secret names 1-127 of 0-9 a-z A-Z `-`; versions 32 characters. */
const AZURE_VAULT = /^(?!.*--)[A-Za-z0-9-]{3,24}$/;
const AZURE_SECRET = /^[A-Za-z0-9-]{1,127}$/;
const AZURE_VERSION = /^[A-Za-z0-9]{32}$/;

/**
 * `azure-kv://<vault>/<name>[/<version>]` → `az keyvault secret show`, through the Azure CLI so neither the Azure SDK
 * nor an Entra ID token flow enters the dependency tree. The CLI rather than `GET {vault}/secrets/{name}` with a token
 * from `az account get-access-token`: one process instead of two, and the CLI already knows the vault DNS suffix of
 * the signed-in cloud (`vault.azure.net`, `vault.azure.cn`, `vault.usgovcloudapi.net`) and every way to sign in
 * (`az login`, a service principal, a managed identity, federated CI credentials).
 * https://learn.microsoft.com/en-us/cli/azure/keyvault/secret#az-keyvault-secret-show
 */
export function azureKeyVaultSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "azure-kv",
    form: "`azure-kv://vault/name` or `azure-kv://vault/name/version`",
    resolvedBy:
      "`az keyvault secret show --vault-name vault --name name [--version version] --query value --output json` (Azure CLI; credentials and cloud from `az login` and the CLI's other conventions). The version defaults to the latest.",
    async resolve(ref, env) {
      const parts = stripScheme(ref, "azure-kv").split("/");
      if (parts.length < 2 || parts.length > 3) throw unresolved(ref, AZURE_KV_FORM);
      const [vault, name, version] = parts as [string, string, string?];
      if (!AZURE_VAULT.test(vault) || !AZURE_SECRET.test(name) || (version !== undefined && !AZURE_VERSION.test(version))) throw unresolved(ref, AZURE_KV_FORM);
      const pinned = version === undefined ? [] : [version];
      // JSON, not `-o tsv`: tsv cannot tell a value's own trailing newline from the one the CLI ends its output with.
      const args = ["keyvault", "secret", "show", "--vault-name", vault, "--name", name, ...pinned.flatMap((v) => ["--version", v]), "--query", "value", "--output", "json"];
      const value = parseJson(await runCli(exec, ref, "az", args, env, [vault, name, ...pinned]));
      if (typeof value !== "string") throw unresolved(ref, "the secret has no value");
      return value;
    },
  };
}

/** Bitwarden secret ids are UUIDs (`bws secret get` parses its argument as one). */
const BWS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `bws://<secret-id>` → `bws secret get`, through the Bitwarden Secrets Manager CLI
 * (https://bitwarden.com/help/secrets-manager-cli/). The machine account's access token comes from
 * `BWS_ACCESS_TOKEN`, a self-hosted server from `BWS_SERVER_URL` (both read by the CLI itself: crates/bws/src/cli.rs
 * in bitwarden/sdk-sm). `--color no`: the CLI colours its JSON whenever it believes the terminal supports colour,
 * which `FORCE_COLOR` in CI makes it believe.
 */
export function bitwardenSecretsManagerSource(exec: Exec = defaultExec): SecretSource {
  return {
    scheme: "bws",
    form: "`bws://secret-id`",
    resolvedBy:
      "`bws secret get secret-id --output json --color no` (Bitwarden Secrets Manager CLI; the machine account's token from `BWS_ACCESS_TOKEN`, a self-hosted server from `BWS_SERVER_URL`). `secret-id` is the secret's UUID.",
    async resolve(ref, env) {
      const id = stripScheme(ref, "bws");
      if (!BWS_ID.test(id)) throw unresolved(ref, "expected bws://<secret-id>, the secret's UUID");
      const response = parseJson(await runCli(exec, ref, "bws", ["secret", "get", id, "--output", "json", "--color", "no"], env, [id]));
      // Never echo the response (or a fragment of it) in these messages: it holds the value.
      const value = isRecord(response) ? response.value : undefined;
      if (typeof value !== "string") throw unresolved(ref, "the Bitwarden CLI returned no value");
      return value;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP-backed sources: HashiCorp Vault, 1Password Connect
// ---------------------------------------------------------------------------

/** A variable the source cannot work without; unset or empty is SECRET_UNRESOLVED naming it. */
function requiredVar(ref: string, env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") throw unresolved(ref, `${name} is not set`, { variable: name });
  return v;
}

/** A server address from the environment: an absolute http(s) URL. */
function requiredUrl(ref: string, env: NodeJS.ProcessEnv, name: string): string {
  const v = requiredVar(ref, env, name);
  let url: URL | undefined;
  try {
    url = new URL(v);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "http:" && url?.protocol !== "https:") throw unresolved(ref, `${name} is not an http(s) URL`, { variable: name });
  return v;
}

/**
 * The adapters' HTTP client for a secret service: its timeout (SPONSON_HTTP_TIMEOUT_MS), its retries of a 5xx or a
 * dropped connection (SPONSON_HTTP_RETRIES), and the token masked in any error text it builds.
 */
function secretClient(service: string, baseUrl: string, token: string, authHeader: ApiClientOptions["authHeader"], headers: Record<string, string>, env: NodeJS.ProcessEnv): ApiClient {
  return apiClient({ adapter: service, baseUrl, token, authHeader, headers, env, redact: (s) => s.split(token).join("***") });
}

/**
 * GET a path; any failure is SECRET_UNRESOLVED. A 404 reads as `notFound`. An answer that is not JSON is reported
 * without its text, which is where the value would be; every other failure keeps the client's message (method,
 * path, status and the service's own error, which never holds the value; the token is masked).
 */
async function httpRead(ref: string, api: ApiClient, path: string, notFound: string): Promise<unknown> {
  try {
    return await api.get(path);
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) throw unresolved(ref, notFound, { status: 404 });
    if (isProviderError(e, "PROVIDER_RESPONSE")) throw unresolved(ref, `${api.adapter}: GET ${path} answered with something that is not JSON`);
    if (isProviderError(e)) throw unresolved(ref, e.message, e.details.status === undefined ? {} : { status: e.details.status });
    throw unresolved(ref, (e as Error).message);
  }
}

const VAULT_FORM = "expected vault://<mount>/<path>#<key>";

/** `vault://<mount>/<path>#<key>`, split; `.` and `..` segments are refused so a reference cannot climb out of the mount. */
function vaultRef(ref: string): { mount: string; path: string[]; key: string } {
  const body = stripScheme(ref, "vault");
  const hash = body.indexOf("#");
  const segments = (hash < 0 ? body : body.slice(0, hash)).split("/");
  const key = hash < 0 ? "" : body.slice(hash + 1);
  if (key === "" || segments.length < 2 || segments.some((s) => s === "" || s === "." || s === "..")) throw unresolved(ref, VAULT_FORM);
  const [mount, ...path] = segments as [string, ...string[]];
  return { mount, path, key };
}

/**
 * `vault://<mount>/<path>#<key>` → HashiCorp Vault's KV v2 "read secret version", `GET /v1/<mount>/data/<path>`
 * (https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2), over the adapters' HTTP client, no SDK. The
 * address is `VAULT_ADDR`, the token `VAULT_TOKEN` (sent as `X-Vault-Token`), and `VAULT_NAMESPACE`, when set, is
 * sent as `X-Vault-Namespace` (Vault Enterprise, HCP Vault Dedicated: https://developer.hashicorp.com/vault/api-docs).
 * The mount is the first segment; the latest version is read. `#key` picks one key of the secret's map.
 */
export const vaultSecretSource: SecretSource = {
  scheme: "vault",
  form: "`vault://mount/path#KEY`",
  resolvedBy:
    "HashiCorp Vault KV v2, `GET $VAULT_ADDR/v1/mount/data/path` with `X-Vault-Token: $VAULT_TOKEN` (and `X-Vault-Namespace: $VAULT_NAMESPACE` when set); the latest version's `KEY`. The mount is the first segment.",
  async resolve(ref, env) {
    const { mount, path, key } = vaultRef(ref);
    const addr = requiredUrl(ref, env, "VAULT_ADDR");
    const token = requiredVar(ref, env, "VAULT_TOKEN");
    const namespace = env.VAULT_NAMESPACE;
    const api = secretClient("vault", addr, token, "header:X-Vault-Token", namespace ? { "X-Vault-Namespace": namespace } : {}, env);
    const url = `/v1/${encodeURIComponent(mount)}/data/${path.map(encodeURIComponent).join("/")}`;
    const where = `${mount}/${path.join("/")}`;
    // Vault answers 404 both for a path that does not exist and for one the token may not see.
    const body = await httpRead(ref, api, url, `no secret at ${where} (or the token may not read it; a KV v1 mount is not supported)`);
    // Never echo the body (or a fragment of it) in these messages: it holds the values.
    const data = isRecord(body) && isRecord(body.data) ? body.data.data : undefined;
    if (!isRecord(data)) throw unresolved(ref, `the latest version of ${where} is deleted or destroyed, or the answer is not a KV v2 secret`);
    return scalarField(ref, data, key, where);
  },
};

/** One key of a secret's map as a string; numbers and booleans are written as JSON writes them. */
function scalarField(ref: string, fields: Record<string, unknown>, key: string, where: string): string {
  const v = fields[key];
  if (v === undefined) throw unresolved(ref, `${where} has no key ${key}`);
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw unresolved(ref, `key ${key} of ${where} is not a string, number or boolean`);
  return String(v);
}

const OP_CONNECT_FORM = "expected op-connect://<vault>/<item>/<field> or op-connect://<vault>/<item>/<section>/<field>";
/** Vault and item ids as Connect shows them (`ytrfte14kw1uex5txaore1emkz`); anything else is looked up by name. */
const OP_ID = /^[a-z0-9]{26}$/;

interface OpConnectRef {
  vault: string;
  item: string;
  section?: string;
  field: string;
}

function opConnectRef(ref: string): OpConnectRef {
  const parts = stripScheme(ref, "op-connect").split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => p === "")) throw unresolved(ref, OP_CONNECT_FORM);
  const [vault, item] = parts as [string, string];
  return parts.length === 4 ? { vault, item, section: parts[2] as string, field: parts[3] as string } : { vault, item, field: parts[2] as string };
}

/** A filter value in Connect's SCIM-style `filter` (`name eq "Demo Vault"`), quotes and backslashes escaped. */
function scimString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The id of the one vault (`attr` = `name`) or item (`title`) called `name`. The filter narrows the list; the exact
 * comparison here decides, so a server that ignored the filter would not change the answer.
 */
async function opConnectFind(ref: string, api: ApiClient, list: string, attr: "name" | "title", name: string, what: string): Promise<string> {
  const body = await httpRead(ref, api, `${list}?filter=${encodeURIComponent(`${attr} eq ${scimString(name)}`)}`, `no ${what} named ${name}`);
  const found = (Array.isArray(body) ? (body as unknown[]) : []).filter((e): e is Record<string, unknown> => isRecord(e) && e[attr] === name && typeof e.id === "string");
  if (found.length === 0) throw unresolved(ref, `no ${what} named ${name}`);
  if (found.length > 1) throw unresolved(ref, `${found.length} ${what}s are named ${name}; use the id instead`);
  return found[0]!.id as string;
}

/** The fields of an item's section, matched by the section's id or label. */
function inSection(ref: string, item: Record<string, unknown>, fields: Array<Record<string, unknown>>, section: string): Array<Record<string, unknown>> {
  const sections = (Array.isArray(item.sections) ? (item.sections as unknown[]) : []).filter(isRecord);
  const ids = new Set(sections.filter((s) => s.id === section || s.label === section).map((s) => s.id));
  if (ids.size === 0) throw unresolved(ref, `the item has no section ${section}`);
  return fields.filter((f) => isRecord(f.section) && ids.has(f.section.id));
}

/** The value of the one field matched by id, else by label, as `op read` matches them. */
function opConnectField(ref: string, item: unknown, r: OpConnectRef): string {
  if (!isRecord(item) || !Array.isArray(item.fields)) throw unresolved(ref, "the item has no fields");
  let fields = (item.fields as unknown[]).filter(isRecord);
  if (r.section !== undefined) fields = inSection(ref, item, fields, r.section);
  const byId = fields.filter((f) => f.id === r.field);
  const matches = byId.length > 0 ? byId : fields.filter((f) => f.label === r.field);
  if (matches.length === 0) throw unresolved(ref, `the item has no field ${r.field}`);
  if (matches.length > 1) throw unresolved(ref, `${matches.length} fields of the item are labelled ${r.field}; name its section or use the field id`);
  // Never echo the value (or a fragment of it) in these messages.
  const value = matches[0]!.value;
  if (typeof value !== "string" || value === "") throw unresolved(ref, `field ${r.field} has no value`);
  return value;
}

/**
 * `op-connect://<vault>/<item>/[<section>/]<field>` → a 1Password Connect server's REST API
 * (https://www.1password.dev/connect/api-reference/): `GET /v1/vaults/{vault}/items/{item}`, bearer
 * `OP_CONNECT_TOKEN`, at `OP_CONNECT_HOST` (the variables 1Password's own Connect SDKs and `op` read). Vaults and
 * items are named by id or by name / title (looked up with `GET /v1/vaults?filter=name eq "…"` and
 * `GET /v1/vaults/{vault}/items?filter=title eq "…"`; a name must be unique); fields by id or label.
 */
export const opConnectSecretSource: SecretSource = {
  scheme: "op-connect",
  form: "`op-connect://vault/item/field` or `op-connect://vault/item/section/field`",
  resolvedBy:
    "a 1Password Connect server, `GET $OP_CONNECT_HOST/v1/vaults/vault/items/item` with `Authorization: Bearer $OP_CONNECT_TOKEN`. `vault` and `item` are ids or unique names (looked up with `?filter=`); `section` and `field` are ids or labels.",
  async resolve(ref, env) {
    const r = opConnectRef(ref);
    const host = requiredUrl(ref, env, "OP_CONNECT_HOST");
    const api = secretClient("1password-connect", host, requiredVar(ref, env, "OP_CONNECT_TOKEN"), "bearer", {}, env);
    const vaultId = OP_ID.test(r.vault) ? r.vault : await opConnectFind(ref, api, "/v1/vaults", "name", r.vault, "vault");
    const itemId = OP_ID.test(r.item) ? r.item : await opConnectFind(ref, api, `/v1/vaults/${vaultId}/items`, "title", r.item, "item");
    const item = await httpRead(ref, api, `/v1/vaults/${vaultId}/items/${itemId}`, `no item ${r.item} in vault ${r.vault} (or the token may not read it)`);
    return opConnectField(ref, item, r);
  },
};

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
