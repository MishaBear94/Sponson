/**
 * How the generic `http` adapter authenticates to an API: the `auth` forms of a `providers.http.<api>` block,
 * parsed (pure), and the credential each one sends at run time (ADR 0017 and its amendment).
 *
 *   { bearer_env }, { header, value_env, prefix? }, { basic }   a static header from environment variables
 *   { headers: [{ header, value_env, prefix? }, …] }   several such headers at once (Datadog's API and application keys)
 *   { oauth2_client_credentials: { … } }              a bearer token from an OAuth2 token endpoint (RFC 6749 §4.4)
 *   { command: [argv…] }                               a bearer token printed by a CLI (`gcloud auth print-access-token`)
 *   { aws_sigv4: { … } }                               every request signed with AWS Signature Version 4
 *   { digest: { user_env, password_env } }             HTTP Digest (RFC 7616), answering the server's challenge
 *
 * Every form names environment variables, never values, so the block (the ledger identity of the API's resources)
 * holds no secret. A credential obtained at run time (an access token, a printed token) is registered with the
 * engine's redactor (`actx.secret`) the moment it exists and masked in this adapter's own error text too, so it never
 * reaches output, receipts or errors. Tokens are fetched once per run per API block (cached in memory until shortly
 * before they expire) and fetched again, once, when the API answers 401.
 */
import { createHash } from "node:crypto";
import { SponsonError, canonicalJson, type AdapterContext, type Ctx } from "@sponson/core";
import { optionalEnv, requireEnv } from "./common.js";
import { digestAuthorization, pickChallenge, type DigestChallenge } from "./digest.js";
import { apiClient, isObject, ShapeError, type RequestSigner, type SignableRequest } from "./http.js";
import { defaultExec, type Exec } from "./secrets.js";
import { signRequest } from "./sigv4.js";

const ADAPTER = "http";

/** How a token is sent to an OAuth2 token endpoint (RFC 6749 §2.3.1). */
export type ClientAuthMethod = "client_secret_post" | "client_secret_basic";

/** How the credential is sent. */
export type Auth =
  | { kind: "bearer"; env: string }
  | { kind: "header"; header: string; env: string; prefix?: string }
  | { kind: "headers"; headers: Array<{ header: string; env: string; prefix?: string }> }
  | { kind: "basic"; userEnv: string; passwordEnv: string }
  | { kind: "oauth2"; tokenUrl: string; tokenUrlEnv?: string; clientIdEnv: string; clientSecretEnv: string; audience?: string; scope?: string; extra: Record<string, string>; method: ClientAuthMethod }
  | { kind: "command"; argv: string[] }
  | { kind: "sigv4"; region: string; service: string; accessKeyIdEnv: string; secretAccessKeyEnv: string; sessionTokenEnv?: string }
  | { kind: "digest"; userEnv: string; passwordEnv: string }
  /** No credential: only for a public endpoint a manual step's verify request reads (`parseApi(…, { authOptional })`). */
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Variable names the engine masks everywhere (packages/core/src/engine/run-context.ts, CREDENTIAL_NAME). A
 * credential under another name would be masked only in this adapter's own error text, so it is refused.
 */
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP header name (RFC 9110 token). */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** PLAN_INVALID naming where in the provider block the fault is. */
export function planError(message: string, where: string): SponsonError {
  return new SponsonError("PLAN_INVALID", `${ADAPTER}: ${where}: ${message}`, { adapter: ADAPTER, key: where });
}

/** The NAME of an environment variable; a credential's name must be one the engine masks. */
export function envName(v: unknown, where: string, credential: boolean): string {
  if (typeof v !== "string" || !ENV_NAME.test(v)) throw planError("must be the NAME of an environment variable, never a value", where);
  if (credential && !CREDENTIAL_NAME.test(v)) throw planError(`\`${v}\` must end in TOKEN, SECRET, PASSWORD, PASSWD, _KEY or APIKEY, so that Sponson masks its value in every output`, where);
  return v;
}

const AUTH_FORMS =
  "`{ bearer_env: NAME }`, `{ header: X-Api-Key, value_env: NAME, prefix?: \"Api-Key \" }`, `{ headers: [{ header, value_env }, …] }`, `{ basic: { user_env, password_env } }`, `{ oauth2_client_credentials: { token_url, client_id_env, client_secret_env } }`, `{ command: [argv…] }`, `{ aws_sigv4: { region, service, access_key_id_env, secret_access_key_env } }` or `{ digest: { user_env, password_env } }`";

function subBlock(v: unknown, where: string, known: string[]): Record<string, unknown> {
  if (!isObject(v)) throw planError(`must be a map (${known.join(", ")})`, where);
  const extra = Object.keys(v).find((k) => !known.includes(k));
  if (extra) throw planError(`unknown key \`${extra}\` (known: ${known.join(", ")})`, where);
  return v;
}

function optionalString(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") throw planError("must be a non-empty string", where);
  return v;
}

function httpUrl(v: unknown, where: string): string {
  if (typeof v !== "string" || !/^https?:\/\/[^\s]+$/.test(v)) throw planError("must be an http(s) URL", where);
  return v;
}

/** Form parameters every client-credentials request sets itself; `extra` may not override them. */
const OAUTH_RESERVED = new Set(["grant_type", "client_id", "client_secret", "audience", "scope", "client_assertion", "client_assertion_type"]);

function stringMap(v: unknown, where: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v) || !Object.values(v).every((x) => typeof x === "string")) throw planError("must be a map of parameter name to string", where);
  const reserved = Object.keys(v).find((k) => OAUTH_RESERVED.has(k));
  if (reserved) throw planError(`\`${reserved}\` is set by Sponson (use the block's own key, or an environment variable for a credential)`, where);
  return v as Record<string, string>;
}

function parseOauth2(v: unknown, where: string): Auth {
  const o = subBlock(v, where, ["token_url", "token_url_env", "client_id_env", "client_secret_env", "audience", "scope", "extra", "auth_method"]);
  const method = o.auth_method ?? "client_secret_post";
  if (method !== "client_secret_post" && method !== "client_secret_basic") throw planError("must be `client_secret_post` (the default) or `client_secret_basic`; `private_key_jwt` is not supported", `${where}.auth_method`);
  const audience = optionalString(o.audience, `${where}.audience`);
  const scope = optionalString(o.scope, `${where}.scope`);
  return {
    kind: "oauth2",
    tokenUrl: httpUrl(o.token_url, `${where}.token_url`),
    ...(o.token_url_env !== undefined ? { tokenUrlEnv: envName(o.token_url_env, `${where}.token_url_env`, false) } : {}),
    clientIdEnv: envName(o.client_id_env, `${where}.client_id_env`, false),
    clientSecretEnv: envName(o.client_secret_env, `${where}.client_secret_env`, true),
    ...(audience !== undefined ? { audience } : {}),
    ...(scope !== undefined ? { scope } : {}),
    extra: stringMap(o.extra, `${where}.extra`),
    method,
  };
}

/**
 * A command's argv, run without a shell. Each element is a literal string: a reference (`{ from }`, `{ secret }`), a
 * `${…}` interpolation or a shell `$VAR` would never be expanded, so it is refused rather than passed on as text.
 */
function parseCommand(v: unknown, where: string): Auth {
  if (!Array.isArray(v) || v.length === 0) throw planError('must be the command as a list of arguments, e.g. ["gcloud", "auth", "print-access-token"] (never a shell string)', where);
  v.forEach((a, i) => {
    if (typeof a !== "string" || a === "") throw planError("must be a non-empty literal string (references are not resolved in a command)", `${where}[${i}]`);
    if (a.startsWith("$") || a.includes("${")) throw planError(`\`${a}\` starts with or holds a reference, which a command never expands (it runs without a shell); write the literal argument`, `${where}[${i}]`);
  });
  const file = v[0] as string;
  if (file.startsWith("-") || /\s/.test(file)) throw planError(`\`${file}\` must be a program name or path, one list element per argument`, `${where}[0]`);
  return { kind: "command", argv: v as string[] };
}

function parseSigv4(v: unknown, where: string): Auth {
  const o = subBlock(v, where, ["region", "service", "access_key_id_env", "secret_access_key_env", "session_token_env"]);
  const name = (x: unknown, key: string) => {
    if (typeof x !== "string" || !/^[a-z0-9-]+$/.test(x)) throw planError("must be a lower-case AWS name such as us-east-1 or s3", `${where}.${key}`);
    return x;
  };
  return {
    kind: "sigv4",
    region: name(o.region, "region"),
    service: name(o.service, "service"),
    accessKeyIdEnv: envName(o.access_key_id_env, `${where}.access_key_id_env`, false),
    secretAccessKeyEnv: envName(o.secret_access_key_env, `${where}.secret_access_key_env`, true),
    ...(o.session_token_env !== undefined ? { sessionTokenEnv: envName(o.session_token_env, `${where}.session_token_env`, true) } : {}),
  };
}

function parseUserPassword(v: unknown, where: string, kind: "basic" | "digest"): Auth {
  const o = subBlock(v, where, ["user_env", "password_env"]);
  return { kind, userEnv: envName(o.user_env, `${where}.user_env`, false), passwordEnv: envName(o.password_env, `${where}.password_env`, true) };
}

const PARSERS: Record<string, (v: unknown, where: string) => Auth> = {
  basic: (v, w) => parseUserPassword(v, w, "basic"),
  digest: (v, w) => parseUserPassword(v, w, "digest"),
  oauth2_client_credentials: parseOauth2,
  command: parseCommand,
  aws_sigv4: parseSigv4,
};

/** `providers.http.<api>.auth`, checked: PLAN_INVALID naming the key at fault otherwise. */
export function parseAuth(v: unknown, where: string): Auth {
  if (!isObject(v)) throw planError(`is required: ${AUTH_FORMS}`, where);
  const forms = Object.keys(PARSERS).filter((k) => v[k] !== undefined);
  if (forms.length > 1) throw planError(`declares ${forms.join(" and ")}: choose one`, where);
  if (forms.length === 1) {
    const key = forms[0]!;
    const extra = Object.keys(v).find((k) => k !== key);
    if (extra) throw planError(`unknown key \`${extra}\` next to \`${key}\``, where);
    return PARSERS[key]!(v[key], `${where}.${key}`);
  }
  if (v.bearer_env !== undefined) {
    onlyKeys(v, ["bearer_env"], where);
    return { kind: "bearer", env: envName(v.bearer_env, `${where}.bearer_env`, true) };
  }
  if (v.headers !== undefined) return parseHeaderList(v, where);
  const one = headerCredential(v, where);
  return { kind: "header", ...one };
}

/** One `{ header, value_env, prefix? }`. */
function headerCredential(v: Record<string, unknown>, where: string): { header: string; env: string; prefix?: string } {
  if (typeof v.header !== "string" || !HEADER_NAME.test(v.header)) throw planError(`must be one of ${AUTH_FORMS}`, where);
  if (/^(accept|content-type)$/i.test(v.header)) throw planError(`\`${v.header}\` is set by Sponson`, `${where}.header`);
  onlyKeys(v, ["header", "value_env", "prefix"], where);
  const prefix = v.prefix === undefined ? undefined : prefixParam(v.prefix, `${where}.prefix`);
  return { header: v.header, env: envName(v.value_env, `${where}.value_env`, true), ...(prefix !== undefined ? { prefix } : {}) };
}

/** `{ headers: [{ header, value_env, prefix? }, …] }`: every credential header an API needs, each named once. */
function parseHeaderList(v: Record<string, unknown>, where: string): Auth {
  onlyKeys(v, ["headers"], where);
  const list = v.headers;
  if (!Array.isArray(list) || list.length === 0) throw planError("must be a list of `{ header, value_env }`, one per credential header", `${where}.headers`);
  const headers = list.map((h, i) => {
    if (!isObject(h)) throw planError("must be `{ header, value_env, prefix? }`", `${where}.headers[${i}]`);
    return headerCredential(h, `${where}.headers[${i}]`);
  });
  const names = headers.map((h) => h.header.toLowerCase());
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw planError(`names the header \`${twice}\` twice`, `${where}.headers`);
  return { kind: "headers", headers };
}

function onlyKeys(v: Record<string, unknown>, known: string[], where: string): void {
  const extra = Object.keys(v).find((k) => !known.includes(k));
  if (extra) throw planError(`unknown key \`${extra}\` (known: ${known.join(", ")})`, where);
}

/**
 * The literal text sent before the credential in its header (`Api-Key `, `Token `, `SSWS `). It is part of the
 * block, so of the ledger identity, and never a credential: a reference, an interpolation or a control character is
 * refused.
 */
function prefixParam(v: unknown, where: string): string {
  if (typeof v !== "string" || v === "" || v.length > 64) throw planError("must be the literal text sent before the credential, such as \"Api-Key \" or \"Token \" (1 to 64 characters)", where);
  if (!/^[\x20-\x7e]+$/.test(v) || v.includes("${") || v.startsWith("$")) throw planError("must be plain printable text: no reference, interpolation or control character", where);
  return v;
}

// ---------------------------------------------------------------------------
// Run time
// ---------------------------------------------------------------------------

/** What the run-time side depends on, injected in tests: how a command runs, and the clock. */
export interface AuthDeps {
  exec: Exec;
  now: () => number;
}

/** The real dependencies: commands from PATH, the system clock. */
export const DEFAULT_AUTH_DEPS: AuthDeps = { exec: defaultExec, now: () => Date.now() };

/** How a client authenticates: a static header (`token`, `authHeader`) or a signer, and the values to mask. */
export interface Credential {
  token: string;
  authHeader: "bearer" | "none" | `header:${string}`;
  signer?: RequestSigner;
  /** Values this adapter masks in its own error text, besides what the engine masks. */
  masks: () => string[];
}

/** A token obtained at run time, and when to stop using it. */
interface Token {
  value: string;
  expiresAt: number;
}

/** Per-run state of one API block's credential: its token (or Digest challenge), and the request that fetches it. */
interface CacheEntry {
  token?: Token;
  pending?: Promise<Token>;
  digest?: { challenge: DigestChallenge; nc: number };
  /** Every token issued in this run, masked in this adapter's error text until the run ends. */
  issued: string[];
}

/** One cache per run (the engine hands every adapter call of a run the same `ctx`), so nothing outlives the run. */
const RUNS = new WeakMap<Ctx, Map<string, CacheEntry>>();

function entryFor(actx: AdapterContext, auth: Auth, extra: string): CacheEntry {
  let run = RUNS.get(actx.ctx);
  if (!run) RUNS.set(actx.ctx, (run = new Map()));
  // The block identifies the API; the hash of the credential's inputs keeps a changed credential from reusing a token.
  const key = createHash("sha256").update(canonicalJson({ block: actx.provider, auth })).update("\u0000").update(extra).digest("hex");
  let e = run.get(key);
  if (!e) run.set(key, (e = { issued: [] }));
  return e;
}

/** Remember a token: registered with the engine's redactor first, so no output can ever contain it. */
function adopt(actx: AdapterContext, entry: CacheEntry, token: Token): Token {
  actx.secret?.(token.value);
  entry.issued.push(token.value);
  entry.token = token;
  return token;
}

/** The cached token, or a new one from `fetch` (one fetch at a time per API block, however many requests wait). */
async function tokenOf(actx: AdapterContext, entry: CacheEntry, deps: AuthDeps, fetch: () => Promise<Token>): Promise<string> {
  if (entry.token && entry.token.expiresAt > deps.now()) return entry.token.value;
  entry.pending ??= fetch()
    .then((t) => adopt(actx, entry, t))
    .finally(() => {
      entry.pending = undefined;
    });
  return (await entry.pending).value;
}

/** A signer that sends `Authorization: Bearer <token>` and fetches the token again, once per request, after a 401. */
function bearerSigner(actx: AdapterContext, entry: CacheEntry, deps: AuthDeps, fetch: () => Promise<Token>): RequestSigner {
  return {
    sign: async () => ({ authorization: `Bearer ${await tokenOf(actx, entry, deps, fetch)}` }),
    unauthorized: async (req) => {
      // Drop the token this request carried (not one another request has fetched since), then try once more.
      if (entry.token && req.headers.authorization === `Bearer ${entry.token.value}`) entry.token = undefined;
      return true;
    },
  };
}

/** Seconds of validity a token loses, so it is never sent in its last minute. */
const EXPIRY_MARGIN_S = 60;
/** How long a command's token is used before the command runs again (CLIs print tokens valid for 5–60 minutes). */
export const COMMAND_TOKEN_TTL_MS = 5 * 60_000;

function authError(message: string, details: Record<string, unknown> = {}): SponsonError {
  return new SponsonError("PROVIDER_AUTH", `${ADAPTER}: ${message}`, { adapter: ADAPTER, ...details });
}

/** The answer of a token endpoint: an access token of type Bearer, and when it expires. */
function tokenShape(body: unknown): { access_token: string; expires_in?: number } {
  if (!isObject(body) || typeof body.access_token !== "string" || body.access_token === "") throw new ShapeError("expected an object with a non-empty `access_token`");
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") throw new ShapeError(`expected \`token_type\` Bearer, got ${String(body.token_type)}`);
  const expires = Number(body.expires_in);
  return { access_token: body.access_token, ...(Number.isFinite(expires) && expires > 0 ? { expires_in: expires } : {}) };
}

function basicOf(user: string, password: string): string {
  return Buffer.from(`${user}:${password}`).toString("base64");
}

/** RFC 6749 §4.4: POST the client credentials as a form to the token endpoint. */
async function fetchOauth2(actx: AdapterContext, auth: Extract<Auth, { kind: "oauth2" }>, deps: AuthDeps, redact: (t: string) => string): Promise<Token> {
  const clientId = requireEnv(actx.env, auth.clientIdEnv, ADAPTER);
  const secret = requireEnv(actx.env, auth.clientSecretEnv, ADAPTER);
  const url = (auth.tokenUrlEnv ? optionalEnv(actx.env, auth.tokenUrlEnv) : undefined) ?? auth.tokenUrl;
  const basic = auth.method === "client_secret_basic" ? basicOf(clientId, secret) : undefined;
  const hidden = [secret, ...(basic ? [basic] : [])];
  const form = {
    grant_type: "client_credentials",
    ...(basic ? {} : { client_id: clientId, client_secret: secret }),
    ...(auth.audience !== undefined ? { audience: auth.audience } : {}),
    ...(auth.scope !== undefined ? { scope: auth.scope } : {}),
    ...auth.extra,
  };
  const client = apiClient({
    adapter: ADAPTER,
    baseUrl: url,
    token: basic ? `Basic ${basic}` : "",
    authHeader: "header:authorization",
    ...(basic ? {} : { signer: { sign: async () => ({}) } }),
    encoding: "form",
    redact: (t) => hidden.reduce((s, h) => s.split(h).join("****"), redact(t)),
    env: actx.env,
  });
  let body: { access_token: string; expires_in?: number };
  try {
    body = await client.post("", form, tokenShape, { idempotent: true });
  } catch (e) {
    if (e instanceof SponsonError) throw new SponsonError(e.code, `${ADAPTER}: OAuth2 token request to ${new URL(url).origin}${new URL(url).pathname} failed: ${e.message.replace(/^http: POST {2}→ /, "")}`, { ...e.details, tokenUrl: url });
    throw e;
  }
  const lifetime = body.expires_in === undefined ? Infinity : Math.max(body.expires_in - EXPIRY_MARGIN_S, body.expires_in / 2) * 1000;
  return { value: body.access_token, expiresAt: deps.now() + lifetime };
}

/** Run the command (no shell) and take its stdout, trimmed, as the token. */
async function fetchCommand(actx: AdapterContext, argv: string[], deps: AuthDeps, redact: (t: string) => string): Promise<Token> {
  const [file, ...args] = argv as [string, ...string[]];
  const shown = argv.join(" ");
  let out: string;
  try {
    out = await deps.exec(file, args, actx.env);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw authError(`\`${file}\` is not installed or not on PATH (auth.command)`, { command: shown });
    if (code === "EACCES") throw authError(`\`${file}\` on PATH is not executable (auth.command)`, { command: shown });
    throw authError(`\`${shown}\` failed: ${redact((e as Error).message).slice(0, 500)}`, { command: shown });
  }
  const token = out.trim();
  if (token === "" || /\s/.test(token)) throw authError(`\`${shown}\` printed ${token === "" ? "nothing" : "more than one word"}; it must print the access token alone`, { command: shown });
  return { value: token, expiresAt: deps.now() + COMMAND_TOKEN_TTL_MS };
}

/** Signs every request with SigV4; S3 also gets the `Content-MD5` its configuration writes require. */
function sigv4Signer(actx: AdapterContext, auth: Extract<Auth, { kind: "sigv4" }>, deps: AuthDeps): RequestSigner {
  const creds = {
    accessKeyId: requireEnv(actx.env, auth.accessKeyIdEnv, ADAPTER),
    secretAccessKey: requireEnv(actx.env, auth.secretAccessKeyEnv, ADAPTER),
    ...(auth.sessionTokenEnv ? { sessionToken: requireEnv(actx.env, auth.sessionTokenEnv, ADAPTER) } : {}),
  };
  return {
    async sign(req: SignableRequest) {
      const extra: Record<string, string> = {};
      if (auth.service === "s3" && req.body !== undefined) extra["content-md5"] = createHash("md5").update(req.body, "utf8").digest("base64");
      const signed = signRequest({ method: req.method, url: req.url, headers: { ...req.headers, ...extra }, body: req.body ?? "" }, creds, { region: auth.region, service: auth.service, date: new Date(deps.now()) });
      return { ...extra, ...signed };
    },
  };
}

/** Answers the server's Digest challenge; later requests of the run reuse it with the next nonce count. */
function digestSigner(actx: AdapterContext, auth: Extract<Auth, { kind: "digest" }>, entry: CacheEntry): RequestSigner {
  const username = requireEnv(actx.env, auth.userEnv, ADAPTER);
  const password = requireEnv(actx.env, auth.passwordEnv, ADAPTER);
  return {
    async sign(req): Promise<Record<string, string>> {
      const d = entry.digest;
      if (!d) return {}; // the first request goes without: the 401 brings the challenge
      d.nc += 1;
      const u = new URL(req.url);
      return { authorization: digestAuthorization({ challenge: d.challenge, username, password, method: req.method, uri: u.pathname + u.search, nc: d.nc }) };
    },
    async unauthorized(_req, header) {
      const picked = pickChallenge(header);
      if ("problem" in picked) throw authError(`Digest authentication: ${picked.problem}`);
      entry.digest = { challenge: picked, nc: 0 };
      return true;
    },
  };
}

/** A line's own credential in the place of a bearer or header form's variable (the header name and prefix stay). */
function lineCredential(auth: Auth, line: string): Credential {
  if (auth.kind === "bearer") return { token: line, authHeader: "bearer", masks: () => [] };
  if (auth.kind === "header") return { token: `${auth.prefix ?? ""}${line}`, authHeader: `header:${auth.header}`, masks: () => [] };
  throw authError(`a line's \`credential\` replaces a single static credential; this API authenticates with \`${auth.kind}\``);
}

/**
 * The credential of an API block for this call; `line`, a line's own `credential`, replaces the variable of a bearer
 * or header form (ADR 0017, "Line credentials"). Static forms read their variables now (PROVIDER_AUTH when one is
 * unset); dynamic ones fetch or sign per request, through the run's cache.
 */
export function credentialFor(actx: AdapterContext, auth: Auth, deps: AuthDeps, redact: (t: string) => string, line?: string): Credential {
  if (line !== undefined) return lineCredential(auth, line);
  const env = actx.env;
  switch (auth.kind) {
    case "bearer":
      return { token: requireEnv(env, auth.env, ADAPTER), authHeader: "bearer", masks: () => [] };
    case "header":
      return { token: `${auth.prefix ?? ""}${requireEnv(env, auth.env, ADAPTER)}`, authHeader: `header:${auth.header}`, masks: () => [] };
    case "headers": {
      const values = Object.fromEntries(auth.headers.map((h) => [h.header.toLowerCase(), `${h.prefix ?? ""}${requireEnv(env, h.env, ADAPTER)}`]));
      return { token: "", authHeader: "none", signer: { sign: async () => ({ ...values }) }, masks: () => Object.values(values) };
    }
    case "none":
      return { token: "", authHeader: "none", masks: () => [] };
    case "basic": {
      const encoded = basicOf(requireEnv(env, auth.userEnv, ADAPTER), requireEnv(env, auth.passwordEnv, ADAPTER));
      return { token: `Basic ${encoded}`, authHeader: "header:authorization", masks: () => [encoded] };
    }
    case "oauth2": {
      const entry = entryFor(actx, auth, `${optionalEnv(env, auth.clientIdEnv) ?? ""}\u0000${optionalEnv(env, auth.clientSecretEnv) ?? ""}`);
      return { token: "", authHeader: "bearer", signer: bearerSigner(actx, entry, deps, () => fetchOauth2(actx, auth, deps, redact)), masks: () => entry.issued };
    }
    case "command": {
      const entry = entryFor(actx, auth, "");
      return { token: "", authHeader: "bearer", signer: bearerSigner(actx, entry, deps, () => fetchCommand(actx, auth.argv, deps, redact)), masks: () => entry.issued };
    }
    case "sigv4":
      return { token: "", authHeader: "bearer", signer: sigv4Signer(actx, auth, deps), masks: () => [] };
    case "digest":
      return { token: "", authHeader: "bearer", signer: digestSigner(actx, auth, entryFor(actx, auth, "")), masks: () => [] };
  }
}
