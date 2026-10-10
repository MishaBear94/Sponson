/**
 * Simulated LaunchDarkly: feature flags per project, with each environment's individual targets (a context key of a
 * context kind served one variation).
 *
 * Assumptions about the real API that this fake encodes, each marked with how far it is checked. "Verified" means
 * against LaunchDarkly's published REST API reference (fetched 2026-10-11): the API overview
 * https://launchdarkly.com/docs/api, "Get feature flag" https://launchdarkly.com/docs/api/feature-flags/get-feature-flag
 * and "Update feature flag" https://launchdarkly.com/docs/api/feature-flags/patch-feature-flag; see
 * docs/api-verification.md:
 *   LD1. The access token is the whole `Authorization` value, with no `Bearer` prefix (verified: "The value of the
 *        `Authorization` header must be your access token"). The base URL is https://app.launchdarkly.com/api/v2
 *        (verified from the OpenAPI document's location; federal and EU instances use other hosts). The sim
 *        refuses a `Bearer` header with 401.
 *   LD2. `GET /flags/{projectKey}/{featureFlagKey}?env=<key>` answers the flag with `variations[]` (`_id`, `value`,
 *        optional `name`) and `environments.<key>` restricted to that environment (verified). An unknown project or
 *        flag is 404 (verified: "Invalid resource identifier"). An environment the project lacks is absent from
 *        `environments` (unverified: whether LaunchDarkly answers 404 or an empty map instead; the adapter
 *        reports either as not found).
 *   LD3. An environment's individual targets are `targets[]` (context kind `user`) and `contextTargets[]` (every
 *        other kind), items `{ contextKind, values, variation }` where `variation` is an index into `variations`
 *        (verified). `contextTargets` also lists, for each variation with user targets, a placeholder
 *        `{ contextKind: "user", values: [] }` (unverified, observed behaviour reported by SDK users; the adapter
 *        reads both arrays and ignores empty entries, so it does not depend on it).
 *   LD4. `PATCH /flags/{projectKey}/{featureFlagKey}` with `Content-Type: application/json;
 *        domain-model=launchdarkly.semanticpatch` and `{ environmentKey, instructions, comment? }` applies the
 *        instructions; without that media type the body is read as a JSON patch and a semantic patch is 400
 *        (verified). It answers 200 with the whole flag (verified). Instructions are all or nothing: one invalid
 *        instruction and nothing changes (verified).
 *   LD5. `addTargets { contextKind, values, variationId }` (`contextKind` defaults to `user`) is refused (400)
 *        when it would make a context key targeted by two variations (verified that it is an error; the status
 *        is unverified). Adding a key already targeted by the same variation changes nothing and succeeds
 *        (unverified: the docs say only that a semantic patch updates the flag "only where needed"; pinned by the
 *        contract suite). `removeTargets` with the same fields does nothing for a key not targeted (verified).
 *   LD6. An environment that requires approvals answers 405 to a flag change (verified); a concurrent change
 *        answers 409, to be retried (verified). The error body is `{ code, message }` (verified).
 *   LD7. The PATCH takes effect at once: the next GET shows it (unverified; pinned by the contract suite).
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** The media type of a semantic patch (LD4). */
export const LAUNCHDARKLY_SEMANTIC_PATCH = "application/json; domain-model=launchdarkly.semanticpatch";

/** One variation of a flag. */
export interface LaunchdarklyVariation {
  _id: string;
  value: unknown;
  name?: string;
}

/** One individual target: a context key of a kind, served the variation at `variation` (an index). */
export interface LaunchdarklyTarget {
  contextKind: string;
  key: string;
  variation: number;
  createdBy: CreatedBy;
}

/** A flag's configuration in one environment, as far as the sim models it. */
export interface LaunchdarklyFlagEnv {
  on: boolean;
  version: number;
  targets: LaunchdarklyTarget[];
}

/** One feature flag. */
export interface LaunchdarklyFlag {
  key: string;
  variations: LaunchdarklyVariation[];
  version: number;
  environments: Record<string, LaunchdarklyFlagEnv>;
}

/** One project: its environments (and which need approvals) and its flags. */
export interface LaunchdarklyProject {
  environments: string[];
  approvals: string[];
  flags: Record<string, LaunchdarklyFlag>;
}

/** The simulated LaunchDarkly's state: projects by key. */
export interface LaunchdarklyState {
  projects: Record<string, LaunchdarklyProject>;
}

/** What a scenario or test seeds the simulated LaunchDarkly with (`seed: { launchdarkly: … }`). */
export interface LaunchdarklySeed {
  projects: Record<
    string,
    {
      environments?: string[];
      /** Environments whose flag changes need an approval request (LD6). */
      approvals?: string[];
      flags?: Record<
        string,
        {
          variations?: Array<{ value: unknown; name?: string }>;
          /** Environment key → targets that exist already (made "by a human", so unmanaged). */
          targets?: Record<string, Array<{ contextKind?: string; key: string; variation: number }>>;
        }
      >;
    }
  >;
}

const BOOLEAN = [
  { value: true, name: "on" },
  { value: false, name: "off" },
];

/** The simulated LaunchDarkly API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/launchdarkly`. */
export const launchdarklySim: ProviderSim<LaunchdarklyState, LaunchdarklySeed> = {
  env: { token: "LAUNCHDARKLY_ACCESS_TOKEN", url: "LAUNCHDARKLY_API_URL", testToken: "api-sim-launchdarkly" },
  auth: "raw",
  defaultSeed: { projects: { demo: { environments: ["preview", "production"], flags: { "new-checkout": {} } } } },

  reset(core, seed) {
    const projects: LaunchdarklyState["projects"] = {};
    for (const [key, p] of Object.entries(seed?.projects ?? {})) {
      const environments = p.environments ?? ["preview", "production"];
      const flags: Record<string, LaunchdarklyFlag> = {};
      for (const [flagKey, f] of Object.entries(p.flags ?? {})) flags[flagKey] = flag(core, flagKey, environments, f);
      projects[key] = { environments, approvals: p.approvals ?? [], flags };
    }
    return { projects };
  },

  /**
   * `target.<flag>/<environment>/<contextKind>/<key>` (or `launchdarkly:<project>.target.…`): "delete", or a
   * variation name or index to move the target to — what a human in the LaunchDarkly console would do.
   */
  drift(_core, state, { key, rest, value, only }) {
    if (!rest.startsWith("target.")) return false;
    const [flagKey, envKey, kind, ...target] = rest.slice("target.".length).split("/");
    const contextKey = target.join("/");
    let hit = false;
    for (const [id, p] of Object.entries(state.projects)) {
      if (only !== undefined && id !== only) continue;
      const f = p.flags[flagKey ?? ""];
      const env = f?.environments[envKey ?? ""];
      const t = env?.targets.find((x) => x.contextKind === kind && x.key === contextKey);
      if (!f || !env || !t) continue;
      hit = true;
      if (value === "delete") env.targets = env.targets.filter((x) => x !== t);
      else t.variation = variationIndex(f, value, key);
      env.version++;
    }
    if (!hit) throw new Error(`drift ${key}: no such target`);
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function variationIndex(f: LaunchdarklyFlag, value: string, key: string): number {
  const byName = f.variations.findIndex((v) => v.name === value);
  if (byName >= 0) return byName;
  if (/^\d+$/.test(value) && Number(value) < f.variations.length) return Number(value);
  throw new Error(`drift ${key}: flag ${f.key} has no variation ${value}`);
}

/** The API, one route per method and path, under `/api/v2` (part of the base URL). */
const routes = router<LaunchdarklyState>(
  [
    route("GET", "/flags/:project/:flag", ({ state, params, url }) => {
      const f = state.projects[params.project]?.flags[params.flag];
      if (!f) return ldError(404, "not_found", "Unknown resource");
      return new Reply(200, publicFlag(f, url.searchParams.get("env")));
    }),

    route("PATCH", "/flags/:project/:flag", ({ state, params, body, headers }) => {
      if (!(headers["content-type"] ?? "").replace(/\s+/g, "").includes("domain-model=launchdarkly.semanticpatch")) {
        return ldError(400, "invalid_request", "Invalid JSON patch: expected an array of operations");
      }
      const p = state.projects[params.project];
      const f = p?.flags[params.flag];
      if (!p || !f) return ldError(404, "not_found", "Unknown resource");
      const b = (body ?? {}) as { environmentKey?: unknown; instructions?: unknown };
      if (typeof b.environmentKey !== "string" || !f.environments[b.environmentKey]) return ldError(400, "invalid_request", "environmentKey is required and must name an environment");
      if (!Array.isArray(b.instructions) || b.instructions.length === 0) return ldError(400, "invalid_request", "instructions are required");
      if (p.approvals.includes(b.environmentKey)) return ldError(405, "method_not_allowed", "This environment requires approval for changes to flags");
      const env = f.environments[b.environmentKey]!;
      // All or nothing (LD4): work on a copy, keep it only if every instruction was valid.
      const next = env.targets.map((t) => ({ ...t }));
      for (const ins of b.instructions) {
        const problem = applyInstruction(f, next, ins);
        if (problem) return ldError(400, "invalid_request", problem);
      }
      if (JSON.stringify(next) !== JSON.stringify(env.targets)) {
        env.targets = next;
        env.version++;
        f.version++;
      }
      return new Reply(200, publicFlag(f, null));
    }),
  ],
  () => ldError(404, "not_found", "Unknown resource"),
);

/** One `addTargets` / `removeTargets` instruction against `targets`; a message when it is invalid. */
function applyInstruction(f: LaunchdarklyFlag, targets: LaunchdarklyTarget[], ins: unknown): string | null {
  const i = parseInstruction(f, ins);
  if (typeof i === "string") return i;
  const { contextKind, variation } = i;
  for (const key of i.values) {
    const at = targets.findIndex((t) => t.contextKind === contextKind && t.key === key);
    if (i.kind === "removeTargets") {
      if (at >= 0 && targets[at]!.variation === variation) targets.splice(at, 1);
      continue;
    }
    if (at >= 0 && targets[at]!.variation !== variation) return `${contextKind} ${key} is already targeted by another variation`;
    if (at < 0) targets.push({ contextKind, key, variation, createdBy: "api" });
  }
  return null;
}

/** One instruction, validated; a message when it is not one the sim implements or is malformed. */
function parseInstruction(f: LaunchdarklyFlag, ins: unknown): { kind: "addTargets" | "removeTargets"; contextKind: string; values: string[]; variation: number } | string {
  const i = (ins ?? {}) as { kind?: unknown; contextKind?: unknown; values?: unknown; variationId?: unknown };
  if (i.kind !== "addTargets" && i.kind !== "removeTargets") return `unsupported instruction kind ${String(i.kind)}`;
  const variation = f.variations.findIndex((v) => v._id === i.variationId);
  if (variation < 0) return `unknown variationId ${String(i.variationId)}`;
  if (!Array.isArray(i.values) || i.values.some((v) => typeof v !== "string")) return "values must be a list of context keys";
  const contextKind = typeof i.contextKind === "string" && i.contextKind !== "" ? i.contextKind : "user";
  return { kind: i.kind, contextKind, values: i.values as string[], variation };
}

/** The flag representation (LD2, LD3), restricted to one environment when `env` names one. */
function publicFlag(f: LaunchdarklyFlag, env: string | null) {
  const environments: Record<string, unknown> = {};
  for (const [key, e] of Object.entries(f.environments)) {
    if (env !== null && key !== env) continue;
    const user = groups(e.targets.filter((t) => t.contextKind === "user"));
    const other = groups(e.targets.filter((t) => t.contextKind !== "user"));
    const placeholders = user.map((g) => ({ contextKind: "user", values: [], variation: g.variation }));
    environments[key] = { on: e.on, version: e.version, _environmentName: key, targets: user, contextTargets: [...other, ...placeholders] };
  }
  return { key: f.key, _version: f.version, variations: f.variations, environments };
}

/** Targets grouped the way LaunchDarkly lists them: one entry per (kind, variation). */
function groups(targets: LaunchdarklyTarget[]): Array<{ contextKind: string; values: string[]; variation: number }> {
  const out: Array<{ contextKind: string; values: string[]; variation: number }> = [];
  for (const t of targets) {
    const g = out.find((x) => x.contextKind === t.contextKind && x.variation === t.variation);
    if (g) g.values.push(t.key);
    else out.push({ contextKind: t.contextKind, values: [t.key], variation: t.variation });
  }
  return out;
}

function flag(core: SimCore, key: string, environments: string[], seed: NonNullable<LaunchdarklySeed["projects"][string]["flags"]>[string]): LaunchdarklyFlag {
  const variations = (seed.variations ?? BOOLEAN).map((v) => ({ _id: core.nextId("var_"), value: v.value, ...(v.name !== undefined ? { name: v.name } : {}) }));
  const envs: Record<string, LaunchdarklyFlagEnv> = {};
  for (const e of environments) {
    const targets = (seed.targets?.[e] ?? []).map((t) => ({ contextKind: t.contextKind ?? "user", key: t.key, variation: t.variation, createdBy: "sim" as const }));
    envs[e] = { on: true, version: 1, targets };
  }
  return { key, variations, version: 1, environments: envs };
}

/** LaunchDarkly's error body (LD6). */
function ldError(status: number, code: string, message: string): Reply {
  return new Reply(status, { code, message });
}
