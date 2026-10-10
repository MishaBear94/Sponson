/**
 * Recipes: verified `http` specs for one provider's operations, shipped as YAML in `packages/adapters/recipes/`
 * (one file per provider), so that a plan line names an operation and fills in its typed params instead of writing
 * request templates (ADR 0020, docs/recipes.md).
 *
 *   providers: { http: { cloudflare: { recipe: cloudflare } } }       # optional: the recipe's API defaults
 *   - { id: dns, adapter: http, op: resource, recipe: cloudflare.dns_cname, zone_id: …, name: …, target: … }
 *
 * A recipe line expands, before anything else reads it, into the `http.resource` or `http.list_item` params the
 * recipe declares, with `{ param: <name> }` values and `{<name>}` path placeholders filled from the line. Identity
 * is never the recipe's text: the ledger records the resolved API block (base URL, credential variable names,
 * headers, encoding) and the keys and record ids the expanded requests produce, exactly as for a hand-written
 * line. Pure apart from reading the shipped files once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { SponsonError, markerKind } from "@sponson/core";
import { paramError } from "./common.js";
import { isObject } from "./http.js";

/** Where the shipped recipe files are, in the source tree and in the published package alike. */
export const RECIPES_DIR = fileURLToPath(new URL("../recipes/", import.meta.url));

/** The value types a recipe param takes. */
export type RecipeParamType = "string" | "integer" | "number" | "boolean" | "list" | "map";

/** One param a recipe op takes from the plan line. */
export interface RecipeParam {
  type: RecipeParamType;
  description: string;
  required?: boolean;
  /** Used when the line leaves the param out. */
  default?: unknown;
  /** Allowed values. */
  enum?: unknown[];
  /** A regular expression concrete string values must match. */
  pattern?: string;
  /** The value the docs' example line and the recipe tests use. */
  example?: unknown;
}

/** How the generic REST sim stands in for the provider in the recipe tests (`scenarios/recipes.test.ts`). */
export interface RecipeSimHints {
  /** The body field a create chooses the object's id with (a database name), when the provider takes one. */
  id_from?: string;
  /** The provider's ids are integers. */
  numeric_ids?: boolean;
  /** Objects to seed by path (placeholders filled from the example params): a list item's parent. */
  objects?: Record<string, Record<string, unknown>>;
}

/** One operation of a recipe: an `http.resource` or `http.list_item` spec with typed params. */
export interface RecipeOp {
  kind: "resource" | "list_item";
  title: string;
  summary: string;
  /** The ids of the rows of docs/coverage.yaml this op covers. */
  covers: string[];
  params: Record<string, RecipeParam>;
  /** The http op's params, minus `api`, `vars` and `destroy`; `{ param: <name> }` values and `{<name>}` placeholders. */
  http: Record<string, unknown>;
  /**
   * What destroying a scope does with what the op made, when the line does not say (`destroy:`). Absent: delete it.
   * `keep`: leave it (history shared beyond the scope, such as a release); a line may still say `destroy: delete`.
   * `never`: the provider offers no way to delete it, so it is always left and `destroy: delete` is PARAM_INVALID.
   */
  destroy?: "keep" | "never";
  sim?: RecipeSimHints;
  /** For `pnpm test:live`: the environment variable supplying each param that has no usable example live. */
  live?: { params?: Record<string, string> };
}

/** One assumption a recipe makes about its provider's API, numbered, verified against a source or not. */
export interface RecipeAssumption {
  id: string;
  text: string;
  verified: boolean;
  source?: string;
}

/** One provider's recipe file. */
export interface Recipe {
  provider: string;
  title: string;
  /** The id of a category of docs/coverage.yaml. */
  category: string;
  /** The date its API facts were checked against `docs`. */
  verified_on: string;
  docs: Array<{ title: string; url: string }>;
  assumptions: RecipeAssumption[];
  /** The API block defaults: what `providers.http.<api>: { recipe: <provider> }` means. */
  api: Record<string, unknown>;
  ops: Record<string, RecipeOp>;
}

const ADAPTER = "http";
const cache = new Map<string, Recipe>();

/** Recipes made known without a file (`useRecipe`), by provider. */
const unshipped = new Map<string, Recipe>();

/** The providers that have a recipe, sorted. */
export function recipeNames(): string[] {
  const files = readdirSync(RECIPES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length));
  return [...new Set([...files, ...unshipped.keys()])].sort();
}

/**
 * Make a recipe known for this process as if it were shipped, until the returned function is called. For tests of
 * code that recipes drive (the adapter's own tests use it for a list item recipe); not exported by the package.
 */
export function useRecipe(recipe: Recipe): () => void {
  unshipped.set(recipe.provider, recipe);
  cache.set(recipe.provider, recipe);
  return () => {
    unshipped.delete(recipe.provider);
    cache.delete(recipe.provider);
  };
}

/** A provider's recipe; PARAM_INVALID naming the known ones when there is none. */
export function loadRecipe(provider: string, param = "recipe"): Recipe {
  const cached = cache.get(provider);
  if (cached) return cached;
  const known = recipeNames();
  if (!known.includes(provider)) throw paramError(ADAPTER, `no recipe for \`${provider}\` (known: ${known.join(", ") || "none"})`, param);
  const recipe = parseYaml(readFileSync(`${RECIPES_DIR}${provider}.yaml`, "utf8")) as Recipe;
  // A malformed shipped file is a bug of this package (packages/adapters/src/recipes.test.ts checks every one).
  if (!isObject(recipe) || recipe.provider !== provider || !isObject(recipe.ops) || !isObject(recipe.api)) {
    throw new SponsonError("INTERNAL", `${ADAPTER}: recipes/${provider}.yaml is malformed`, { adapter: ADAPTER, recipe: provider });
  }
  cache.set(provider, recipe);
  return recipe;
}

/** Every shipped recipe. */
export function loadRecipes(): Recipe[] {
  return recipeNames().map((p) => loadRecipe(p));
}

/** A line's `recipe: <provider>.<op>`, located. */
export function recipeOp(ref: unknown): { recipe: Recipe; name: string; op: RecipeOp } {
  if (typeof ref !== "string" || !/^[a-z0-9][a-z0-9_-]*\.[a-z0-9_]+$/.test(ref)) {
    throw paramError(ADAPTER, "`recipe` must be `<provider>.<op>`, e.g. `cloudflare.dns_cname` (see docs/recipes.md)", "recipe");
  }
  const [provider, name] = ref.split(".") as [string, string];
  const recipe = loadRecipe(provider);
  const op = recipe.ops[name];
  if (!op) throw paramError(ADAPTER, `recipe \`${provider}\` has no op \`${name}\` (known: ${Object.keys(recipe.ops).join(", ")})`, "recipe");
  return { recipe, name, op };
}

/** The API a line uses: its `api`, or for a recipe line without one, the recipe's provider. */
export function lineApi(params: Record<string, unknown>): unknown {
  if (params.api !== undefined || typeof params.recipe !== "string") return params.api;
  return params.recipe.split(".")[0];
}

/** Params of a recipe line that are the line's own, not the recipe's. */
const LINE_PARAMS = ["api", "recipe", "destroy"];

/** A value the engine fills in later or keeps as it is: a reference, a marker, an uninterpolated `${…}`. */
function isDeferred(v: unknown): boolean {
  if (markerKind(v) !== null) return true;
  if (typeof v === "string") return v.includes("${");
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && ["from", "secret", "keep"].includes(keys[0]!);
}

const TYPE_CHECK: Record<RecipeParamType, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  list: (v) => Array.isArray(v),
  map: (v) => isObject(v),
};

function checkValue(where: string, name: string, p: RecipeParam, v: unknown): void {
  if (isDeferred(v)) return;
  const fail = (why: string) => paramError(ADAPTER, `${where}: \`${name}\` ${why}`, name);
  if (!TYPE_CHECK[p.type](v)) throw fail(`must be ${p.type === "integer" ? "an" : "a"} ${p.type} (${p.description})`);
  if (p.enum && !p.enum.some((e) => e === v)) throw fail(`must be one of ${p.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (p.pattern && typeof v === "string" && !new RegExp(p.pattern).test(v)) throw fail(`must match ${p.pattern} (${p.description})`);
}

/** The value of every param the line sets or the recipe defaults, checked; PARAM_INVALID naming the param otherwise. */
export function recipeValues(params: Record<string, unknown>): Record<string, unknown> {
  const { recipe, name, op } = recipeOp(params.recipe);
  const where = `recipe ${recipe.provider}.${name}`;
  const declared = Object.keys(op.params);
  const extra = Object.keys(params).find((k) => !LINE_PARAMS.includes(k) && !declared.includes(k));
  if (extra) throw paramError(ADAPTER, `${where}: \`${extra}\` is not one of its params (known: ${declared.join(", ")})`, extra);
  const values: Record<string, unknown> = {};
  for (const [p, spec] of Object.entries(op.params)) {
    const v = params[p] ?? spec.default;
    if (v === undefined || v === null) {
      if (spec.required) throw paramError(ADAPTER, `${where}: \`${p}\` is required: ${spec.description}`, p);
      continue;
    }
    checkValue(where, p, spec, v);
    values[p] = v;
  }
  return values;
}

/** `{ param: <name> }`, the one template form of a recipe's http spec. */
function paramRef(v: unknown): string | undefined {
  return isObject(v) && Object.keys(v).length === 1 && typeof v.param === "string" ? v.param : undefined;
}

/** `tpl` with every `{ param: <name> }` replaced by its value; a param without one removes its map key or list item. */
export function substitute(tpl: unknown, values: Record<string, unknown>): unknown {
  const ref = paramRef(tpl);
  if (ref !== undefined) return values[ref];
  if (Array.isArray(tpl)) return tpl.map((x) => substitute(x, values)).filter((x) => x !== undefined);
  if (!isObject(tpl)) return tpl;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tpl)) {
    const s = substitute(v, values);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * A line's params as the `http.<kind>` op reads them: unchanged without `recipe`, else the recipe's spec with the
 * line's values filled in (`vars` holds every value, for the `{<name>}` path placeholders).
 */
export function expandRecipe(params: Record<string, unknown>, kind: RecipeOp["kind"]): Record<string, unknown> {
  if (params.recipe === undefined) return params;
  const { recipe, name, op } = recipeOp(params.recipe);
  if (op.kind !== kind) throw paramError(ADAPTER, `recipe ${recipe.provider}.${name} is an \`http.${op.kind}\` recipe: write \`op: ${op.kind}\``, "recipe");
  const values = recipeValues(params);
  const spec = substitute(op.http, values) as Record<string, unknown>;
  const destroy = recipeDestroy(`recipe ${recipe.provider}.${name}`, op, params.destroy);
  return { ...spec, api: lineApi(params), vars: values, ...(destroy !== undefined ? { destroy } : {}) };
}

/** The line's `destroy`, or the op's default; `delete` of an op the provider cannot delete is PARAM_INVALID. */
function recipeDestroy(where: string, op: RecipeOp, line: unknown): unknown {
  if (op.destroy === "never" && line !== undefined && line !== "keep") {
    throw paramError(ADAPTER, `${where}: the provider offers no way to delete what it makes, so it is always left in place: remove \`destroy\` or write \`destroy: keep\``, "destroy");
  }
  return line ?? (op.destroy === undefined ? undefined : "keep");
}

/**
 * A `providers.http.<api>` block with `recipe:`, resolved: the recipe's API defaults, then the block's own keys
 * over them. Blocks without `recipe:` are returned as they are. The result never names the recipe, so it (and with
 * it the ledger identity) is the same as a hand-written block with the same values.
 */
export function resolveRecipeApi(block: Record<string, unknown>, where: string): Record<string, unknown> {
  if (block.recipe === undefined) return block;
  const known = recipeNames();
  const { recipe: provider, ...overrides } = block;
  if (typeof provider !== "string" || !known.includes(provider)) {
    throw new SponsonError("PLAN_INVALID", `${ADAPTER}: ${where}.recipe: no recipe \`${String(provider)}\` (known: ${known.join(", ")})`, { adapter: ADAPTER, key: `${where}.recipe` });
  }
  return { ...loadRecipe(provider).api, ...overrides };
}
