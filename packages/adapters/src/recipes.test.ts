/**
 * Every shipped recipe (packages/adapters/recipes/*.yaml) is well-formed and complete, expands into a valid http
 * spec, and keeps the ledger identity it had: the checks that make adding a recipe a mechanical task. Its
 * create / re-apply / drift / destroy lifecycle runs end to end in scenarios/recipes.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { isSponsonError, resolveParams } from "@sponson/core";
import { httpAdapter } from "./http-adapter.js";
import { actionIdentity, parseAction } from "./http-adapter-action.js";
import { listItemIdentity } from "./http-adapter-list.js";
import { resourceIdentity } from "./http-adapter-resource.js";
import { apiBlock, parseListItem, parseResource, placeholders } from "./http-adapter-spec.js";
import { RECIPES_DIR, expandRecipe, loadRecipe, loadRecipes, recipeNames, resolveRecipeApi, substitute, useRecipe, type Recipe, type RecipeOp } from "./recipes.js";
import { harness } from "./testing.js";

const CTX = { env: "preview", git: { branch: "feat/x", sha: "0123456789abcdef0123456789abcdef01234567", short_sha: "0123456" }, pr: { number: 42 }, scope: "pr-42" };
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const schema = JSON.parse(readFileSync(`${REPO}schema/recipe.schema.json`, "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);
const coverage = parseYaml(readFileSync(`${REPO}docs/coverage.yaml`, "utf8")) as { categories: Array<{ id: string; rows: Array<{ id: string; covered_by?: unknown }> }> };
const ROWS = new Map(coverage.categories.flatMap((c) => c.rows.map((r) => [r.id, r] as const)));

const resource = httpAdapter.ops.resource!;
const listItem = httpAdapter.ops.list_item!;
const action = httpAdapter.ops.action!;

const cases = loadRecipes().flatMap((r) => Object.entries(r.ops).map(([name, op]) => [`${r.provider}.${name}`, r, name, op] as const));

/** The example values with `${ctx.*}` filled as for PR 42, as the engine would hand them over. */
function exampleLine(r: Recipe, name: string, op: RecipeOp): Record<string, unknown> {
  const params = Object.fromEntries(Object.entries(op.params).flatMap(([p, s]) => (s.example === undefined ? [] : [[p, s.example]])));
  const text = JSON.stringify(params)
    .replace(/\$\{ctx\.scope\}/g, "pr-42")
    .replace(/\$\{ctx\.env\}/g, "preview")
    .replace(/\$\{ctx\.git\.sha\}/g, "0123456789abcdef0123456789abcdef01234567")
    .replace(/\$\{ctx\.git\.branch\}/g, "feat/x");
  return { recipe: `${r.provider}.${name}`, ...(JSON.parse(text) as Record<string, unknown>) };
}

/**
 * The `providers.http` blocks an example line needs: none, or for a per-account API (no default `base_url`) one
 * that sets the recipe's `base_url_example`.
 */
function blocksFor(r: Recipe): Record<string, unknown> {
  return r.api && r.api.base_url === undefined ? { [r.provider]: { recipe: r.provider, base_url: r.base_url_example } } : {};
}

/** The API block an example line resolves to. */
function resolvedApi(r: Recipe): Record<string, unknown> {
  // A recipe without an API block (only `url` actions): its lines use no block at all.
  if (!r.api) return {};
  return r.api.base_url === undefined ? { ...r.api, base_url: r.base_url_example } : r.api;
}

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (isSponsonError(e)) return `${e.code}: ${e.message}`;
    throw e;
  }
  return "(no error)";
}

it("there is at least one recipe, and every file is named after its provider", () => {
  expect(recipeNames().length).toBeGreaterThan(0);
  for (const name of recipeNames()) expect(loadRecipe(name).provider).toBe(name);
});

describe.each(recipeNames())("recipes/%s.yaml", (name) => {
  const raw = parseYaml(readFileSync(`${RECIPES_DIR}${name}.yaml`, "utf8")) as unknown;

  it("validates against schema/recipe.schema.json", () => {
    validate(raw);
    expect(validate.errors ?? []).toEqual([]);
  });

  it("has complete metadata: a coverage category, sources, numbered assumptions, a resolvable API block", () => {
    const r = loadRecipe(name);
    expect(coverage.categories.map((c) => c.id), "category is a docs/coverage.yaml category").toContain(r.category);
    expect(new Set(r.assumptions.map((a) => a.id)).size, "assumption ids are unique").toBe(r.assumptions.length);
    if (!r.api) {
      // Only actions sent to the app's own URL may do without an API block (and its credential).
      for (const op of Object.values(r.ops)) expect({ kind: op.kind, url: (op.http.request as { url?: unknown } | undefined)?.url !== undefined }).toEqual({ kind: "action", url: true });
      return;
    }
    const block = apiBlock(blocksFor(r), { recipe: `${name}.${Object.keys(r.ops)[0]!}` });
    expect(block).toEqual(resolvedApi(r));
    // `sponson init --setup` shows where its credential is made and what to pick (docs/providers.md lists them too).
    expect(r.credential, "an API block's credential says where it is created (`credential`)").toBeDefined();
  });

  it("its `detect` block (when it has one) names its own ops and params, and init's values pass the params' checks", () => {
    const d = loadRecipe(name).detect;
    if (!d) return;
    const r = loadRecipe(name);
    const starters = d.starter ?? [{ op: Object.keys(r.ops)[0]! }];
    const params = new Set<string>(r.api && typeof r.api.base_url !== "string" ? ["base_url"] : []);
    for (const st of starters) {
      const op = r.ops[st.op];
      expect(op, `starter op ${st.op}`).toBeDefined();
      for (const p of Object.keys(op!.params)) params.add(p);
      if (st.preview_url) expect(op!.params[st.preview_url]?.type, `preview_url ${st.preview_url}`).toBe("string");
      for (const p of Object.keys(st.values ?? {})) expect(Object.keys(op!.params), `value for ${p}`).toContain(p);
      const line = { recipe: `${name}.${st.op}`, ...exampleParams(op!), ...st.values };
      expect(() => expandRecipe(line, op!.kind), st.op).not.toThrow();
    }
    for (const p of Object.keys(d.where ?? {})) expect([...params], `where.${p}`).toContain(p);
  });
});

/** Every param with an example, as a docs example line sets them. */
function exampleParams(op: RecipeOp): Record<string, unknown> {
  return Object.fromEntries(Object.entries(op.params).flatMap(([n, p]) => (p.example === undefined ? [] : [[n, p.example]])));
}

describe.each(cases)("recipe %s", (_ref, r, name, op) => {
  const line = exampleLine(r, name, op);

  it("names coverage rows that exist and say they are covered by it", () => {
    for (const id of op.covers) {
      expect(ROWS.has(id), `docs/coverage.yaml has no row \`${id}\``).toBe(true);
      const by = ROWS.get(id)!.covered_by;
      expect([by].flat(), `row ${id} covered_by`).toContain(`recipe:${r.provider}.${name}`);
    }
  });

  it("uses in its paths only params that always have a value, and every param it declares", () => {
    const always = Object.entries(op.params).filter(([, p]) => p.required === true || p.default !== undefined).map(([p]) => p);
    const text = JSON.stringify(op.http);
    const paths = [...text.matchAll(/"(?:path|read_path)":"([^"]*)"/g)].map((m) => m[1]!);
    for (const ph of paths.flatMap(placeholders)) if (ph !== "id") expect(always, `path placeholder {${ph}}`).toContain(ph);
    for (const p of Object.keys(op.params)) expect(text.includes(`{"param":"${p}"}`) || paths.some((x) => x.includes(`{${p}}`)), `param \`${p}\` is used`).toBe(true);
    const used = [...text.matchAll(/\{"param":"([^"]+)"\}/g)].map((m) => m[1]!);
    for (const u of used) expect(Object.keys(op.params), `{ param: ${u} }`).toContain(u);
  });

  it("expands its example into a valid http spec, its outputs and its provider block", () => {
    const expanded = expandRecipe(line, op.kind);
    expect(expanded.api).toBe(r.api ? r.provider : undefined);
    if (op.kind === "action") {
      expect(() => parseAction(line)).not.toThrow();
      expect(Object.keys(action.outputsFor!(line))).toEqual(Object.keys((op.http.outputs as object | undefined) ?? {}));
      expect(action.action!(resolveParams(line, new Map(), new Map()).params, CTX)).toMatchObject({ trigger: expect.any(Object) });
    } else if (op.kind === "resource") {
      expect(() => parseResource(line)).not.toThrow();
      expect(Object.keys(resource.outputsFor!(line))).toEqual(["id", ...Object.keys((op.http.outputs as object | undefined) ?? {})]);
    } else {
      expect(() => parseListItem(line)).not.toThrow();
      expect(listItem.outputsFor!(line)).toEqual({});
    }
    expect(httpAdapter.ops[op.kind]!.providerFor!(blocksFor(r), line)).toEqual(resolvedApi(r));
  });

  it("checks its params at plan time: missing, unknown and mistyped are PARAM_INVALID naming the param", () => {
    const required = Object.entries(op.params).find(([, p]) => p.required);
    if (required) {
      const { [required[0]]: _dropped, ...without } = line;
      expect(codeOf(() => expandRecipe(without, op.kind))).toMatch(new RegExp(`^PARAM_INVALID: .*\`${required[0]}\` is required`));
    }
    expect(codeOf(() => expandRecipe({ ...line, nope: 1 }, op.kind))).toMatch(/^PARAM_INVALID: .*`nope` is not one of its params \(known: /);
    const [pname, p] = Object.entries(op.params)[0]!;
    const wrong = p.type === "string" ? 42 : "not-a-" + p.type;
    expect(codeOf(() => expandRecipe({ ...line, [pname]: wrong }, op.kind))).toMatch(new RegExp(`^PARAM_INVALID: .*\`${pname}\` must be`));
    // References are checked by the engine, not here.
    expect(() => expandRecipe({ ...line, [pname]: { from: "other.output" } }, op.kind)).not.toThrow();
    const other = op.kind === "resource" ? "list_item" : "resource";
    expect(codeOf(() => expandRecipe(line, other))).toMatch(new RegExp(`^PARAM_INVALID: .*write \`op: ${op.kind}\``));
  });
});

describe("recipe errors", () => {
  it("an unknown recipe or op lists the known ones", () => {
    expect(codeOf(() => expandRecipe({ recipe: "nope.thing" }, "resource"))).toMatch(new RegExp(`^PARAM_INVALID: .*no recipe for \`nope\` \\(known: ${recipeNames().join(", ")}\\)`));
    const r = loadRecipes()[0]!;
    expect(codeOf(() => expandRecipe({ recipe: `${r.provider}.nope` }, "resource"))).toMatch(new RegExp(`has no op \`nope\` \\(known: ${Object.keys(r.ops).join(", ")}\\)`));
    expect(codeOf(() => expandRecipe({ recipe: "Not A Ref" }, "resource"))).toMatch(/^PARAM_INVALID: .*`recipe` must be `<provider>\.<op>`/);
  });

  it("an enum or pattern a value misses is PARAM_INVALID", () => {
    const r = loadRecipe("cloudflare");
    expect(codeOf(() => expandRecipe({ ...exampleLine(r, "dns_cname", r.ops.dns_cname!), zone_id: "not-hex" }, "resource"))).toMatch(/`zone_id` must match/);
  });

  it("a provider block names a recipe that exists, matches the line's, and may override any key", () => {
    const ref = "cloudflare.dns_cname";
    expect(codeOf(() => apiBlock({ cloudflare: { recipe: "nope" } }, { recipe: ref }))).toMatch(/^PLAN_INVALID: .*providers\.http\.cloudflare\.recipe: no recipe `nope` \(known: /);
    expect(codeOf(() => apiBlock({ cloudflare: { recipe: "turso" } }, { recipe: ref }))).toMatch(/^PLAN_INVALID: .*uses recipe `turso`, but the line's recipe is `cloudflare\.dns_cname`/);
    expect(codeOf(() => apiBlock({}, { api: "other", recipe: ref }))).toMatch(/^PLAN_INVALID: .*no API `other` is configured/);
    const eu = apiBlock({ eu: { recipe: "cloudflare", base_url: "https://eu.example.test/v4", auth: { bearer_env: "EU_CLOUDFLARE_TOKEN" } } }, { api: "eu", recipe: ref });
    expect(eu).toEqual({ ...loadRecipe("cloudflare").api, base_url: "https://eu.example.test/v4", auth: { bearer_env: "EU_CLOUDFLARE_TOKEN" } });
    expect(codeOf(() => apiBlock({ x: { recipe: "cloudflare", nope: 1 } }, { api: "x", recipe: ref }))).toMatch(/^PLAN_INVALID: .*unknown key `nope`/);
    // A recipe's credential refusal is a safety rule: a block cannot override it.
    const guarded = loadRecipes().find((x) => x.api?.refuse_credential !== undefined);
    if (guarded) {
      const gref = `${guarded.provider}.${Object.keys(guarded.ops)[0]!}`;
      expect(codeOf(() => apiBlock({ [guarded.provider]: { recipe: guarded.provider, refuse_credential: null } }, { recipe: gref }))).toMatch(/^PLAN_INVALID: .*`refuse_credential` comes from the recipe and cannot be overridden/);
    }
    // A hand-written line may use a recipe's API defaults too.
    expect(apiBlock({ cf: { recipe: "cloudflare" } }, { api: "cf" })).toEqual(loadRecipe("cloudflare").api);
    expect(resolveRecipeApi({ base_url: "https://x.test" }, "w")).toEqual({ base_url: "https://x.test" });
  });

  it("a recipe API without a default base_url needs one in the block", () => {
    const r = loadRecipe("turso");
    const saved = r.api;
    try {
      r.api = { ...saved };
      delete r.api.base_url;
      expect(codeOf(() => apiBlock({}, { recipe: "turso.database_branch" }))).toMatch(/has no default `base_url`/);
    } finally {
      r.api = saved;
    }
  });

  it("an op's `destroy` sets the line's default: `keep` may be overridden, `never` refuses `destroy: delete`", () => {
    const op = (destroy?: "keep" | "never"): RecipeOp => ({
      kind: "resource",
      title: "Marker",
      summary: "A marker that stays as history.",
      covers: [],
      params: { name: { type: "string", required: true, description: "The name.", example: "m" } },
      http: { read: { path: "/markers/{name}" }, create: { path: "/markers" } },
      ...(destroy ? { destroy } : {}),
    });
    const forget = useRecipe({ ...ORIGINS, provider: "history", ops: { plain: op(), kept: op("keep"), undeletable: op("never") } });
    try {
      const line = (o: string, extra: Record<string, unknown> = {}) => ({ recipe: `history.${o}`, name: "m", ...extra });
      expect(expandRecipe(line("plain"), "resource")).not.toHaveProperty("destroy");
      expect(parseResource(line("plain")).destroy).toBe("delete");
      expect(parseResource(line("kept")).destroy).toBe("keep");
      expect(parseResource(line("kept", { destroy: "delete" })).destroy).toBe("delete");
      expect(parseResource(line("undeletable")).destroy).toBe("keep");
      expect(parseResource(line("undeletable", { destroy: "keep" })).destroy).toBe("keep");
      expect(codeOf(() => parseResource(line("undeletable", { destroy: "delete" })))).toMatch(/^PARAM_INVALID: .*recipe history\.undeletable: the provider offers no way to delete/);
      expect(resourceIdentity(parseResource(line("undeletable")), "ID").id).toBe("KEEP /markers/m");
    } finally {
      forget();
    }
  });

  it("substitutes whole values, drops absent optional ones, and leaves lines without `recipe` alone", () => {
    expect(substitute({ a: { param: "x" }, b: [{ param: "y" }, 1], c: { d: { param: "x" } } }, { x: "X" })).toEqual({ a: "X", b: [1], c: { d: "X" } });
    // `{ join }` concatenates whole values; a value not known yet stands for the whole, a missing one removes it.
    const tpl = { url: { join: [{ param: "base" }, { param: "path" }] }, n: { join: ["v", { param: "n" }] } };
    expect(substitute(tpl, { base: "https://pr-42.example.app", path: "/api/hooks", n: 2 })).toEqual({ url: "https://pr-42.example.app/api/hooks", n: "v2" });
    const pending = resolveParams({ x: { from: "web.preview_url" } }, new Map(), new Map()).params.x;
    expect(substitute(tpl, { base: pending, path: "/api/hooks", n: 1 })).toEqual({ url: pending, n: "v1" });
    expect(substitute(tpl, { base: { from: "web.preview_url" }, path: "/p" })).toEqual({ url: { from: "web.preview_url" } });
    expect(substitute(tpl, { base: "https://${ctx.scope}.example.app", path: "/p", n: 0 })).toEqual({ url: "https://${ctx.scope}.example.app/p", n: "v0" });
    const plain = { api: "a", create: { path: "/x" } };
    expect(expandRecipe(plain, "resource")).toBe(plain);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Identity lock

const LOCK = fileURLToPath(new URL("./recipes-identity.json", import.meta.url));

/** What the ledger would record for the op's example line: the resolved API block, the key and the record id. */
function identityOf(r: Recipe, name: string, op: RecipeOp): unknown {
  const line = exampleLine(r, name, op);
  const provider = httpAdapter.ops[op.kind]!.providerFor!(blocksFor(r), line);
  const ident = op.kind === "resource" ? resourceIdentity(parseResource(line), "ID") : op.kind === "action" ? actionIdentity(parseAction(line)) : listItemIdentity(parseListItem(line));
  return { provider, ...ident };
}

/**
 * A recipe change that alters what the ledger records (the API block, a key or a record id) re-identifies every
 * resource made with it: an upgrade would orphan them and create them again. That must be a decision, not an
 * accident: update the lock (`SPONSON_UPDATE_RECIPE_LOCK=1 pnpm vitest run packages/adapters/src/recipes.test.ts`)
 * and ship the change with a **Breaking:** changeset that says to destroy affected scopes before upgrading.
 */
it("no recipe change re-identifies applied resources (packages/adapters/src/recipes-identity.json)", () => {
  const actual = Object.fromEntries(cases.map(([ref, r, name, op]) => [ref, identityOf(r, name, op)]));
  if (process.env.SPONSON_UPDATE_RECIPE_LOCK === "1") writeFileSync(LOCK, `${JSON.stringify(actual, null, 2)}\n`);
  const locked = JSON.parse(readFileSync(LOCK, "utf8")) as Record<string, unknown>;
  for (const [ref, ident] of Object.entries(actual)) {
    if (!(ref in locked)) continue; // a new recipe op: added to the lock on the next update
    expect(ident, `recipe ${ref} changed its ledger identity; see the comment above this test`).toEqual(locked[ref]);
  }
  expect(Object.keys(locked).sort(), "every recipe op is in the lock (run with SPONSON_UPDATE_RECIPE_LOCK=1)").toEqual(Object.keys(actual).sort());
});

// ---------------------------------------------------------------------------------------------------------------
// Through the ops, against the sim

/** A list item recipe known only to this test (none is shipped): the list_item side of recipe expansion. */
const ORIGINS: Recipe = {
  provider: "example",
  title: "Example",
  category: "cors",
  verified_on: "2026-10-11",
  docs: [{ title: "none", url: "https://example.test" }],
  assumptions: [{ id: "EX1", text: "a test-only recipe", verified: false }],
  api: { base_url: "https://api.example.test/v1", base_url_env: "REST_API_URL", auth: { bearer_env: "REST_API_TOKEN" } },
  ops: {
    allowed_origin: {
      kind: "list_item",
      title: "Allowed origin",
      summary: "An origin on an app's allow-list.",
      covers: [],
      params: { app: { type: "string", required: true, description: "The app.", example: "demo" }, origin: { type: "string", required: true, description: "The origin.", example: "https://pr-42.example.app" } },
      http: { parent: { path: "/apps/{app}" }, list_path: "/allowed_origins", item: { param: "origin" } },
    },
  },
};

describe("a recipe line through the http ops", () => {
  it("reads, diffs, applies and destroys a list item like the hand-written line it expands into", async () => {
    const forget = useRecipe(ORIGINS);
    const h = await harness({ rest: { objects: { "/apps/demo": { allowed_origins: ["https://prod.example.app"] } } } });
    try {
      const line = { recipe: "example.allowed_origin", app: "demo", origin: "https://pr-42.example.app" };
      expect(listItem.outputsFor!(line)).toEqual({});
      expect(codeOf(() => listItem.outputsFor!({ ...line, origin: 1 }))).toMatch(/`origin` must be a string/);
      const actx = h.actx("http", listItem.providerFor!({}, line));
      const params = resolveParams(line, new Map(), new Map()).params;
      // The same parent lock (ADR 0019) as the hand-written line: the resolved block's base URL and the parent path.
      expect(listItem.lockOn!(params, listItem.providerFor!({}, line))).toBe("http:https://api.example.test/v1/apps/demo");
      expect(await listItem.read(actx, params)).toBeNull();
      expect(listItem.diff(null, params)).toMatchObject([{ kind: "create", key: "/apps/demo#/allowed_origins=https://pr-42.example.app" }]);
      const r = await listItem.apply(actx, params, null);
      expect(h.sim.state.rest.objects["/apps/demo"]!.allowed_origins).toEqual(["https://prod.example.app", "https://pr-42.example.app"]);
      await listItem.destroy(actx, r.resources);
      expect(h.sim.state.rest.objects["/apps/demo"]!.allowed_origins).toEqual(["https://prod.example.app"]);
    } finally {
      forget();
      await h.close();
    }
    expect(recipeNames()).not.toContain("example");
  });
});

describe("console_url: the console page a recipe line links to in the PR comment", () => {
  const res = [{ key: "k", id: "we_1", hash: "h" }];

  it("every declared template is an https URL whose placeholders name a param, an output or `id`, and cites its source", () => {
    for (const r of loadRecipes()) {
      for (const [name, op] of Object.entries(r.ops)) {
        if (!op.console_url) continue;
        expect(op.console_url.template, `${r.provider}.${name}`).toMatch(/^https:\/\//);
        expect(op.console_url.source, `${r.provider}.${name}`).toMatch(/^https:\/\//);
        const outputs = Object.keys(((op.http as Record<string, unknown>).outputs as Record<string, unknown> | undefined) ?? {});
        for (const [, p] of op.console_url.template.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)) expect([...Object.keys(op.params), ...outputs, "id"], `${r.provider}.${name}: {${p}}`).toContain(p);
      }
    }
  });

  it("stripe.webhook_endpoint links the documented Webhooks page; the http ops answer null without a recipe or template", () => {
    const params = { recipe: "stripe.webhook_endpoint", name: "preview-pr-42", url: "https://x.example" };
    expect(httpAdapter.ops.resource!.consoleUrl!({ provider: {}, params, resources: res, outputs: {} })).toBe("https://dashboard.stripe.com/webhooks");
    expect(httpAdapter.ops.resource!.consoleUrl!({ provider: {}, params: { path: "/x" }, resources: res, outputs: {} })).toBeNull();
    expect(httpAdapter.ops.resource!.consoleUrl!({ provider: {}, params: { recipe: "stripe.product", id: "p" }, resources: res, outputs: {} })).toBeNull();
  });

  it("fills placeholders URI-encoded, and gives up on one without a plain value", () => {
    const restore = useRecipe({
      ...loadRecipe("stripe"),
      provider: "consoletest",
      ops: { thing: { ...loadRecipe("stripe").ops.webhook_endpoint!, console_url: { template: "https://c.example/{name}/{id}", source: "https://docs.example" } } },
    } as Recipe);
    try {
      const base = { recipe: "consoletest.thing", url: "https://x.example" };
      expect(httpAdapter.ops.resource!.consoleUrl!({ provider: {}, params: { ...base, name: "a b/c" }, resources: res, outputs: {} })).toBe("https://c.example/a%20b%2Fc/we_1");
      expect(httpAdapter.ops.resource!.consoleUrl!({ provider: {}, params: { ...base, name: { from: "x.y" } }, resources: res, outputs: {} })).toBeNull();
      expect(httpAdapter.ops.resource!.consoleUrl!({ provider: {}, params: { ...base, name: "pr-${ctx.scope}" }, resources: res, outputs: {} })).toBeNull();
    } finally {
      restore();
    }
  });
});
