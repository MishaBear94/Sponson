/**
 * The generic `http` adapter's client and the requests both of its ops send: the API from the line's provider
 * block (`actx.provider` is `providers.http.<api>`, narrowed by `OpSpec.providerFor`), its credential from the
 * environment variable(s) the block names, and writes with the idempotency each method has.
 */
import { canonicalJson, type AdapterContext, type Literal } from "@sponson/core";
import { clientFor, optionalEnv, requireEnv } from "./common.js";
import { isObject, isProviderError, type ApiClient } from "./http.js";
import { ADAPTER, at, pointerTokens, parseApi, type ApiConfig } from "./http-adapter-spec.js";

/** Per-request settings on top of the API's: a vendor media type, an `Idempotency-Key`. */
export interface RequestOptions {
  contentType?: string;
  headers?: Record<string, string>;
}

/** The header value to send and how to send it. Basic credentials are joined and encoded here, never stored. */
function credential(cfg: ApiConfig, env: NodeJS.ProcessEnv): { token: string; authHeader: "bearer" | `header:${string}`; masks: string[] } {
  const auth = cfg.auth;
  if (auth.kind === "bearer") return { token: requireEnv(env, auth.env, ADAPTER), authHeader: "bearer", masks: [] };
  if (auth.kind === "header") return { token: requireEnv(env, auth.env, ADAPTER), authHeader: `header:${auth.header}`, masks: [] };
  const encoded = Buffer.from(`${requireEnv(env, auth.userEnv, ADAPTER)}:${requireEnv(env, auth.passwordEnv, ADAPTER)}`).toString("base64");
  return { token: `Basic ${encoded}`, authHeader: "header:authorization", masks: [encoded] };
}

/**
 * The client for the line's API. The credential (and, for Basic, its encoded form) is masked in this client's
 * error text too, whatever the engine already masks.
 */
export function httpClient(actx: AdapterContext, req: RequestOptions = {}): ApiClient {
  const cfg = parseApi(actx.provider, "providers.http.<api>");
  const { token, authHeader, masks } = credential(cfg, actx.env);
  const baseUrl = (cfg.baseUrlEnv ? optionalEnv(actx.env, cfg.baseUrlEnv) : undefined) ?? cfg.baseUrl;
  const hidden = [token, ...masks].filter((s) => s.length >= 4);
  const redact = (t: string) => hidden.reduce((s, h) => s.split(h).join("****"), actx.redact(t));
  return clientFor({ ...actx, redact }, ADAPTER, {
    baseUrl,
    token,
    authHeader,
    headers: { ...cfg.headers, ...(req.headers ?? {}) },
    encoding: cfg.encoding,
    ...(req.contentType ? { contentType: req.contentType } : {}),
  });
}

/**
 * A write that sets state. PUT is idempotent by method; a PATCH or POST that sets fields (or replaces a whole
 * list) may safely be sent twice, so a dropped connection is retried like a read. `idempotent: false` is for a
 * create without an idempotency key: sending it twice could make two objects.
 */
export function write(api: ApiClient, method: string, path: string, body: unknown, idempotent: boolean): Promise<unknown> {
  if (method === "PUT") return api.put(path, body);
  if (method === "PATCH") return api.patch(path, body, undefined, { idempotent });
  if (method === "DELETE") return api.delete(path);
  return api.post(path, body, undefined, { idempotent });
}

/** A provider error whose status is one of `statuses`, or of `code`. */
export function failedWith(e: unknown, code: "PROVIDER_NOT_FOUND" | "PROVIDER_CONFLICT", statuses: number[]): boolean {
  if (isProviderError(e, code)) return true;
  return isProviderError(e) && e.details.status !== undefined && statuses.includes(e.details.status);
}

/** An output value: literals as they are, anything structured as canonical JSON, absent as undefined. */
export function literalOf(v: unknown): Literal | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return canonicalJson(v);
}

/** A provider id at `idPath` in `item`: a non-empty string or a number. */
export function idOf(item: unknown, idPath: string): string | undefined {
  const v = at(item, pointerTokens(idPath));
  if ((typeof v === "string" && v !== "") || typeof v === "number") return String(v);
  return undefined;
}

/** The object at `itemPath` in a response body, when it is one. */
export function itemOf(body: unknown, itemPath: string): Record<string, unknown> | undefined {
  const v = at(body, pointerTokens(itemPath));
  return isObject(v) ? v : undefined;
}
