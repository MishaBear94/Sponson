import { SponsonError, markerKind, pendingRef, sha256, type AdapterContext, type DiffSide, type ResolvedParams, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { apiClient, isProviderError, type ApiClient } from "./http.js";

/**
 * The adapter authoring API. These helpers are stable and exported from `@sponson/adapters`; third-party
 * adapters should use them rather than re-implementing the contracts they encode:
 *
 *   clientFor              HTTP client with retry policy and redaction from the adapter context
 *   requireEnv             a credential from the environment, PROVIDER_AUTH when missing
 *   optionalEnv            an optional setting from the environment (a base URL override)
 *   requireProvider        a `providers.<adapter>.<key>` value, PLAN_INVALID when missing
 *   stringParam/paramError a string param with a default, PARAM_INVALID otherwise
 *   desiredSide/diffValue  the marker contract (pending / secret / keep) applied to one value's diff
 *   assertNoPending        apply-time guard that the engine resolved every reference
 *   deleteIgnoringNotFound destroy's "already gone is success" rule
 *
 * The HTTP side of the authoring API (ApiClient, Page, Shape, ShapeError, isObject, obj, records, listAll,
 * withQuery, isProviderError) lives in http.ts; packages/adapters/src/index.ts lists the whole API.
 * Anything else in this file is internal and may change.
 */

/** A credential from the environment; PROVIDER_AUTH naming the variable when it is unset or blank. */
export function requireEnv(env: NodeJS.ProcessEnv, name: string, adapter: string): string {
  const v = env[name];
  if (!v) throw new SponsonError("PROVIDER_AUTH", `${adapter}: environment variable ${name} is not set`, { adapter, variable: name });
  return v;
}

/** An optional setting from the environment (a base URL override); blank counts as unset. Stable authoring API. */
export function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * A `providers.<adapter>.<key>` string from the plan; PLAN_INVALID when missing. Use it for project and team
 * ids.
 */
export function requireProvider(actx: AdapterContext, key: string, adapter: string): string {
  const v = actx.provider[key];
  if (typeof v !== "string" || v === "") throw new SponsonError("PLAN_INVALID", `${adapter}: providers.${adapter}.${key} is required in the plan`, { adapter, key });
  return v;
}

/** A `providers.<adapter>.<key>` string from the plan, or undefined. */
export function optionalProvider(actx: AdapterContext, key: string): string | undefined {
  const v = actx.provider[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The HTTP client for an adapter call: the context's environment sets the policy and its redactor masks error text.
 *
 * @example
 * ```ts
 * // inside an op's read():
 * const token = requireEnv(actx.env, "ACME_TOKEN", "acme");
 * const api = clientFor(actx, "acme", { baseUrl: "https://api.acme.dev", token });
 * // Retries, timeouts and classification happen inside: a 404 throws PROVIDER_NOT_FOUND, and so on.
 * const site = await api.get(`/sites/${stringParam(params, "name", "acme")}`);
 * ```
 */
export function clientFor(actx: AdapterContext, adapter: string, opts: { baseUrl: string; token: string; authHeader?: "bearer" | `header:${string}` }): ApiClient {
  return apiClient({ adapter, ...opts, redact: actx.redact, env: actx.env });
}

/**
 * The PARAM_INVALID error for a bad param, prefixed with the adapter name. Throw it from `diff`/`apply`
 * validation.
 */
export function paramError(adapter: string, message: string, param: string): SponsonError {
  return new SponsonError("PARAM_INVALID", `${adapter}: ${message}`, { adapter, param });
}

/** The engine never passes a pending marker into apply; if one arrives, something upstream is wrong. */
export function assertNoPending(params: ResolvedParams, adapter: string): void {
  const walk = (v: unknown, path: string): void => {
    const marker = markerKind(v);
    if (marker === "pending" || marker === "secret") throw new SponsonError("INTERNAL", `${adapter}: param ${path} is still pending (${pendingRef(v as string)}); apply must not be called before its inputs resolve`, { adapter, param: path });
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(params, "");
}

// ---------------------------------------------------------------------------
// Diff sides: data only. Renderers turn them into text.
// ---------------------------------------------------------------------------

export const ABSENT: DiffSide = { state: "absent" };
export const SENSITIVE: DiffSide = { state: "sensitive" };

/** A desired value as a diff side: pending markers name their reference (secret refs are URLs: `env://X`). */
export function desiredSide(v: unknown, sensitive: boolean): DiffSide {
  const marker = markerKind(v);
  if (marker === "pending" || marker === "secret") return { state: marker, ref: pendingRef(v as string) };
  return sensitive ? SENSITIVE : { state: "literal", value: String(v) };
}

/**
 * Diff one desired value against the live record by hash. `liveValue` is what `before` shows for a non-sensitive
 * value (the live record carries only a hash). Unchanged diffs carry no sides: there is nothing to show.
 */
export function diffValue(opts: { key: string; label: string; live: ResourceRecord | undefined; desired: unknown; sensitive: boolean; liveValue?: string }): ResourceDiff {
  const { key, label, live, desired, sensitive } = opts;
  const marker = markerKind(desired);
  if (marker === "keep") {
    if (live) return { key, kind: "unchanged", label };
    throw new SponsonError("PARAM_INVALID", `${label} is declared \`{ keep: true }\` but does not exist, so there is no value to keep. Give it a value or remove it.`, { key });
  }
  const after = desiredSide(desired, sensitive);
  if (!live) return { key, kind: "create", label, before: ABSENT, after };
  const before: DiffSide = sensitive || opts.liveValue === undefined ? SENSITIVE : { state: "literal", value: opts.liveValue };
  if (marker === null && live.hash === sha256(String(desired))) return { key, kind: "unchanged", label };
  return { key, kind: "update", label, before, after };
}

/**
 * A string param, or `fallback` when absent or empty; PARAM_INVALID when missing without a fallback or not a
 * string.
 */
export function stringParam(params: ResolvedParams, name: string, adapter: string, fallback?: string): string {
  const v = params[name];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw paramError(adapter, `param \`${name}\` is required`, name);
  }
  if (typeof v !== "string") throw paramError(adapter, `param \`${name}\` must be a string`, name);
  return v;
}

/** DELETE that treats 404 as success: the contract says a resource that is already gone is not an error. */
export async function deleteIgnoringNotFound(api: ApiClient, path: string): Promise<void> {
  try {
    await api.delete(path);
  } catch (e) {
    if (!isProviderError(e, "PROVIDER_NOT_FOUND")) throw e;
  }
}
