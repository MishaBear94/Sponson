import { walkParams } from "./plan.js";
import { isFromRef, isKeepRef, isSecretRef, type Literal, type OutputSpec, type ResolvedParams, type ResolvedValue } from "./types.js";

/** Outputs a line has produced so far, with the spec that says which are sensitive. */
export interface LineOutputs {
  values: Record<string, Literal>;
  specs: Record<string, OutputSpec>;
}

/** Marker placed into params for values that are not known yet. Adapters compare on shape when they see it. */
const PENDING_PREFIX = "\u0000pending:";

/**
 * The marker that stands in a param for the output reference `ref` until it is known. Engine-internal; adapters
 * classify markers with `markerKind`.
 */
export function pendingMarker(ref: string): string {
  return PENDING_PREFIX + ref;
}

/** True for a pending or secret marker. Adapters should prefer `markerKind`, which tells the two apart. */
export function isPendingMarker(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PENDING_PREFIX);
}

/** The reference a pending marker stands for (`db.connection_string`, `env://KEY`), for display in diffs. */
export function pendingRef(marker: string): string {
  return marker.slice(PENDING_PREFIX.length);
}

const KEEP_MARKER = "\u0000keep";

/** Placed into params for `{ keep: true }`. Adapters treat it as "equal to whatever is live". */
export function isKeepMarker(v: unknown): v is string {
  return v === KEEP_MARKER;
}

/** The kinds of marker a resolved param leaf can be; see the marker contract on `OpSpec`. */
export type MarkerKind = "pending" | "secret" | "keep";

/**
 * What a resolved param leaf stands for when it is not a concrete value (see the marker contract on `OpSpec`).
 * The one place that tells an unresolved secret reference (a URL, `env://X`) from an output reference (`line.output`).
 */
export function markerKind(v: unknown): MarkerKind | null {
  if (isKeepMarker(v)) return "keep";
  if (!isPendingMarker(v)) return null;
  return pendingRef(v).includes("://") ? "secret" : "pending";
}

/** Params with references replaced, plus what plan output needs to show about each reference. */
export interface ResolveResult {
  /** Params with every reference replaced: literals, resolved values, pending markers, or secret values when provided. */
  params: ResolvedParams;
  /** One entry per leaf that was a reference or literal, keyed by dotted path. */
  inputs: Record<string, ResolvedValue>;
  pending: Array<{ path: string; ref: string; line: string }>;
  secrets: Array<{ path: string; ref: string }>;
}

/**
 * Replace `{from}` and `{secret}` leaves.
 * `secretValues` is only passed by apply; plan never resolves secrets.
 */
export function resolveParams(
  params: Record<string, unknown>,
  outputs: Map<string, LineOutputs>,
  secretValues?: Map<string, string>,
): ResolveResult {
  const inputs: Record<string, ResolvedValue> = {};
  const pending: ResolveResult["pending"] = [];
  const secrets: ResolveResult["secrets"] = [];

  const rebuild = (value: unknown, path: string[]): unknown => {
    if (isFromRef(value)) {
      const [line, ...rest] = value.from.split(".");
      const output = rest.join(".");
      const lo = outputs.get(line!);
      const spec = lo?.specs[output];
      const key = path.join(".");
      if (lo && output in lo.values) {
        const sensitive = spec?.sensitive === true;
        inputs[key] = { state: "resolved", value: sensitive ? null : lo.values[output]!, ref: value.from, sensitive, dependsOn: line! };
        return lo.values[output];
      }
      inputs[key] = { state: "pending", value: null, ref: value.from, dependsOn: line!, sensitive: spec?.sensitive === true };
      pending.push({ path: key, ref: value.from, line: line! });
      return pendingMarker(value.from);
    }
    if (isKeepRef(value)) {
      inputs[path.join(".")] = { state: "kept", value: null };
      return KEEP_MARKER;
    }
    if (isSecretRef(value)) {
      const key = path.join(".");
      inputs[key] = { state: "secret", value: null, ref: value.secret, sensitive: true };
      secrets.push({ path: key, ref: value.secret });
      return secretValues?.get(value.secret) ?? pendingMarker(value.secret);
    }
    if (Array.isArray(value)) return value.map((v, i) => rebuild(v, [...path, String(i)]));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = rebuild(v, [...path, k]);
      return out;
    }
    if (path.length > 0 && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      inputs[path.join(".")] = { state: "literal", value };
    }
    return value;
  };

  const resolved = rebuild(params, []) as ResolvedParams;
  return { params: resolved, inputs, pending, secrets };
}

/** All `{secret}` references in a params object. */
export function secretRefs(params: Record<string, unknown>): string[] {
  const refs: string[] = [];
  walkParams(params, [], (_p, v) => {
    if (isSecretRef(v)) refs.push(v.secret);
  });
  return refs;
}
