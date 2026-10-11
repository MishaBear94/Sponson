/**
 * Credential checks a simulated provider can configure, server side: an OAuth2 client-credentials token endpoint,
 * HTTP Digest challenges (RFC 7616), and AWS Signature Version 4 verification. They are written here from the
 * specifications, independently of the client code in @sponson/adapters (the sim depends on nothing in the repo),
 * and both sides are checked against the same published vectors (AWS's SigV4 test suite, RFC 7616 §3.9.1); a
 * client bug therefore fails against the sim instead of being mirrored by it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { Reply, type AuthRequest } from "./provider.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

/** What a SigV4 signature must be made with: the access keys the "account" has, and the expected scope. */
export interface SigV4Config {
  /** Access key id → secret access key. */
  keys: Record<string, string>;
  region: string;
  /** The signing name the request's path belongs to (`s3`, `amplify`). */
  service: string;
  /** The clock, for the 15-minute skew AWS allows. */
  now?: () => number;
}

/** RFC 3986 percent-encoding of every byte but the unreserved characters, upper-case hex. */
function awsEncode(s: string): string {
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Canonical URI from the request target: segments encoded once for S3, twice for every other service. */
function sigv4Uri(path: string, service: string): string {
  if (path === "" || path === "/") return "/";
  return path
    .split("/")
    .map((seg) => (service === "s3" ? awsEncode(decoded(seg)) : awsEncode(awsEncode(decoded(seg)))))
    .join("/");
}

function sigv4Query(query: string): string {
  if (query === "") return "";
  return query
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const i = p.indexOf("=");
      return [awsEncode(decoded(i < 0 ? p : p.slice(0, i))), awsEncode(decoded(i < 0 ? "" : p.slice(i + 1)))];
    })
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** The parts of a SigV4 `Authorization` header. */
function parseSigV4(value: string): { key: string; date: string; region: string; service: string; signed: string[]; signature: string } | null {
  const m = /^AWS4-HMAC-SHA256\s+Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/([^/,\s]+)\/aws4_request,\s*SignedHeaders=([a-z0-9;-]+),\s*Signature=([0-9a-f]{64})$/.exec(value.trim());
  return m ? { key: m[1]!, date: m[2]!, region: m[3]!, service: m[4]!, signed: m[5]!.split(";"), signature: m[6]! } : null;
}

/** The signature AWS would compute for this request with `secret` (exported for the sim's own tests). */
export function expectedSigV4(req: AuthRequest, headers: IncomingHttpHeaders, secret: string, scope: { date: string; region: string; service: string; signed: string[]; amzDate: string }): string {
  const q = req.target.indexOf("?");
  const path = q < 0 ? req.target : req.target.slice(0, q);
  const query = q < 0 ? "" : req.target.slice(q + 1);
  const canonicalHeaders = scope.signed.map((h) => `${h}:${(header(headers, h) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const payload = header(headers, "x-amz-content-sha256") ?? sha256Hex(req.raw);
  const canonical = [req.method, sigv4Uri(path, scope.service), sigv4Query(query), canonicalHeaders, scope.signed.join(";"), payload].join("\n");
  const credentialScope = `${scope.date}/${scope.region}/${scope.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", scope.amzDate, credentialScope, sha256Hex(canonical)].join("\n");
  let key: Buffer | string = `AWS4${secret}`;
  for (const part of [scope.date, scope.region, scope.service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex");
}

/** X-Amz-Date must be there, match the credential scope's day and be within the 15 minutes AWS allows. */
function amzDateProblem(amzDate: string, day: string, now: () => number): string | null {
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== day) return "X-Amz-Date is missing or does not match the credential scope";
  const at = Date.UTC(+amzDate.slice(0, 4), +amzDate.slice(4, 6) - 1, +amzDate.slice(6, 8), +amzDate.slice(9, 11), +amzDate.slice(11, 13), +amzDate.slice(13, 15));
  return Math.abs(at - now()) > 15 * 60_000 ? "RequestTimeTooSkewed" : null;
}

/** Why a SigV4 request is refused, or null when its signature is valid for `config`. */
export function sigV4Problem(headers: IncomingHttpHeaders, req: AuthRequest, config: SigV4Config): string | null {
  const auth = parseSigV4(header(headers, "authorization") ?? "");
  if (!auth) return "missing or malformed AWS4-HMAC-SHA256 Authorization header";
  const secret = config.keys[auth.key];
  if (secret === undefined) return "InvalidAccessKeyId";
  if (auth.region !== config.region || auth.service !== config.service) return `credential scope ${auth.region}/${auth.service} is not ${config.region}/${config.service}`;
  const amzDate = header(headers, "x-amz-date") ?? "";
  const dateProblem = amzDateProblem(amzDate, auth.date, config.now ?? Date.now);
  if (dateProblem) return dateProblem;
  if (!auth.signed.includes("host") || !auth.signed.includes("x-amz-date")) return "SignedHeaders must include host and x-amz-date";
  const claimed = header(headers, "x-amz-content-sha256");
  if (claimed !== undefined && claimed !== sha256Hex(req.raw)) return "XAmzContentSHA256Mismatch";
  const expected = expectedSigV4(req, headers, secret, { date: auth.date, region: auth.region, service: auth.service, signed: auth.signed, amzDate });
  return sameText(expected, auth.signature) ? null : "SignatureDoesNotMatch";
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** Digest users and the challenge the sim issues. */
export interface DigestConfig {
  users: Record<string, string>;
  algorithm?: "MD5" | "SHA-256";
  realm?: string;
}

/** Server-side Digest state: the nonces handed out. */
export interface DigestState {
  nonces: string[];
}

const DEFAULT_REALM = "Sponson Sim API";

function digestParams(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of value.replace(/^Digest\s+/i, "").matchAll(/([a-z0-9-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) out[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]!;
  return out;
}

/** A 401 carrying a fresh Digest challenge. */
export function digestChallenge(config: DigestConfig, state: DigestState, n: number, stale = false): Reply {
  const nonce = `sim-nonce-${n}-${createHash("sha256").update(String(n)).digest("hex").slice(0, 16)}`;
  state.nonces.push(nonce);
  const challenge = `Digest realm="${config.realm ?? DEFAULT_REALM}", domain="", nonce="${nonce}", algorithm=${config.algorithm ?? "MD5"}, qop="auth", stale=${stale ? "TRUE" : "FALSE"}`;
  return new Reply(401, { error: "unauthorized", detail: "Digest authentication required" }, { "www-authenticate": challenge });
}

/** What is wrong with a Digest answer's parameters, before its response is checked. */
function digestFormProblem(p: Record<string, string>, req: AuthRequest, algorithm: string, state: DigestState): string | null {
  if (!p.nonce || !state.nonces.includes(p.nonce)) return "unknown nonce";
  if (p.qop !== "auth" || !/^[0-9a-f]{8}$/.test(p.nc ?? "") || !p.cnonce) return "qop=auth with nc and cnonce is required";
  if ((p.algorithm ?? "MD5").toUpperCase() !== algorithm) return "wrong algorithm";
  if (p.uri !== req.target) return "uri does not match the request";
  return null;
}

/** Why a Digest `Authorization` does not authenticate this request, or null when it does. */
export function digestProblem(headers: IncomingHttpHeaders, req: AuthRequest, config: DigestConfig, state: DigestState): string | null {
  const value = header(headers, "authorization") ?? "";
  if (!/^Digest\s/i.test(value)) return "no Digest credentials";
  const p = digestParams(value);
  const algorithm = config.algorithm ?? "MD5";
  const password = p.username === undefined ? undefined : config.users[p.username];
  if (password === undefined) return "unknown user";
  const problem = digestFormProblem(p, req, algorithm, state);
  if (problem) return problem;
  const h = (s: string) => createHash(algorithm === "MD5" ? "md5" : "sha256").update(s, "utf8").digest("hex");
  const ha1 = h(`${p.username}:${config.realm ?? DEFAULT_REALM}:${password}`);
  const ha2 = h(`${req.method}:${p.uri}`);
  const expected = h(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`);
  return sameText(expected, p.response ?? "") ? null : "wrong response";
}

// ---------------------------------------------------------------------------
// OAuth2 client credentials
// ---------------------------------------------------------------------------

/** A token the sim's token endpoint issued. */
export interface IssuedToken {
  token: string;
  client: string;
  /** How the client authenticated to the token endpoint. */
  method: "client_secret_basic" | "client_secret_post";
  audience?: string;
  scope?: string;
  expiresAt: number;
  revoked?: true;
}

/** OAuth2 clients and the tokens issued to them. */
export interface OAuthState {
  clients: Record<string, string>;
  ttlSeconds: number;
  issued: IssuedToken[];
}

function form(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
}

function oauthError(status: number, error: string, description: string): Reply {
  return new Reply(status, { error, error_description: description });
}

/** The client a token request authenticates as (Basic or form, never both); the refusal otherwise. */
function clientOf(state: OAuthState, headers: Record<string, string>, f: Record<string, string>): { client: string; basic: boolean } | Reply {
  const basic = /^Basic\s+(\S+)$/i.exec(headers.authorization ?? "");
  if (basic && (f.client_id !== undefined || f.client_secret !== undefined)) return oauthError(400, "invalid_request", "client authenticated twice");
  const [client, secret] = basic ? Buffer.from(basic[1]!, "base64").toString("utf8").split(/:(.*)/s) : [f.client_id, f.client_secret];
  const expected = client === undefined ? undefined : state.clients[client];
  if (!client || secret === undefined || expected === undefined || !sameText(expected, secret)) return oauthError(401, "invalid_client", "client authentication failed");
  return { client, basic: basic !== null };
}

/**
 * RFC 6749 §4.4 at a token endpoint: `grant_type=client_credentials`, the client authenticated by HTTP Basic
 * (`client_secret_basic`) or by `client_id`/`client_secret` in the form (`client_secret_post`), never both.
 */
export function issueToken(state: OAuthState, headers: Record<string, string>, body: unknown, now = Date.now()): Reply {
  const f = form(body);
  if (f.grant_type !== "client_credentials") return oauthError(400, "unsupported_grant_type", "only client_credentials is supported");
  const who = clientOf(state, headers, f);
  if (who instanceof Reply) return who;
  const { client, basic } = who;
  const token = `oauth-access-token-${state.issued.length + 1}`;
  state.issued.push({ token, client, method: basic ? "client_secret_basic" : "client_secret_post", ...(f.audience ? { audience: f.audience } : {}), ...(f.scope ? { scope: f.scope } : {}), expiresAt: now + state.ttlSeconds * 1000 });
  return new Reply(200, { access_token: token, token_type: "Bearer", expires_in: state.ttlSeconds, ...(f.scope ? { scope: f.scope } : {}) });
}

/** True when the bearer token was issued by the endpoint, is not revoked and has not expired. */
export function tokenValid(state: OAuthState, token: string, now = Date.now()): boolean {
  return state.issued.some((t) => t.token === token && !t.revoked && t.expiresAt > now);
}
