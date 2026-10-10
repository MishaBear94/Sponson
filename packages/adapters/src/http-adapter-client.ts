/**
 * The generic `http` adapter's client and the requests both of its ops send: the API from the line's provider
 * block (`actx.provider` is `providers.http.<api>`, narrowed by `OpSpec.providerFor`), its credential from the
 * environment variable(s) the block names, and writes with the idempotency each method has.
 */
import { canonicalJson, type AdapterContext, type Literal, type OpSpec } from "@sponson/core";
import { clientFor, optionalEnv } from "./common.js";
import { isObject, isProviderError, type ApiClient } from "./http.js";
import { DEFAULT_AUTH_DEPS, credentialFor, type AuthDeps } from "./http-adapter-auth.js";
import { ADAPTER, at, pointerTokens, parseApi } from "./http-adapter-spec.js";

/** Per-request settings on top of the API's: a vendor media type, an `Idempotency-Key`. */
export interface RequestOptions {
  contentType?: string;
  headers?: Record<string, string>;
  /** Overrides the API's encoding (GraphQL requests are always JSON). */
  encoding?: "json";
}

/** The dependencies an op was built with, by the adapter context each of its calls received (see `withDeps`). */
const DEPS = new WeakMap<AdapterContext, AuthDeps>();

/**
 * `op` with every call's adapter context carrying `deps` (how `auth.command` runs a CLI, the clock), so the
 * clients built inside see them. The built-in adapter uses the real ones; tests inject fakes.
 */
export function withDeps(op: OpSpec, deps: AuthDeps): OpSpec {
  const bind = (actx: AdapterContext): AdapterContext => {
    const bound = { ...actx };
    DEPS.set(bound, deps);
    return bound;
  };
  return {
    ...op,
    read: (actx, params) => op.read(bind(actx), params),
    apply: (actx, params, live) => op.apply(bind(actx), params, live),
    destroy: (actx, resources) => op.destroy(bind(actx), resources),
    ...(op.listScope ? { listScope: (actx: AdapterContext, params: Record<string, unknown>) => op.listScope!(bind(actx), params) } : {}),
  };
}

/**
 * The client for the line's API. The credential (a static header, or a signer for the forms obtained or computed
 * per request) comes from http-adapter-auth.ts; everything it holds or obtains is masked in this client's error text
 * too, whatever the engine already masks.
 */
export function httpClient(actx: AdapterContext, req: RequestOptions = {}): ApiClient {
  const cfg = parseApi(actx.provider, "providers.http.<api>");
  const baseUrl = (cfg.baseUrlEnv ? optionalEnv(actx.env, cfg.baseUrlEnv) : undefined) ?? cfg.baseUrl;
  let hidden: () => string[] = () => [];
  const redact = (t: string) => hidden().reduce((s, h) => (h.length >= 4 ? s.split(h).join("****") : s), actx.redact(t));
  const cred = credentialFor(actx, cfg.auth, DEPS.get(actx) ?? DEFAULT_AUTH_DEPS, redact);
  hidden = () => [cred.token, ...cred.masks()];
  const contentType = req.contentType ?? cfg.mediaType;
  return clientFor({ ...actx, redact }, ADAPTER, {
    baseUrl,
    token: cred.token,
    authHeader: cred.authHeader,
    ...(cred.signer ? { signer: cred.signer } : {}),
    headers: { ...cfg.headers, ...(req.headers ?? {}) },
    encoding: req.encoding ?? cfg.encoding,
    ...(contentType ? { contentType } : {}),
    ...(cfg.mediaType ? { accept: cfg.mediaType } : {}),
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
