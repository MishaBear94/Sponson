/**
 * The generic `http` adapter's client and the requests both of its ops send: the API from the line's provider
 * block (`actx.provider` is `providers.http.<api>`, narrowed by `OpSpec.providerFor`), its credential from the
 * environment variable(s) the block names, and writes with the idempotency each method has.
 */
import { SponsonError, canonicalJson, type AdapterContext, type Literal, type OpSpec } from "@sponson/core";
import { clientFor, optionalEnv } from "./common.js";
import { isObject, isProviderError, type ApiClient } from "./http.js";
import { DEFAULT_AUTH_DEPS, credentialFor, type Auth, type AuthDeps } from "./http-adapter-auth.js";
import { ADAPTER, at, pointerTokens, parseApi, type ApiConfig } from "./http-adapter-spec.js";

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

/** The variables holding a credential's secret part, for `refuse_credential`. */
function secretEnvs(auth: Auth): string[] {
  switch (auth.kind) {
    case "bearer":
    case "header":
      return [auth.env];
    case "headers":
      return auth.headers.map((h) => h.env);
    case "basic":
    case "digest":
      return [auth.passwordEnv];
    case "oauth2":
      return [auth.clientSecretEnv];
    case "sigv4":
      return [auth.secretAccessKeyEnv];
    case "command":
    case "none":
      return [];
  }
}

/**
 * Refuse a credential the API refuses (`refuse_credential`): PROVIDER_AUTH naming the variable and the prefix,
 * never the value, before any request is sent.
 */
function refuseCredentials(cfg: ApiConfig, env: NodeJS.ProcessEnv): void {
  if (!cfg.refuse || /^(1|true)$/i.test(env[cfg.refuse.unlessEnv] ?? "")) return;
  for (const name of secretEnvs(cfg.auth)) {
    const value = env[name] ?? "";
    const prefix = cfg.refuse.prefixes.find((p) => value.startsWith(p));
    if (!prefix) continue;
    throw new SponsonError(
      "PROVIDER_AUTH",
      `${ADAPTER}: ${name} holds a \`${prefix}…\` credential, which this API refuses (refuse_credential): a preview environment must not write with it. ` +
        `Use a test-mode credential, or set ${cfg.refuse.unlessEnv}=1 if this run really is meant to use it.`,
      { adapter: ADAPTER, env: name },
    );
  }
}

/**
 * The client for the line's API. The credential (a static header, or a signer for the forms obtained or computed
 * per request) comes from http-adapter-auth.ts; everything it holds or obtains is masked in this client's error text
 * too, whatever the engine already masks. `opts`: where the block is, for messages; whether a block without `auth`
 * sends no credential (a manual step's verify request); the adapter named in errors.
 */
export function httpClient(actx: AdapterContext, req: RequestOptions = {}, opts: { where?: string; authOptional?: boolean; adapter?: string } = {}): ApiClient {
  const cfg = parseApi(actx.provider, opts.where ?? "providers.http.<api>", opts);
  const baseUrl = (cfg.baseUrlEnv ? optionalEnv(actx.env, cfg.baseUrlEnv) : undefined) ?? cfg.baseUrl;
  let hidden: () => string[] = () => [];
  const redact = (t: string) => hidden().reduce((s, h) => (h.length >= 4 ? s.split(h).join("****") : s), actx.redact(t));
  refuseCredentials(cfg, actx.env);
  const cred = credentialFor(actx, cfg.auth, DEPS.get(actx) ?? DEFAULT_AUTH_DEPS, redact);
  hidden = () => [cred.token, ...cred.masks()];
  const contentType = req.contentType ?? cfg.mediaType;
  return clientFor({ ...actx, redact }, opts.adapter ?? ADAPTER, {
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
