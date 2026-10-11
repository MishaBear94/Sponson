/**
 * The built-in `manual` adapter: op `step`, a change a person makes by hand because no API can (a Google OAuth web
 * client's redirect URIs, a Clerk webhook endpoint, a Stripe sandbox). The plan line says what to do; the engine
 * shows it as `todo` until a person confirms it (`apply --confirm <line>`) or its verify request sees it done, and
 * records who confirmed it and when (ADR 0021, `OpSpec.manual`). Nothing is ever sent to a provider except the
 * optional verify GET, made with the generic `http` adapter's client against an API block under `providers.manual`.
 */
import { SponsonError, canonicalJson, isFromRef, isKeepRef, isSecretRef, markerKind, sha256, walkParams, type AdapterContext, type ManualStep, type OpSpec, type ResolvedParams, type ResourceAdapter } from "@sponson/core";
import { paramError } from "./common.js";
import { isObject } from "./http.js";
import { httpClient, failedWith } from "./http-adapter-client.js";
import { at, fillPath, parseApi, placeholders, pointerTokens } from "./http-adapter-spec.js";

const ADAPTER = "manual";
/** Where a verify request's API is configured; declared for the generated docs. Steps without `verify` need nothing. */
const ABOUT = { credentialEnv: "none (verify: providers.manual.<api>.auth, optional)", baseUrlEnv: "providers.manual.<api>.base_url_env" } as const;

const PARAMS = ["title", "instructions", "undo", "vars", "verify"];
const VERIFY_KEYS = ["api", "path", "match", "absent_status"];
const KEY_PREFIX = "step:";

/** A verify request, checked: GET `path` on the API block `api`; done when it answers 2xx and every `match` holds. */
interface Verify {
  api: string;
  path: string;
  /** JSON pointer → the value the answer must have there. */
  match: Record<string, unknown>;
  /** Statuses (besides 404) that mean "not done yet". */
  absentStatus: number[];
}

function fail(message: string, param: string): SponsonError {
  return paramError(ADAPTER, message, param);
}

function textParam(params: Record<string, unknown>, name: string, required: boolean): unknown {
  const v = params[name];
  if (v === undefined || v === null) {
    if (required) throw fail(`\`${name}\` is required`, name);
    return undefined;
  }
  // Before resolution a `{ from }` stands for text; after it, a pending marker does.
  if (typeof v !== "string" && !isFromRef(v)) throw fail(`\`${name}\` must be text (Markdown), or a \`{ from }\` reference to text`, name);
  if (typeof v === "string" && markerKind(v) === null && v.trim() === "") throw fail(`\`${name}\` must not be blank`, name);
  return v;
}

function parseVerify(v: unknown): Verify | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) throw fail("`verify` must be a map: `{ api, path, match?, absent_status? }`", "verify");
  const extra = Object.keys(v).find((k) => !VERIFY_KEYS.includes(k));
  if (extra) throw fail(`\`verify.${extra}\` is not a verify key (known: ${VERIFY_KEYS.join(", ")})`, `verify.${extra}`);
  if (typeof v.api !== "string" || v.api === "") throw fail("`verify.api` is required: an API block under `providers.manual`", "verify.api");
  if (typeof v.path !== "string" || !v.path.startsWith("/")) throw fail("`verify.path` must be a path starting with \"/\" (relative to the API's base_url)", "verify.path");
  const match = v.match ?? {};
  if (!isObject(match) || Object.keys(match).some((p) => !p.startsWith("/"))) throw fail("`verify.match` must map JSON pointers (\"/status\") to the values the answer must have", "verify.match");
  const absent = v.absent_status ?? [];
  if (!Array.isArray(absent) || !absent.every((s) => Number.isInteger(s) && (s as number) >= 400 && (s as number) <= 599)) throw fail("`verify.absent_status` must be a list of HTTP error statuses (400–599)", "verify.absent_status");
  return { api: v.api, path: v.path, match, absentStatus: absent as number[] };
}

function varsOf(params: Record<string, unknown>): Record<string, unknown> {
  const v = params.vars ?? {};
  if (!isObject(v)) throw fail("`vars` must be a map of name → value", "vars");
  return v;
}

/** Every param checked; refuses unknown params and, before anything resolves them, secret references. */
function check(params: Record<string, unknown>): void {
  const extra = Object.keys(params).find((k) => !PARAMS.includes(k));
  if (extra) throw fail(`\`${extra}\` is not a parameter of manual.step (known: ${PARAMS.join(", ")})`, extra);
  textParam(params, "title", true);
  textParam(params, "instructions", true);
  textParam(params, "undo", false);
  const vars = varsOf(params);
  const verify = parseVerify(params.verify);
  for (const name of ["title", "instructions", "undo"]) {
    const t = params[name];
    if (typeof t === "string" && markerKind(t) === null) usedVars(t, vars, name);
  }
  if (verify) usedVars(verify.path, vars, "verify.path");
}

/** Placeholders `{name}` of a text must all be declared in `vars`, so a typo fails at plan time. */
function usedVars(text: string, vars: Record<string, unknown>, param: string): void {
  const unknown = placeholders(text).find((n) => !(n in vars));
  if (unknown) throw fail(`\`${param}\` uses \`{${unknown}}\`, which is not declared in \`vars\``, param);
}

/** `text` with every `{name}` replaced by its value from `vars`; undefined while a value is pending. */
function render(text: string, vars: Record<string, unknown>): string | undefined {
  const pending = placeholders(text).some((n) => markerKind(vars[n]) !== null);
  if (pending) return undefined;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n: string) => {
    const v = vars[n];
    if (typeof v === "object" && v !== null) throw fail(`\`vars.${n}\` must be a single value to fill \`{${n}}\``, `vars.${n}`);
    return String(v as string | number | boolean);
  });
}

/** A text param rendered; undefined while it (or a value it uses) is still pending. */
function rendered(params: ResolvedParams, name: string, vars: Record<string, unknown>): string | undefined {
  const t = params[name];
  if (t === undefined || markerKind(t) !== null) return undefined;
  return render(String(t), vars);
}

/** The step as a person sees it, or null while anything it shows is still pending. */
function stepOf(params: ResolvedParams): ManualStep | null {
  check(params);
  const vars = varsOf(params);
  const title = rendered(params, "title", vars);
  const instructions = rendered(params, "instructions", vars);
  const undo = params.undo === undefined ? undefined : rendered(params, "undo", vars);
  if (title === undefined || instructions === undefined || (params.undo !== undefined && undo === undefined)) return null;
  if (/[\r\n]/.test(title)) throw fail("`title` must be one line", "title");
  return {
    key: `${KEY_PREFIX}${title}`,
    title,
    instructions,
    ...(undo !== undefined ? { undo } : {}),
    hash: sha256(canonicalJson({ title, instructions })),
    observable: params.verify !== undefined && params.verify !== null,
  };
}

/** Whether the verify request sees the step done. A 404 (or an `absent_status`) means not yet. */
async function verified(actx: AdapterContext, verify: Verify, vars: Record<string, unknown>): Promise<boolean> {
  const path = fillPath(verify.path, vars);
  if (path === undefined) return false;
  const api = httpClient(actx, {}, { where: `providers.manual.${verify.api}`, authOptional: true, adapter: ADAPTER });
  let body: unknown;
  try {
    body = await api.get(path);
  } catch (e) {
    if (failedWith(e, "PROVIDER_NOT_FOUND", verify.absentStatus)) return false;
    throw e;
  }
  return Object.entries(verify.match).every(([pointer, want]) => canonicalJson(at(body, pointerTokens(pointer)) ?? null) === canonicalJson(want));
}

/** `manual.step`: one change a person makes by hand, confirmed by a person or seen by a verify request. */
const step: OpSpec = {
  outputs: {},

  /**
   * Checked before anything resolves: a secret has no place in instructions a person reads (and `plan` would show
   * them masked), so a `{ secret }` reference is refused here, before any provider call.
   */
  defaults(params) {
    walkParams(params, [], (path, v) => {
      const where = path.join(".");
      if (isSecretRef(v)) throw fail(`\`${where}\` is a secret reference; a manual step's text is shown to people and kept in receipts, so it may not carry a secret`, where);
      if (isKeepRef(v)) throw fail(`\`${where}\` is \`{ keep: true }\`; a manual step has no live value to keep`, where);
    });
    check(params);
    return params;
  },

  /** The verify request's API block, `providers.manual.<verify.api>`; nothing for a step without one. */
  providerFor(block, params) {
    const verify = isObject(params.verify) ? params.verify : undefined;
    if (!verify || typeof verify.api !== "string") return {};
    const cfg = block[verify.api];
    if (!isObject(cfg)) {
      const known = Object.keys(block);
      throw new SponsonError("PLAN_INVALID", `${ADAPTER}: providers.manual.${verify.api}: no API \`${verify.api}\` is configured for the verify request (known: ${known.length ? known.join(", ") : "none"})`, { adapter: ADAPTER, key: `providers.manual.${verify.api}` });
    }
    parseApi(cfg, `providers.manual.${verify.api}`, { authOptional: true });
    return cfg;
  },

  manual: (params) => stepOf(params),

  /** Done, as far as an API can tell: only a step with `verify` is ever seen; any other is known done only by confirmation. */
  async read(actx, params) {
    const s = stepOf(params);
    const verify = parseVerify(params.verify);
    if (!s || !verify || !(await verified(actx, verify, varsOf(params)))) return null;
    return { resources: [{ key: s.key, id: "manual", hash: s.hash, label: `manual step: ${s.title}` }], outputs: {} };
  },

  diff(live, params) {
    const s = stepOf(params);
    if (!s) return [{ key: `${KEY_PREFIX}(pending)`, kind: "create", label: "manual step", before: { state: "absent" }, after: { state: "pending" } }];
    const label = `manual step: ${s.title}`;
    return [live ? { key: s.key, kind: "unchanged", label } : { key: s.key, kind: "create", label, before: { state: "absent" }, after: { state: "literal", value: s.title } }];
  },

  /** Never called: the engine records a manual step (OpSpec.manual). */
  async apply() {
    throw new SponsonError("INTERNAL", `${ADAPTER}: a manual step is done by a person and recorded by the engine; apply must not be called`, { adapter: ADAPTER });
  },

  /** Nothing to delete at any provider: undoing a step is a person's job (its `undo`), confirmed on destroy. */
  async destroy() {},
};

/**
 * The `manual` adapter (`adapter: manual` in a plan): op `step`, a change a person makes by hand, shown as a todo
 * with its instructions until someone confirms it or its verify request sees it done (ADR 0021).
 */
export const manualAdapter: ResourceAdapter = { name: ADAPTER, ops: { step }, about: ABOUT };
