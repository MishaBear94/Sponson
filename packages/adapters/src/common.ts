import { isPendingMarker, pendingDisplay, pendingRef, sha256, type AdapterContext, type ResolvedParams, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { isHttpError, type ApiClient } from "./http.js";

export function requireEnv(env: NodeJS.ProcessEnv, name: string, adapter: string): string {
  const v = env[name];
  if (!v) throw new Error(`${adapter}: environment variable ${name} is not set`);
  return v;
}

export function requireProvider(actx: AdapterContext, key: string, adapter: string): string {
  const v = actx.provider[key];
  if (typeof v !== "string" || v === "") throw new Error(`${adapter}: providers.${adapter}.${key} is required in the plan`);
  return v;
}

export function optionalProvider(actx: AdapterContext, key: string): string | undefined {
  const v = actx.provider[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Display form of a sensitive value: enough to tell two values apart, never the value. */
export function shaDisplay(hash: string): string {
  return `sha:${hash.slice(0, 8)}`;
}

/** The engine never passes a pending marker into apply; if one arrives, something upstream is wrong. */
export function assertNoPending(params: ResolvedParams, adapter: string): void {
  const walk = (v: unknown, path: string): void => {
    if (isPendingMarker(v)) throw new Error(`${adapter}: param ${path} is still pending (${pendingRef(v)}); apply must not be called before its inputs resolve`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(params, "");
}

/**
 * Diff one desired value against the live record, for both sensitive and plain values.
 * A pending desired value is a create/update whose `after` names the reference it waits on.
 */
export function diffValue(opts: { key: string; label: string; live: ResourceRecord | undefined; desired: unknown; sensitive: boolean }): ResourceDiff {
  const { key, label, live, desired, sensitive } = opts;
  const before = live ? (sensitive ? shaDisplay(live.hash) : (live.label ?? live.key)) : undefined;
  if (isPendingMarker(desired)) {
    return { key, kind: live ? "update" : "create", label, ...(before !== undefined ? { before } : {}), after: pendingDisplay(desired) };
  }
  const text = String(desired);
  const hash = sha256(text);
  const after = sensitive ? shaDisplay(hash) : text;
  if (!live) return { key, kind: "create", label, after };
  if (live.hash === hash) return { key, kind: "unchanged", label }; // no before/after: nothing to show
  return { key, kind: "update", label, before: before!, after };
}

export function stringParam(params: ResolvedParams, name: string, fallback?: string): string {
  const v = params[name];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`param \`${name}\` is required`);
  }
  if (typeof v !== "string") throw new Error(`param \`${name}\` must be a string`);
  return v;
}

/** DELETE that treats 404 as success: the contract says a resource that is already gone is not an error. */
export async function deleteIgnoringNotFound(api: ApiClient, path: string): Promise<void> {
  try {
    await api.delete(path);
  } catch (e) {
    if (!isHttpError(e, 404)) throw e;
  }
}
