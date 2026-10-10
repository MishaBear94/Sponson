/**
 * The one HTTP layer every adapter uses: timeout, retry policy, failure classification, response-shape checks and
 * pagination. Adapters never see a raw fetch error or a non-2xx status; they see a SponsonError with a PROVIDER_*
 * code, so "already exists" (→ re-read and claim), "gone" (→ fine on delete) and "try later" are decided here once.
 *
 * Part of the stable adapter authoring API (see packages/adapters/src/index.ts): ApiClient, Page, Shape,
 * ShapeError, isObject, obj, records, listAll, withQuery, isProviderError. The rest may change.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, isSponsonError, type ErrorCode } from "@sponson/core";

/** Longest response excerpt an error carries. Error pages can be megabytes; receipts and PR comments must not. */
export const HTTP_ERROR_BODY_LIMIT = 500;
/** Per-request timeout unless SPONSON_HTTP_TIMEOUT_MS says otherwise. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Retries of a retryable failure unless SPONSON_HTTP_RETRIES says otherwise. */
export const DEFAULT_RETRIES = 4;
/** First backoff step (doubling, jittered) unless SPONSON_HTTP_RETRY_BASE_MS says otherwise. */
export const DEFAULT_RETRY_BASE_MS = 500;
/** No single wait is longer than this, whatever Retry-After says. */
export const MAX_RETRY_WAIT_MS = 30_000;

/** The error codes the HTTP client classifies provider failures into; match on them with `isProviderError`. */
export type ProviderErrorCode = Extract<ErrorCode, `PROVIDER_${string}`>;

/** Details carried by every provider error. Never the request body. */
export interface ProviderErrorDetails {
  adapter: string;
  method: string;
  path: string;
  /** HTTP status, when a response arrived. */
  status?: number;
  [k: string]: unknown;
}

/**
 * True when `e` is a provider failure, optionally of the given code(s). Adapters use it to branch on "already
 * exists" or "not found" instead of reading HTTP statuses. Stable authoring API.
 */
export function isProviderError(e: unknown, code?: ProviderErrorCode | ProviderErrorCode[]): e is SponsonError & { details: ProviderErrorDetails } {
  if (!isSponsonError(e) || !e.code.startsWith("PROVIDER_")) return false;
  if (code === undefined) return true;
  return Array.isArray(code) ? code.includes(e.code as ProviderErrorCode) : e.code === code;
}

/** Errors that say "not now" rather than "no": a later poll or run may succeed. */
export function isTransient(e: unknown): boolean {
  return isProviderError(e, ["PROVIDER_TRANSIENT", "PROVIDER_TIMEOUT"]);
}

/**
 * Options for `apiClient`. Adapters get one through `clientFor`, which fills `redact` and `env` from the adapter
 * context.
 */
export interface ApiClientOptions {
  /** Adapter name, for messages and error details. */
  adapter: string;
  baseUrl: string;
  token: string;
  /** `bearer` sends `Authorization: Bearer <token>`; `header:<name>` sends the token in a custom header. */
  authHeader?: "bearer" | `header:${string}`;
  /** Masks known secrets; applied to provider text before it is truncated into an error message. */
  redact: (text: string) => string;
  /** Source of SPONSON_HTTP_TIMEOUT_MS / SPONSON_HTTP_RETRIES / SPONSON_HTTP_RETRY_BASE_MS. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Validates a parsed response body and returns it typed. Throw `ShapeError` (or return via the `shape` helpers)
 * when it is not what the adapter consumes; the client turns that into PROVIDER_RESPONSE naming the endpoint.
 * Stable authoring API.
 */
export type Shape<T> = (body: unknown) => T;

/**
 * Thrown by a `Shape` when a response body is not what the adapter expects; the client reports it as
 * PROVIDER_RESPONSE. Stable authoring API.
 */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapeError";
  }
}

/**
 * A JSON client bound to one provider: retries, timeouts and error classification are built in. Get one from
 * `clientFor`. Stable authoring API.
 */
export interface ApiClient {
  readonly adapter: string;
  get<T = unknown>(path: string, shape?: Shape<T>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, shape?: Shape<T>, opts?: WriteOptions): Promise<T>;
  /** PUT replaces the target, so it is retried after a 502/503/504 or a dropped connection like GET. */
  put<T = unknown>(path: string, body?: unknown, shape?: Shape<T>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, shape?: Shape<T>, opts?: WriteOptions): Promise<T>;
  delete<T = unknown>(path: string, shape?: Shape<T>): Promise<T>;
}

/** Options for a POST or PATCH. Stable authoring API. */
export interface WriteOptions {
  /**
   * The request may safely be sent twice: it sets state rather than adding to it (a PATCH that replaces a whole
   * list, a POST with an idempotency key). Then a 502/503/504 or a dropped connection is retried as for GET;
   * otherwise only refusals (429, 423) are, since the first attempt may have taken effect.
   */
  idempotent?: boolean;
  /**
   * The `Content-Type` of the body, instead of `application/json`. The body is still sent JSON-encoded; use it for
   * a JSON dialect a provider tells apart by media type (LaunchDarkly's semantic patch:
   * `application/json; domain-model=launchdarkly.semanticpatch`).
   */
  contentType?: string;
}

/** Methods whose repetition is harmless, so 5xx and network errors are retried. */
const IDEMPOTENT = new Set(["GET", "HEAD", "DELETE", "PUT"]);
/** Retried for any method: the provider refused before doing anything (rate limit, Neon's "operation running"). */
const REFUSED_STATUSES = new Set([429, 423]);
/** Retried only for idempotent methods: the request may or may not have been executed. */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

interface Policy {
  timeoutMs: number;
  retries: number;
  baseMs: number;
}

function policyFrom(env: NodeJS.ProcessEnv = {}): Policy {
  const num = (name: string, fallback: number, min: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    timeoutMs: num("SPONSON_HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1),
    retries: Math.floor(num("SPONSON_HTTP_RETRIES", DEFAULT_RETRIES, 0)),
    baseMs: num("SPONSON_HTTP_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS, 0),
  };
}

/** Redact first, then flatten and truncate: truncating first could cut a secret so the redactor no longer sees it. */
export function excerptOf(body: string, redact: (s: string) => string): string {
  const flat = redact(body).replace(/\s+/g, " ").trim();
  return flat.length > HTTP_ERROR_BODY_LIMIT ? `${flat.slice(0, HTTP_ERROR_BODY_LIMIT)}… (${flat.length} chars)` : flat;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Undefined when absent or unparseable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const t = header.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Exponential backoff with jitter: attempt 1 waits base·[0.5, 1), attempt 2 base·[1, 2), … */
export function backoffMs(attempt: number, baseMs: number, random = Math.random): number {
  const ceiling = baseMs * 2 ** (attempt - 1);
  return Math.min(MAX_RETRY_WAIT_MS, ceiling / 2 + random() * (ceiling / 2));
}

/** "Already exists"-type answers. 409 always; 400/422 when the body says so (Clerk, Vercel use those statuses). */
const CONFLICT_BODY = /already[ _-]?exists|duplicate|ENV_CONFLICT|_exists\b/i;

/**
 * The PROVIDER_* code for a non-2xx response (status and body). Exported for adapters that talk to a provider
 * without `apiClient`.
 */
export function classifyStatus(status: number, body: string): ProviderErrorCode {
  if (status === 401 || status === 403) return "PROVIDER_AUTH";
  if (status === 404) return "PROVIDER_NOT_FOUND";
  if (status === 409) return "PROVIDER_CONFLICT";
  if ((status === 400 || status === 422) && CONFLICT_BODY.test(body)) return "PROVIDER_CONFLICT";
  if (REFUSED_STATUSES.has(status) || status >= 500) return "PROVIDER_TRANSIENT";
  return "PROVIDER_INVALID";
}

const DESCRIBE: Record<ProviderErrorCode, string> = {
  PROVIDER_TRANSIENT: "temporarily unavailable",
  PROVIDER_CONFLICT: "conflict",
  PROVIDER_NOT_FOUND: "not found",
  PROVIDER_AUTH: "not authorised",
  PROVIDER_INVALID: "rejected the request",
  PROVIDER_TIMEOUT: "timed out",
  PROVIDER_RESPONSE: "unexpected response",
};

class Attempt {
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryable: boolean,
    readonly message: string,
    readonly status?: number,
    readonly waitMs?: number,
  ) {}
}

/**
 * A 2xx response body as `shape` wants it (parsed JSON when there is no shape; undefined for an empty body with no
 * shape), or what is wrong with it.
 */
function decode<T>(text: string, shape: Shape<T> | undefined, redact: (s: string) => string): { value: T } | { problem: string } {
  if (!text) return shape ? { problem: "empty response body" } : { value: undefined as T };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: `response is not JSON: ${excerptOf(text, redact)}` };
  }
  if (!shape) return { value: parsed as T };
  try {
    return { value: shape(parsed) };
  } catch (e) {
    if (e instanceof ShapeError) return { problem: e.message };
    throw e;
  }
}

/**
 * Build an `ApiClient`. Adapters should call `clientFor(actx, ...)` instead, which wires redaction and the
 * environment.
 */
export function apiClient(opts: ApiClientOptions): ApiClient {
  let base = opts.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const auth = opts.authHeader ?? "bearer";
  const policy = policyFrom(opts.env);
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth === "bearer") headers.authorization = `Bearer ${opts.token}`;
  else headers[auth.slice("header:".length)] = opts.token;

  const fail = (code: ProviderErrorCode, method: string, path: string, detail: string, status?: number, extra: Record<string, unknown> = {}): SponsonError =>
    new SponsonError(code, `${opts.adapter}: ${method} ${path} → ${status ?? DESCRIBE[code]}${detail ? `: ${detail}` : ""}`, {
      adapter: opts.adapter,
      method,
      path,
      ...(status !== undefined ? { status } : {}),
      ...extra,
    });

  async function once(method: string, path: string, body: unknown, idempotent: boolean, contentType = "application/json"): Promise<{ status: number; text: string } | Attempt> {
    const controller = new AbortController();
    const init: RequestInit =
      body === undefined
        ? { method, headers: { ...headers }, signal: controller.signal }
        : { method, headers: { ...headers, "content-type": contentType }, body: JSON.stringify(body), signal: controller.signal };
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const res = await fetch(base + path, init);
      const text = await res.text(); // the timer also bounds a body that never finishes
      if (res.ok) return { status: res.status, text };
      const code = classifyStatus(res.status, text);
      const retryable = REFUSED_STATUSES.has(res.status) || (idempotent && UNAVAILABLE_STATUSES.has(res.status));
      return new Attempt(code, retryable, excerptOf(text, opts.redact), res.status, retryAfterMs(res.headers.get("retry-after")));
    } catch (e) {
      if (controller.signal.aborted) return new Attempt("PROVIDER_TIMEOUT", false, `no response within ${policy.timeoutMs}ms (SPONSON_HTTP_TIMEOUT_MS)`);
      // `fetch failed` alone says nothing; the cause (ECONNREFUSED, ECONNRESET, ENOTFOUND) does.
      const cause = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
      // A write whose connection dropped may have happened; only idempotent requests are repeated.
      return new Attempt("PROVIDER_TRANSIENT", idempotent, `${base}${path}: ${opts.redact(cause)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(method: string, path: string, body: unknown, shape?: Shape<T>, write?: WriteOptions): Promise<T> {
    const idempotent = write?.idempotent ?? IDEMPOTENT.has(method);
    for (let attempt = 1; ; attempt++) {
      const r = await once(method, path, body, idempotent, write?.contentType);
      if (r instanceof Attempt) {
        if (r.retryable && attempt <= policy.retries) {
          await sleep(Math.min(MAX_RETRY_WAIT_MS, r.waitMs ?? backoffMs(attempt, policy.baseMs)));
          continue;
        }
        const note = r.retryable ? ` (after ${attempt} attempts)` : "";
        throw fail(r.code, method, path, r.message + note, r.status, r.retryable ? { attempts: attempt } : {});
      }
      const d = decode(r.text, shape, opts.redact);
      if ("problem" in d) throw fail("PROVIDER_RESPONSE", method, path, d.problem, r.status);
      return d.value;
    }
  }

  return {
    adapter: opts.adapter,
    get: (path, shape) => call("GET", path, undefined, shape),
    post: (path, body, shape, write) => call("POST", path, body, shape, write),
    put: (path, body, shape) => call("PUT", path, body, shape),
    patch: (path, body, shape, write) => call("PATCH", path, body, shape, write),
    delete: (path, shape) => call("DELETE", path, undefined, shape),
  };
}

// ---------------------------------------------------------------------------
// Shape helpers: small checks with messages that name the field, instead of a TypeError three frames later.
// ---------------------------------------------------------------------------

/** True for a plain JSON object (not null, not an array). For hand-written `Shape`s. Stable authoring API. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v` must be an object; returns it. Stable authoring API. */
export function obj(v: unknown, what: string): Record<string, unknown> {
  if (!isObject(v)) throw new ShapeError(`expected ${what} to be an object, got ${kindOf(v)}`);
  return v;
}

/** `v` must be an array of objects each having the string fields named; returns them typed. Stable authoring API. */
export function records<K extends string>(v: unknown, what: string, fields: readonly K[]): Array<Record<K, string> & Record<string, unknown>> {
  if (!Array.isArray(v)) throw new ShapeError(`expected ${what} to be an array, got ${kindOf(v)}`);
  return v.map((item, i) => {
    const o = obj(item, `${what}[${i}]`);
    for (const f of fields) if (typeof o[f] !== "string") throw new ShapeError(`expected ${what}[${i}].${f} to be a string, got ${kindOf(o[f])}`);
    return o as Record<K, string> & Record<string, unknown>;
  });
}

function kindOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "an array" : typeof v;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** One page of a list, as the `page` callback of `listAll` describes it. Stable authoring API. */
export interface Page<T> {
  items: T[];
  /** Query parameters for the next page, or null when this was the last one. */
  next: Record<string, string> | null;
}

/** Hard stop against a provider that keeps returning a cursor. */
export const MAX_PAGES = 1000;

/**
 * Fetch every page of a list. `page` validates one response body and says how to ask for the next page.
 * Stops on a null cursor, an empty page, or a cursor seen before (a provider that repeats the last cursor).
 * Stable authoring API.
 */
export async function listAll<T>(api: ApiClient, path: string, page: (body: unknown, pageNo: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let query: Record<string, string> = {};
  for (let n = 0; ; n++) {
    if (n >= MAX_PAGES) throw new SponsonError("PROVIDER_RESPONSE", `${api.adapter}: GET ${path} returned more than ${MAX_PAGES} pages`, { adapter: api.adapter, method: "GET", path });
    const p: Page<T> = await api.get(withQuery(path, query), (b) => page(b, n));
    out.push(...p.items);
    if (!p.next || p.items.length === 0) break;
    const key = JSON.stringify(p.next);
    if (seen.has(key)) break;
    seen.add(key);
    query = p.next;
  }
  return out;
}

/** `path` with `extra` appended as query parameters (after any it already has). Stable authoring API. */
export function withQuery(path: string, extra: Record<string, string>): string {
  const entries = Object.entries(extra);
  if (entries.length === 0) return path;
  const q = new URLSearchParams(entries).toString();
  return path.includes("?") ? `${path}&${q}` : `${path}?${q}`;
}

