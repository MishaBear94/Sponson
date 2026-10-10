/**
 * HTTP Digest access authentication (RFC 7616), client side: parse a `WWW-Authenticate` challenge and compute the
 * `Authorization` answer. MD5 and SHA-256 (and their `-sess` variants), `qop=auth` only: `auth-int` (a hash of the
 * body) and the legacy no-qop form of RFC 2069 are refused, as is `userhash`. Pure: the client nonce is a
 * parameter. Checked against the worked example of RFC 7616 §3.9.1 (digest.test.ts).
 *
 * Used by the generic `http` adapter for `auth: { digest: … }` (MongoDB Atlas Admin API keys).
 */
import { createHash, randomBytes } from "node:crypto";

/** The hash algorithms supported, as a challenge names them. */
export type DigestAlgorithm = "MD5" | "MD5-sess" | "SHA-256" | "SHA-256-sess";

/** One `Digest` challenge of a `WWW-Authenticate` header. */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm: DigestAlgorithm;
  /** The `qop` values the server offers. */
  qop: string[];
  /** The previous nonce was merely stale: retry with the new one, the credentials were fine. */
  stale: boolean;
}

/** One auth scheme and its parameters, as written in a `WWW-Authenticate` header. */
interface RawChallenge {
  scheme: string;
  params: Record<string, string>;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/;

/** A quoted-string at `s[i]` (which is `"`): its unescaped value and the index after the closing quote. */
function quoted(s: string, i: number): { value: string; end: number } {
  let value = "";
  let j = i + 1;
  while (j < s.length && s[j] !== '"') {
    if (s[j] === "\\" && j + 1 < s.length) j++;
    value += s[j];
    j++;
  }
  return { value, end: j + 1 };
}

/** Skip spaces and commas. */
function skipSeparators(s: string, i: number): number {
  while (i < s.length && /[\s,]/.test(s[i]!)) i++;
  return i;
}

/** One `name=value` (token or quoted-string) at `i`, or null when what is there is not a parameter (a new scheme). */
function param(s: string, i: number): { name: string; value: string; end: number } | null {
  const name = TOKEN.exec(s.slice(i))?.[0];
  if (!name) return null;
  let j = i + name.length;
  while (s[j] === " ") j++;
  if (s[j] !== "=") return null;
  j++;
  while (s[j] === " ") j++;
  if (s[j] === '"') {
    const q = quoted(s, j);
    return { name: name.toLowerCase(), value: q.value, end: q.end };
  }
  const value = TOKEN.exec(s.slice(j))?.[0] ?? "";
  return { name: name.toLowerCase(), value, end: j + value.length };
}

/** Every challenge in a `WWW-Authenticate` value (several headers arrive joined with `, `). */
export function parseChallenges(header: string): RawChallenge[] {
  const out: RawChallenge[] = [];
  let i = skipSeparators(header, 0);
  while (i < header.length) {
    const scheme = TOKEN.exec(header.slice(i))?.[0];
    if (!scheme) break;
    const challenge: RawChallenge = { scheme: scheme.toLowerCase(), params: {} };
    out.push(challenge);
    i = skipSeparators(header, i + scheme.length);
    for (let p = param(header, i); p; p = param(header, i)) {
      challenge.params[p.name] = p.value;
      i = skipSeparators(header, p.end);
    }
  }
  return out;
}

const ALGORITHMS: Record<string, DigestAlgorithm> = { "md5": "MD5", "md5-sess": "MD5-sess", "sha-256": "SHA-256", "sha-256-sess": "SHA-256-sess" };

function toDigest(c: RawChallenge): DigestChallenge | null {
  const algorithm = ALGORITHMS[(c.params.algorithm ?? "MD5").toLowerCase()];
  const { realm, nonce } = c.params;
  if (c.scheme !== "digest" || !algorithm || realm === undefined || !nonce) return null;
  const qop = (c.params.qop ?? "").split(",").map((q) => q.trim().toLowerCase()).filter((q) => q !== "");
  return { realm, nonce, algorithm, qop, stale: (c.params.stale ?? "").toLowerCase() === "true", ...(c.params.opaque !== undefined ? { opaque: c.params.opaque } : {}) };
}

/**
 * The challenge to answer: a Digest one offering `qop=auth`, SHA-256 preferred over MD5. A reason when there is
 * none Sponson can answer.
 */
export function pickChallenge(header: string | null): DigestChallenge | { problem: string } {
  if (!header) return { problem: "the 401 carries no WWW-Authenticate challenge" };
  const digests = parseChallenges(header).map(toDigest).filter((c): c is DigestChallenge => c !== null);
  if (digests.length === 0) return { problem: "the server offers no Digest challenge with an MD5 or SHA-256 algorithm" };
  const usable = digests.filter((c) => c.qop.includes("auth"));
  if (usable.length === 0) return { problem: "the server's Digest challenge does not offer qop=auth (auth-int and RFC 2069 digests are not supported)" };
  return usable.find((c) => c.algorithm.startsWith("SHA-256")) ?? usable[0]!;
}

function hash(algorithm: DigestAlgorithm, s: string): string {
  return createHash(algorithm.startsWith("SHA-256") ? "sha256" : "md5").update(s, "utf8").digest("hex");
}

/** What an answer is computed from. `nc` counts the requests made with this nonce (1, 2, …). */
export interface DigestInput {
  challenge: DigestChallenge;
  username: string;
  password: string;
  method: string;
  /** The request target as sent: path and query. */
  uri: string;
  nc: number;
  /** The client nonce; random when absent. */
  cnonce?: string;
}

/** The `response` value of RFC 7616 §3.4.1 for `qop=auth`. */
export function digestResponse(input: DigestInput & { cnonce: string }): string {
  const { challenge: c, username, password, method, uri, cnonce } = input;
  const nc = ncOf(input.nc);
  let ha1 = hash(c.algorithm, `${username}:${c.realm}:${password}`);
  if (c.algorithm.endsWith("-sess")) ha1 = hash(c.algorithm, `${ha1}:${c.nonce}:${cnonce}`);
  const ha2 = hash(c.algorithm, `${method.toUpperCase()}:${uri}`);
  return hash(c.algorithm, `${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`);
}

function ncOf(n: number): string {
  return n.toString(16).padStart(8, "0");
}

function quote(s: string): string {
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

/** The `Authorization` header value answering `challenge`. */
export function digestAuthorization(input: DigestInput): string {
  const cnonce = input.cnonce ?? randomBytes(16).toString("hex");
  const c = input.challenge;
  const response = digestResponse({ ...input, cnonce });
  const parts = [
    `username=${quote(input.username)}`,
    `realm=${quote(c.realm)}`,
    `uri=${quote(input.uri)}`,
    `algorithm=${c.algorithm}`,
    `nonce=${quote(c.nonce)}`,
    `nc=${ncOf(input.nc)}`,
    `cnonce=${quote(cnonce)}`,
    "qop=auth",
    `response=${quote(response)}`,
    ...(c.opaque !== undefined ? [`opaque=${quote(c.opaque)}`] : []),
  ];
  return `Digest ${parts.join(", ")}`;
}
