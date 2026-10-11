/**
 * AWS Signature Version 4 (header form), without an AWS SDK: the canonical request, the string to sign, the
 * signing key and the `Authorization` header, as specified in
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html and checked against
 * AWS's published test suite (sigv4.test.ts). Pure: the clock is a parameter.
 *
 * The generic `http` adapter signs every request of an API block that declares `auth: { aws_sigv4: … }` with it
 * (http-adapter-auth.ts). Not supported: chunked (streaming) payloads, presigned URLs, SigV4a.
 */
import { createHash, createHmac } from "node:crypto";

/** The credentials a request is signed with. The secret never leaves this module except as an HMAC. */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (STS) also send their session token, as `X-Amz-Security-Token`. */
  sessionToken?: string;
}

/** One request to sign: everything the signature covers. */
export interface SigV4Request {
  method: string;
  /** The absolute URL as it will be sent (path already percent-encoded, query included). */
  url: string;
  /** Headers that will be sent (lower-case names); every one of them is signed. */
  headers: Record<string, string>;
  /** The body exactly as sent; empty when there is none. */
  body: string;
}

/** Where and how to sign. */
export interface SigV4Scope {
  region: string;
  service: string;
  /** The signing time; `X-Amz-Date` is derived from it. */
  date: Date;
  /**
   * Send and sign `X-Amz-Content-Sha256` (S3 requires it; other services accept it). Default true; AWS's generic
   * test suite signs without it.
   */
  contentSha256Header?: boolean;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256Hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding as SigV4 wants it: unreserved characters as they are, every other UTF-8 byte as `%XX`. */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The canonical URI: each path segment encoded once (S3) or twice (every other service, as the AWS docs require),
 * starting from the path as sent.
 */
export function canonicalUri(pathname: string, service: string): string {
  if (pathname === "" || pathname === "/") return "/";
  const twice = service !== "s3";
  return pathname
    .split("/")
    .map((seg) => {
      const once = uriEncode(safeDecode(seg));
      return twice ? uriEncode(once) : once;
    })
    .join("/");
}

/** The canonical query string: every parameter encoded, sorted by name then value; `?cors` is `cors=`. */
export function canonicalQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return "";
  const pairs = raw
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const eq = p.indexOf("=");
      const k = eq < 0 ? p : p.slice(0, eq);
      const v = eq < 0 ? "" : p.slice(eq + 1);
      return [uriEncode(safeDecode(k)), uriEncode(safeDecode(v))] as const;
    });
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** `YYYYMMDDTHHMMSSZ` */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The headers SigV4 adds before signing: date, host-independent payload hash and session token. */
function signingHeaders(req: SigV4Request, creds: SigV4Credentials, scope: SigV4Scope): Record<string, string> {
  const out: Record<string, string> = { "x-amz-date": amzDate(scope.date) };
  if (scope.contentSha256Header !== false) out["x-amz-content-sha256"] = sha256Hex(req.body);
  if (creds.sessionToken) out["x-amz-security-token"] = creds.sessionToken;
  return out;
}

/** Canonical headers and the signed-headers list: names lower-cased and sorted, values trimmed, runs of spaces collapsed. */
function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(""), signed: entries.map(([k]) => k).join(";") };
}

/** The canonical request, and the signed-headers list it names. `headers` must include `host`. */
export function canonicalRequest(req: SigV4Request, service: string): { request: string; signedHeaders: string } {
  const u = new URL(req.url);
  const { canonical, signed } = canonicalHeaders(req.headers);
  const payload = req.headers["x-amz-content-sha256"] ?? sha256Hex(req.body);
  return { request: [req.method.toUpperCase(), canonicalUri(u.pathname, service), canonicalQuery(u.search), canonical, signed, payload].join("\n"), signedHeaders: signed };
}

/** `<date>/<region>/<service>/aws4_request` */
export function credentialScope(scope: Pick<SigV4Scope, "region" | "service" | "date">): string {
  return `${amzDate(scope.date).slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
}

/** The string to sign for a canonical request. */
export function stringToSign(canonical: string, scope: Pick<SigV4Scope, "region" | "service" | "date">): string {
  return [ALGORITHM, amzDate(scope.date), credentialScope(scope), sha256Hex(canonical)].join("\n");
}

/** The hex signature of a string to sign. */
export function signature(secretAccessKey: string, scope: Pick<SigV4Scope, "region" | "service" | "date">, toSign: string): string {
  const day = amzDate(scope.date).slice(0, 8);
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), scope.region), scope.service), "aws4_request");
  return createHmac("sha256", key).update(toSign, "utf8").digest("hex");
}

/**
 * Sign a request: the headers to add to it (`x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token` when the
 * credentials are temporary, and `authorization`). Every header of `req` is signed, plus `host` from the URL.
 */
export function signRequest(req: SigV4Request, creds: SigV4Credentials, scope: SigV4Scope): Record<string, string> {
  const added = signingHeaders(req, creds, scope);
  const headers = { ...lowerKeys(req.headers), ...added, host: new URL(req.url).host };
  const { request, signedHeaders } = canonicalRequest({ ...req, headers }, scope.service);
  const sig = signature(creds.secretAccessKey, scope, stringToSign(request, scope));
  return { ...added, authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope(scope)}, SignedHeaders=${signedHeaders}, Signature=${sig}` };
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => k.toLowerCase() !== "authorization").map(([k, v]) => [k.toLowerCase(), v]));
}
