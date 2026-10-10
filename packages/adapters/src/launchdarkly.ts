/**
 * LaunchDarkly adapter: op `flag_target` serves one variation of a feature flag to one individual target (a context
 * key of a context kind, such as a preview URL or `pr-42`) in one environment, and removes exactly that target on
 * destroy. Writes are LaunchDarkly semantic patches (`addTargets` / `removeTargets`); the API assumptions are
 * numbered LD1… at the top of packages/sim/src/routes/launchdarkly.ts and checked in docs/api-verification.md.
 */
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type Literal, type OpSpec, type ResolvedParams, type ResourceAdapter, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { assertNoPending, clientFor, desiredSide, optionalEnv, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isObject, isProviderError, obj, records, type ApiClient } from "./http.js";

const ADAPTER = "launchdarkly";
/** The environment LaunchDarkly reads; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = { credentialEnv: "LAUNCHDARKLY_ACCESS_TOKEN", baseUrlEnv: "LAUNCHDARKLY_API_URL" } as const;

/** LaunchDarkly's REST API base URL (LD1). `LAUNCHDARKLY_API_URL` overrides it: the sim, or a federal or EU instance. */
export const LAUNCHDARKLY_DEFAULT_API_URL = "https://app.launchdarkly.com/api/v2";
/** The media type that makes a PATCH body a semantic patch rather than a JSON patch (LD4). */
const SEMANTIC_PATCH = "application/json; domain-model=launchdarkly.semanticpatch";
/** A concurrent change answers 409, to be retried (LD6); the instructions are idempotent, so they are re-sent. */
const CONFLICT_ATTEMPTS = 3;
/** The context kind of a target when the line does not name one, as in LaunchDarkly itself (LD5). */
const DEFAULT_CONTEXT_KIND = "user";

interface Variation {
  _id: string;
  value: unknown;
  name?: string;
}

/** A flag as the adapter reads it: its variations and one environment's individual targets. */
interface Flag {
  variations: Variation[];
  /** `<contextKind>\u0000<key>` → index into `variations`. */
  targets: Map<string, number>;
}

/** Everything that identifies one target. */
interface Target {
  project: string;
  environment: string;
  flag: string;
  contextKind: string;
  key: string;
}

function api(actx: AdapterContext): ApiClient {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  // LD1: the token is the whole Authorization value, no `Bearer`.
  return clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? LAUNCHDARKLY_DEFAULT_API_URL, token, authHeader: "header:authorization" });
}

function targetOf(actx: AdapterContext, params: ResolvedParams): Target {
  return {
    project: requireProvider(actx, "project", ADAPTER),
    environment: requireProvider(actx, "environment", ADAPTER),
    flag: stringParam(params, "flag", ADAPTER),
    contextKind: stringParam(params, "context_kind", ADAPTER, DEFAULT_CONTEXT_KIND),
    key: stringParam(params, "key", ADAPTER),
  };
}

const KEY_PREFIX = "target:";

/**
 * `target:<flag>:<contextKind>:<key>`. The project and environment are not repeated: they are the provider block
 * (`providers.launchdarkly`), which the ledger already keys every resource by, and `diff` (which must name the key
 * of a target that does not exist yet) only sees the line's params. LaunchDarkly flag keys and context kinds never
 * contain `:`, so the context key (a URL may) is everything after the second separator.
 */
function resourceKey(t: Pick<Target, "flag" | "contextKind" | "key">): string {
  return `${KEY_PREFIX}${t.flag}:${t.contextKind}:${t.key}`;
}

function parseKey(key: string): Pick<Target, "flag" | "contextKind" | "key"> | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const [flag, contextKind, ...rest] = key.slice(KEY_PREFIX.length).split(":");
  if (!flag || !contextKind || rest.length === 0) return null;
  return { flag, contextKind, key: rest.join(":") };
}

function flagPath(t: Pick<Target, "project" | "flag">): string {
  return `/flags/${encodeURIComponent(t.project)}/${encodeURIComponent(t.flag)}`;
}

function targetId(contextKind: string, key: string): string {
  return `${contextKind}\u0000${key}`;
}

// ---------------------------------------------------------------------------
// Reading a flag (LD2, LD3)
// ---------------------------------------------------------------------------

function parseVariations(v: unknown): Variation[] {
  return records(v, "`variations`", ["_id"]).map((x) => ({ _id: x._id, value: x.value, ...(typeof x.name === "string" ? { name: x.name } : {}) }));
}

/** `targets` and `contextTargets` of one environment, merged; empty placeholder entries carry nothing (LD3). */
function parseTargets(env: Record<string, unknown>, variations: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const field of ["targets", "contextTargets"] as const) {
    const list = env[field] ?? [];
    if (!Array.isArray(list)) throw new ShapeError(`expected \`${field}\` to be an array`);
    list.forEach((item, i) => {
      const t = obj(item, `${field}[${i}]`);
      const kind = typeof t.contextKind === "string" && t.contextKind !== "" ? t.contextKind : DEFAULT_CONTEXT_KIND;
      if (!Array.isArray(t.values) || t.values.some((v) => typeof v !== "string")) throw new ShapeError(`expected ${field}[${i}].values to be a list of strings`);
      if (typeof t.variation !== "number" || !Number.isInteger(t.variation) || t.variation < 0 || t.variation >= variations) throw new ShapeError(`expected ${field}[${i}].variation to index \`variations\``);
      for (const key of t.values as string[]) out.set(targetId(kind, key), t.variation);
    });
  }
  return out;
}

/** The flag with `environment`'s targets; an environment the answer lacks is not found (LD2). */
function flagShape(environment: string, flagKey: string) {
  return (body: unknown): Flag | { missingEnvironment: true } => {
    const b = obj(body, "the flag");
    const variations = parseVariations(b.variations);
    const envs = obj(b.environments ?? {}, "`environments`");
    const env = envs[environment];
    if (env === undefined) return { missingEnvironment: true };
    if (!isObject(env)) throw new ShapeError(`expected environments.${environment} of flag ${flagKey} to be an object`);
    return { variations, targets: parseTargets(env, variations.length) };
  };
}

function checkFlag(t: Target, f: Flag | { missingEnvironment: true }): Flag {
  if ("missingEnvironment" in f) throw new SponsonError("PROVIDER_NOT_FOUND", `${ADAPTER}: flag ${t.flag} in project ${t.project} has no environment ${t.environment}`, { adapter: ADAPTER, environment: t.environment });
  return f;
}

async function loadFlag(client: ApiClient, t: Target): Promise<Flag> {
  return checkFlag(t, await client.get(`${flagPath(t)}?env=${encodeURIComponent(t.environment)}`, flagShape(t.environment, t.flag)));
}

function currentVariation(f: Flag, t: Pick<Target, "contextKind" | "key">): Variation | undefined {
  const i = f.targets.get(targetId(t.contextKind, t.key));
  return i === undefined ? undefined : f.variations[i];
}

// ---------------------------------------------------------------------------
// Choosing a variation
// ---------------------------------------------------------------------------

/**
 * Does `v` answer to the plan's `variation`? A string matches a variation's name; any value matches a variation
 * whose value is equal (a string also matches the JSON spelling of a non-string value: `"true"`, `"42"`).
 */
function matches(v: { name?: string; value: unknown }, wanted: unknown): boolean {
  if (typeof wanted === "string" && (v.name === wanted || (typeof v.value !== "string" && canonicalJson(v.value) === wanted))) return true;
  return canonicalJson(v.value) === canonicalJson(wanted);
}

function resolveVariation(f: Flag, t: Target, wanted: unknown): Variation {
  const found = f.variations.filter((v) => matches(v, wanted));
  if (found.length === 1) return found[0]!;
  const known = f.variations.map(describe).join(", ");
  const why = found.length === 0 ? "has no variation" : "has several variations matching";
  throw paramError(ADAPTER, `flag ${t.flag} ${why} ${canonicalJson(wanted)} (variations: ${known})`, "variation");
}

function describe(v: { name?: string; value: unknown }): string {
  const value = canonicalJson(v.value);
  return v.name ? `${v.name} (${value})` : value;
}

/** What the plan asks for; `true` when absent (turn a boolean flag on for the target). */
function wantedVariation(params: ResolvedParams): unknown {
  return params.variation ?? true;
}

// ---------------------------------------------------------------------------
// Records and outputs
// ---------------------------------------------------------------------------

/**
 * The hash covers the one field the plan controls: which variation the target is served, by its stable `_id`. The
 * id is the target itself (not the variation), so a target moved to another variation is `changed` drift rather
 * than "replaced".
 */
function record(t: Target, v: Variation): ResourceRecord {
  return { key: resourceKey(t), id: `${t.contextKind}:${t.key}`, hash: sha256(canonicalJson({ variation: v._id })), label: `LaunchDarkly ${t.flag} → ${t.contextKind} ${t.key}` };
}

function outputsOf(v: Variation): Record<string, Literal> {
  return { variation_id: v._id, variation_name: v.name ?? "", variation_value: canonicalJson(v.value) };
}

function stateOf(t: Target, v: Variation) {
  return { resources: [record(t, v)], outputs: outputsOf(v) };
}

// ---------------------------------------------------------------------------
// Writing (LD4–LD6)
// ---------------------------------------------------------------------------

type Instruction = { kind: "addTargets" | "removeTargets"; contextKind: string; values: string[]; variationId: string };

function instruction(kind: Instruction["kind"], t: Target, v: Variation): Instruction {
  return { kind, contextKind: t.contextKind, values: [t.key], variationId: v._id };
}

/** One semantic patch. A 405 means the environment needs an approval request, which Sponson does not open (LD6). */
async function patch(actx: AdapterContext, client: ApiClient, t: Target, instructions: Instruction[]): Promise<Flag> {
  const body = { environmentKey: t.environment, instructions, comment: `sponson ${actx.ctx.scope}` };
  try {
    // Add and remove are set operations, so sending them twice is harmless (LD5): retried like a GET.
    return checkFlag(t, await client.patch(flagPath(t), body, flagShape(t.environment, t.flag), { idempotent: true, contentType: SEMANTIC_PATCH }));
  } catch (e) {
    if (isProviderError(e) && e.details.status === 405) {
      throw new SponsonError("PROVIDER_INVALID", `${ADAPTER}: environment ${t.environment} requires approval for changes to flag ${t.flag}; Sponson does not open approval requests. Use an environment without required approvals for previews.`, { ...e.details });
    }
    throw e;
  }
}

/** Run `step` again when LaunchDarkly reports a concurrent change (409, LD6); each step re-reads the flag. */
async function retryingConflicts<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (!isProviderError(e, "PROVIDER_CONFLICT") || attempt >= CONFLICT_ATTEMPTS) throw e;
    }
  }
}

function confirm(t: Target, after: Flag, desired: Variation | null): void {
  const now = currentVariation(after, t);
  if ((desired === null && now === undefined) || (desired !== null && now?._id === desired._id)) return;
  throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: PATCH ${flagPath(t)} succeeded but ${t.contextKind} ${t.key} is ${now ? `served ${describe(now)}` : "not targeted"} afterwards`, { adapter: ADAPTER });
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

function pending(params: ResolvedParams): boolean {
  return ["flag", "key", "context_kind"].some((p) => markerKind(params[p]) !== null);
}

function diffTarget(live: { resources: ResourceRecord[]; outputs: Record<string, Literal> } | null, params: ResolvedParams): ResourceDiff {
  const t = { flag: part(params.flag), contextKind: part(params.context_kind) || DEFAULT_CONTEXT_KIND, key: part(params.key) };
  const key = resourceKey(t);
  const current = live?.resources.find((r) => r.key === key);
  const wanted = wantedVariation(params);
  const label = `LaunchDarkly ${t.flag} → ${t.contextKind} ${t.key}`;
  const marker = markerKind(wanted);
  if (marker === "keep") {
    if (current) return { key, kind: "unchanged", label };
    throw paramError(ADAPTER, `${label} is declared \`variation: { keep: true }\` but is not targeted, so there is no variation to keep`, "variation");
  }
  const after = marker === null ? { state: "literal" as const, value: canonicalJson(wanted) } : desiredSide(wanted, false);
  if (!current || !live) return { key, kind: "create", label, before: { state: "absent" }, after };
  const liveVariation = { name: String(live.outputs.variation_name ?? "") || undefined, value: JSON.parse(String(live.outputs.variation_value)) as unknown };
  if (marker === null && matches(liveVariation, wanted)) return { key, kind: "unchanged", label };
  return { key, kind: "update", label, before: { state: "literal", value: describe(liveVariation) }, after };
}

function part(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return markerKind(v) !== null ? "(pending)" : String(v);
}

const flag_target: OpSpec = {
  outputs: { variation_id: { available: "immediate" }, variation_name: { available: "immediate" }, variation_value: { available: "immediate" } },

  /** The target key defaults to the scope (`pr-42`); the context kind to `user`; the variation to `true`. */
  defaults(params, ctx) {
    return { key: ctx.scope, context_kind: DEFAULT_CONTEXT_KIND, variation: true, ...params };
  },

  async read(actx, params) {
    // The target key may come from a line not yet applied (a preview URL): nothing to read yet.
    if (pending(params)) return null;
    const t = targetOf(actx, params);
    const f = await loadFlag(api(actx), t);
    const wanted = wantedVariation(params);
    // An unknown or ambiguous variation is a plan error, reported at plan time.
    if (markerKind(wanted) === null) resolveVariation(f, t, wanted);
    const v = currentVariation(f, t);
    return v ? stateOf(t, v) : null;
  },

  diff(live, params) {
    return [diffTarget(live, params)];
  },

  async apply(actx, params) {
    assertNoPending(params, ADAPTER);
    const t = targetOf(actx, params);
    const client = api(actx);
    const wanted = wantedVariation(params);
    return retryingConflicts(async () => {
      // Always from a fresh read: `live` may be stale, and a target can only be in one variation at a time.
      const f = await loadFlag(client, t);
      const current = currentVariation(f, t);
      const desired = markerKind(wanted) === "keep" ? current : resolveVariation(f, t, wanted);
      if (!desired) throw paramError(ADAPTER, `${t.contextKind} ${t.key} is declared \`variation: { keep: true }\` but flag ${t.flag} does not target it`, "variation");
      if (current?._id === desired._id) return { ...stateOf(t, current), created: [] };
      const instructions = current ? [instruction("removeTargets", t, current), instruction("addTargets", t, desired)] : [instruction("addTargets", t, desired)];
      // Announce the create before sending it: a crash or a lost response must not orphan the target.
      if (!current) await actx.intend([resourceKey(t)]);
      actx.log(`${current ? "move" : "target"} ${t.contextKind} ${t.key} → ${describe(desired)} on ${t.flag}`);
      confirm(t, await patch(actx, client, t, instructions), desired);
      return { ...stateOf(t, desired), created: current ? [] : [resourceKey(t)] };
    });
  },

  /** Removes exactly the recorded target, from whichever variation serves it now; a gone flag or target is success. */
  async destroy(actx, resources) {
    const client = api(actx);
    for (const r of resources) {
      const parsed = parseKey(r.key);
      if (!parsed) throw new SponsonError("INTERNAL", `${ADAPTER}: cannot destroy ${r.key}: not a flag_target key`, { adapter: ADAPTER, key: r.key });
      const t: Target = { project: requireProvider(actx, "project", ADAPTER), environment: requireProvider(actx, "environment", ADAPTER), ...parsed };
      await retryingConflicts(async () => {
        let f: Flag;
        try {
          f = await loadFlag(client, t);
        } catch (e) {
          if (isProviderError(e, "PROVIDER_NOT_FOUND")) return;
          throw e;
        }
        const current = currentVariation(f, t);
        if (!current) return;
        actx.log(`untarget ${t.contextKind} ${t.key} on ${t.flag}`);
        confirm(t, await patch(actx, client, t, [instruction("removeTargets", t, current)]), null);
      });
    }
  },

  /** Every individual target of the line's flag in the environment, for drift (`unmanaged`) and `sponson init`. */
  async listScope(actx, params) {
    if (markerKind(params.flag) !== null) return [];
    const base = targetOf(actx, { ...params, key: "-" });
    const f = await loadFlag(api(actx), base);
    return [...f.targets].map(([id, i]) => {
      const [contextKind, key] = id.split("\u0000") as [string, string];
      return record({ ...base, contextKind, key }, f.variations[i]!);
    });
  },

  /** One line per target; the variation it is served now is kept, not copied. */
  adopt(resources) {
    return resources.flatMap((r) => {
      const t = parseKey(r.key);
      if (!t) return [];
      return [{ id: "flag_target", params: { flag: t.flag, key: t.key, context_kind: t.contextKind, variation: { keep: true } }, keys: [r.key] }];
    });
  },
};

/**
 * The LaunchDarkly adapter (`adapter: launchdarkly` in a plan): op `flag_target` serves a flag variation to one
 * context key (a preview URL, `pr-42`) in one environment. Registered in `createRegistry()`; needs
 * `LAUNCHDARKLY_ACCESS_TOKEN` and `providers.launchdarkly.project` / `.environment`.
 */
export const launchdarklyAdapter: ResourceAdapter = { name: ADAPTER, ops: { flag_target }, about: ABOUT };
