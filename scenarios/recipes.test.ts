/**
 * Every recipe op (packages/adapters/recipes/*.yaml), end to end through the in-process CLI, with no test code of
 * its own: adding a recipe file adds its cases here.
 *
 * Against the fake cloud (always): the generic REST sim is seeded and shaped from the recipe itself (the collection
 * its create posts to, answering in its `item_path`/`find.list_path` envelopes with its id field; the parent objects
 * of its `sim.objects`), then the example line runs create → idempotent re-apply (zero writes) → drift (a declared
 * field edited in the console is refused until --reconcile; the object or item removed by hand is recreated) →
 * destroy (only what Sponson made is removed; an op its recipe keeps on destroy is left, with no request). The
 * credential never reaches any output.
 *
 * Live (`pnpm test:live`, SPONSON_LIVE=1): an op runs create → re-apply → destroy against the real API when its
 * credential variable and every `SPONSON_LIVE_*` variable its recipe's `live.params` names are set; otherwise it is
 * skipped. Use throwaway projects: it creates the example object under a unique scope and destroys it.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandRecipe, loadRecipes, type Recipe, type RecipeOp } from "@sponson/adapters";
import { startSim, type RestAuthSeed, type RestStyle, type SimHandle, type SimSeed } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type CliRun, type Workspace } from "./support.js";

const LIVE = process.env.SPONSON_LIVE === "1";
const TOKEN = "tok_recipe_scenario_secret_0042";

const cases = loadRecipes().flatMap((r) => Object.entries(r.ops).map(([name, op]) => [`${r.provider}.${name}`, r, name, op] as const));

/** A recipe's `auth`, every form it may take (schema/recipe.schema.json). */
interface RecipeAuth {
  bearer_env?: string;
  header?: string;
  value_env?: string;
  prefix?: string;
  headers?: Array<{ header: string; value_env: string; prefix?: string }>;
  basic?: { user_env: string; password_env: string };
  digest?: { user_env: string; password_env: string };
  aws_sigv4?: { region: string; access_key_id_env: string; secret_access_key_env: string };
  command?: string[];
}

/** Every credential variable of the recipe's API block. */
function credentialVars(r: Recipe): string[] {
  const a = r.api.auth as RecipeAuth;
  const pair = (p?: { user_env: string; password_env: string }) => (p ? [p.user_env, p.password_env] : []);
  return [a.bearer_env, a.value_env, ...(a.headers ?? []).map((h) => h.value_env), ...pair(a.basic), ...pair(a.digest), a.aws_sigv4?.access_key_id_env, a.aws_sigv4?.secret_access_key_env].filter((v): v is string => typeof v === "string");
}

/**
 * The fake cloud's side of the recipe's credential: the variables the CLI gets (every secret part contains TOKEN, so
 * the leak check covers it), the REST sim's real checks for the forms R1 cannot tell apart (a prefix, several
 * headers, Digest, a printed token), the keys a provider sim signs with, and the fake CLIs a command needs.
 */
function credentials(r: Recipe): { env: Record<string, string>; auth?: RestAuthSeed; keys?: Record<string, string>; bins: Record<string, string> } {
  const a = r.api.auth as RecipeAuth;
  const env: Record<string, string> = {};
  for (const v of credentialVars(r)) env[v] = TOKEN;
  if (a.value_env && a.prefix) return { env, auth: { headers: [{ [a.header!.toLowerCase()]: `${a.prefix}${TOKEN}` }] }, bins: {} };
  if (a.headers) {
    a.headers.forEach((h, i) => (env[h.value_env] = `${TOKEN}_${i}`));
    return { env, auth: { headers: [Object.fromEntries(a.headers.map((h, i) => [h.header.toLowerCase(), `${h.prefix ?? ""}${TOKEN}_${i}`]))] }, bins: {} };
  }
  if (a.digest) {
    env[a.digest.user_env] = "recipe-public-key";
    return { env, auth: { digest: { users: { "recipe-public-key": TOKEN }, realm: "Sponson recipes" } }, bins: {} };
  }
  if (a.aws_sigv4) {
    env[a.aws_sigv4.access_key_id_env] = "AKIARECIPESCENARIO42";
    return { env, keys: { AKIARECIPESCENARIO42: TOKEN }, bins: {} };
  }
  if (a.command) return { env, auth: { tokens: [TOKEN] }, bins: { [a.command[0]!]: `echo "${TOKEN}"` } };
  return { env, bins: {} };
}

/** The `env://NAME` references in the example params, each given a value that contains TOKEN. */
function exampleSecrets(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries([...JSON.stringify(params).matchAll(/"secret":"env:\/\/([A-Za-z_]\w*)"/g)].map((m) => [m[1]!, `${TOKEN}_${m[1]!.toLowerCase()}`]));
}

/** Write each fake CLI as an executable shell script in `dir`; returns `dir` for the front of PATH. */
async function plantBins(dir: string, bins: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(bins)) {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), 0o755);
  }
  return dir;
}

/** `${ctx.*}` as the CLI fills it for `scope`. */
function interpolate<T>(v: T, scope: string): T {
  return JSON.parse(JSON.stringify(v).replace(/\$\{ctx\.scope\}/g, scope).replace(/\$\{ctx\.env\}/g, "preview").replace(/\$\{ctx\.git\.sha\}/g, SHA).replace(/\$\{ctx\.git\.branch\}/g, "feat/x")) as T;
}

/** The op's example params (live: with the `live.params` variables' values over them). */
function exampleParams(op: RecipeOp, env: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [p, spec] of Object.entries(op.params)) if (spec.example !== undefined) out[p] = spec.example;
  for (const [p, variable] of Object.entries(op.live?.params ?? {})) if (env[variable]) out[p] = env[variable];
  return out;
}

/** `{name}` placeholders of a sim path filled from values (the expanded line's `vars`), without query or trailing slash. */
function fill(path: string, vars: Record<string, unknown>): string {
  // `{+name}` is written as it is (a URL in the path), `{name}` as one URI-encoded segment.
  const filled = path.split("?")[0]!.replace(/\{(\+?)([A-Za-z_]\w*)\}/g, (_m, plus: string, n: string) => (plus ? encodeURI(String(vars[n])) : encodeURIComponent(String(vars[n]))));
  return filled.length > 1 ? filled.replace(/\/$/, "") : filled;
}

function planText(r: Recipe, name: string, op: RecipeOp, params: Record<string, unknown>): string {
  const line = { id: "it", adapter: "http", op: op.kind, recipe: `${r.provider}.${name}`, ...params };
  // A per-account API (no default base_url) needs its block; the test points base_url_env at the fake cloud.
  const block = r.api.base_url === undefined ? `providers:\n  http:\n    ${r.provider}: ${JSON.stringify({ recipe: r.provider, base_url: r.base_url_example })}\n` : "";
  return `version: 1\n${block}changes:\n  - ${JSON.stringify(line)}\n`;
}

/** The pointer's single token (`/Name` → `Name`). */
function token(pointer: unknown, fallback: string): string {
  return typeof pointer === "string" && pointer !== "" ? pointer.slice(1) : fallback;
}

/** The tokens of a JSON pointer, or of a field name (`name` → `["name"]`). */
function tokens(field: string): string[] {
  if (field === "") return [];
  if (!field.startsWith("/")) return [field];
  return field.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** `v` set at a field name or JSON pointer of `doc`, creating maps on the way. */
function setAt(doc: Record<string, unknown>, field: string, v: unknown): void {
  const path = tokens(field);
  const parent = path.slice(0, -1).reduce<Record<string, unknown>>((cur, t) => (cur[t] ??= {}) as Record<string, unknown>, doc);
  parent[path.at(-1)!] = v;
}

/** The value at a field name or JSON pointer. */
function valueAt(doc: unknown, field: string): unknown {
  return tokens(field).reduce<unknown>((cur, t) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[t] : undefined), doc);
}

/** The collection a resource op's objects live in: its `sim.collection`, else the create's path. */
function collectionOf(op: RecipeOp, spec: Record<string, unknown>): string {
  return fill(op.sim?.collection ?? (spec.create as { path: string }).path, spec.vars as Record<string, unknown>);
}

/** The sim, shaped like the provider: the create's collection (envelopes, id field) and the seeded parents. */
function simSeed(r: Recipe, op: RecipeOp, spec: Record<string, unknown>, creds: ReturnType<typeof credentials>) {
  const vars = spec.vars as Record<string, unknown>;
  const collections: Record<string, Array<Record<string, unknown>>> = {};
  const styles: Record<string, RestStyle> = {};
  const aliases: Record<string, string> = {};
  const create = spec.create as { path?: string; method?: string } | undefined;
  if (op.kind === "resource" && create?.path) {
    const find = spec.find as { list_path?: string; next?: string } | undefined;
    const coll = collectionOf(op, spec);
    // A PUT to the object's own path (an upsert at a client-chosen key) creates there; anything else is aliased.
    if (coll !== fill(create.path, vars) && create.method?.toUpperCase() !== "PUT") aliases[fill(create.path, vars)] = coll;
    // Objects read, updated or deleted under another path than their collection (`/databases/{id}`).
    for (const req of [spec.read, spec.update, spec.delete] as Array<{ path?: string } | undefined>) {
      const p = req?.path?.split("?")[0];
      if (p && /\/\{[A-Za-z_]\w*\}$/.test(p) && fill(p.slice(0, p.lastIndexOf("/")), vars) !== coll) aliases[fill(p.slice(0, p.lastIndexOf("/")), vars)] = coll;
    }
    // Outputs the provider shows only in the create's answer (a signing secret): the sim generates them there only.
    const once = Object.values((spec.outputs as Record<string, unknown> | undefined) ?? {}).flatMap((d) => (typeof d === "object" && d !== null && (d as { once?: boolean }).once ? [token((d as { path: string }).path, "")] : []));
    collections[coll] = [];
    styles[coll] = {
      list_path: find?.list_path ?? "",
      item_path: typeof spec.item_path === "string" ? spec.item_path : "",
      next_path: find?.next ?? null,
      id_field: token(spec.id_path, "id"),
      ...(op.sim?.id_from ? { id_from: op.sim.id_from } : {}),
      ...(op.sim?.numeric_ids ? { numeric_ids: true } : {}),
      ...(op.sim?.header_fields ? { header_fields: op.sim.header_fields } : {}),
      ...(op.sim?.suffix_field ? { suffix_field: op.sim.suffix_field } : {}),
      ...(op.sim?.item_query ? { item_query: op.sim.item_query } : {}),
      ...(r.api.encoding === "form" ? { form_types: true } : {}),
      ...(once.length ? { once_fields: once } : {}),
      ...generatedOf(spec),
    };
  }
  // A provider that lists at another URL than its objects' collection (`GET /settings/all`): the same collection.
  const findPath = (spec.find as { path?: string } | undefined)?.path;
  if (op.kind === "resource" && create?.path && findPath && fill(findPath, vars) !== collectionOf(op, spec)) aliases[fill(findPath, vars)] = collectionOf(op, spec);
  const objects = Object.fromEntries(Object.entries(op.sim?.objects ?? {}).map(([p, o]) => [fill(p, vars), structuredClone(o)]));
  // A parent read in an envelope (`parent.item_path`) is answered in it.
  const parent = spec.parent as { path: string; read_path?: string; item_path?: string } | undefined;
  if (op.kind === "list_item" && parent?.item_path) styles[fill(parent.read_path ?? parent.path, vars)] = { item_path: parent.item_path };
  // A credential header the sim would not recognise by its name (`X-Honeycomb-Team`).
  const header = (r.api.auth as { header?: string }).header;
  const rest = { collections, objects, styles, aliases, ...(header ? { auth_headers: [header] } : {}), ...(creds.auth ? { auth: creds.auth } : {}), ...bulkDeletes(op, spec) };
  const via = op.sim?.provider_sim;
  if (!via) return { rest };
  // A provider sim signs with the recipe's region and the test's key (the AWS sim checks SigV4 for real).
  const region = (r.api.auth as RecipeAuth).aws_sigv4?.region;
  return { rest, [via.name]: { ...structuredClone(via.seed), ...(creds.keys ? { keys: creds.keys } : {}), ...(region ? { region } : {}) } };
}

/** A delete that names the object in its body (`{ public_ids: ["{id}"] }`): the sim's bulk delete at that path (R9). */
function bulkDeletes(op: RecipeOp, spec: Record<string, unknown>): { deletes?: Record<string, { collection: string; ids: string }> } {
  const del = spec.delete as { method?: string; path?: string; body?: unknown } | undefined;
  const at = del?.body === undefined ? undefined : pointerTo(del.body, "{id}");
  if (op.kind !== "resource" || !del?.path || at === undefined) return {};
  // The pointer to the list holding the id when the id is a list's element, else to the id itself.
  const ids = /\/\d+$/.test(at) ? at.replace(/\/\d+$/, "") : at;
  return { deletes: { [fill(del.path, spec.vars as Record<string, unknown>)]: { collection: collectionOf(op, spec), ids } } };
}

/** The JSON pointer of the first string equal to `needle` in `doc`. */
function pointerTo(doc: unknown, needle: string, at = ""): string | undefined {
  if (doc === needle) return at;
  if (doc === null || typeof doc !== "object") return undefined;
  for (const [k, v] of Object.entries(doc)) {
    const found = pointerTo(v, needle, `${at}/${k}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Fields the provider generates and shows on every read (a server's token, a sensitive output that is not once). */
function generatedOf(spec: Record<string, unknown>): { generated?: string[] } {
  const outputs = Object.values((spec.outputs as Record<string, unknown> | undefined) ?? {});
  const pointers = outputs.flatMap((d) => (typeof d === "object" && d !== null && (d as { sensitive?: boolean }).sensitive && !(d as { once?: boolean }).once ? [(d as { path: string }).path] : []));
  return pointers.length ? { generated: pointers } : {};
}

class Run {
  constructor(
    readonly ws: Workspace,
    readonly env: NodeJS.ProcessEnv,
    readonly ctx: string[],
  ) {}

  async cli(args: string, sim?: SimHandle): Promise<CliRun & { writes: number }> {
    const before = sim?.state.writes.length ?? 0;
    const r = await runCli([...args.split(" "), ...this.ctx, "--receipts", "local", "--receipts-dir", `${this.ws.dir}/.sponson/receipts`], { env: this.env, cwd: this.ws.dir });
    for (const out of [r.stdout, r.stderr]) expect(out, `${args}: the credential leaked`).not.toContain(TOKEN);
    return { ...r, writes: (sim?.state.writes.length ?? before) - before };
  }
}

function lineOf(r: CliRun): { status?: string } {
  return ((r.json?.receipt?.lines ?? {}) as Record<string, { status?: string }>).it ?? (r.json?.lines as Array<{ id: string; status: string }> | undefined)?.find((l) => l.id === "it") ?? {};
}

const diag = (r: CliRun) => `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

/** The object a resource op made, in the sim. */
function simItems(sim: SimHandle, op: RecipeOp, spec: Record<string, unknown>): Array<Record<string, unknown>> {
  return sim.state.rest.collections[collectionOf(op, spec)] ?? [];
}

/** A value different from `v` of the same type. */
function edited(v: unknown): unknown {
  if (typeof v === "boolean") return !v;
  if (typeof v === "number") return v + 1;
  if (typeof v === "string") return `${v}-edited`;
  return "edited";
}

/** The parent's collection as a list of item keys, and a way to remove the item from it, for every shape. */
function parentList(sim: SimHandle, op: RecipeOp, spec: Record<string, unknown>): { parent: Record<string, unknown>; field: string; has: () => boolean; remove: () => void } {
  const parentPath = fill((spec.parent as { path: string; read_path?: string }).read_path ?? (spec.parent as { path: string }).path, spec.vars as Record<string, unknown>);
  // Under a provider sim, the collection is where its hint points in that provider's state.
  const via = op.sim?.provider_sim;
  const parent = via ? (sim.state as unknown as Record<string, Record<string, unknown>>)[via.name]! : sim.state.rest.objects[parentPath]!;
  const listPath = via ? via.list : ((spec.list_path as string | undefined) ?? "");
  const shape = (spec.shape as string | undefined) ?? "array";
  const sep = (spec.separator as string | undefined) ?? ",";
  const item = spec.item;
  const keyField = spec.key_field as string | undefined;
  const value = () => (listPath === "" ? parent : valueAt(parent, listPath));
  const set = (v: unknown) => {
    const path = tokens(listPath);
    const holder = valueAt(parent, `/${path.slice(0, -1).join("/")}`.replace(/^\/$/, "")) as Record<string, unknown>;
    holder[path.at(-1)!] = v;
  };
  const keyOf = (e: unknown) => JSON.stringify(keyField ? valueAt(e, keyField) : e);
  const matches = (e: unknown) => keyOf(e) === keyOf(item);
  const list = () => (shape === "delimited" ? String(value() ?? "").split(sep).map((s) => s.trim()) : shape === "map" ? Object.keys(value() as object) : ((value() as unknown[] | null) ?? []));
  return {
    parent,
    field: listPath,
    has: () => list().some((e) => (shape === "array" ? matches(e) : e === item)),
    remove: () => {
      if (shape === "delimited") set(list().filter((e) => e !== item).join(sep));
      else if (shape === "map") delete (value() as Record<string, unknown>)[String(item)];
      else set(((value() as unknown[] | null) ?? []).filter((e) => !matches(e)));
    },
  };
}

async function lifecycleInSim(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  const params = exampleParams(op);
  const spec = expandRecipe({ recipe: `${r.provider}.${name}`, ...interpolate(params, "pr-42") }, op.kind);
  const creds = credentials(r);
  const sim = await startSim({ seed: simSeed(r, op, spec, creds) as Partial<SimSeed> });
  const ws = await workspace("recipe", { plan: planText(r, name, op, params) });
  const via = op.sim?.provider_sim;
  const bin = Object.keys(creds.bins).length ? await plantBins(join(ws.dir, ".bin"), creds.bins) : undefined;
  const env = cliEnv(sim, {
    [String(r.api.base_url_env)]: via ? `${sim.url}/${via.name}${via.path}` : `${sim.url}/rest`,
    ...creds.env,
    ...exampleSecrets(params),
    ...(bin ? { PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter) } : {}),
  });
  const run = new Run(ws, env, ["--env", "preview", "--pr", "42", "--branch", "feat/x", "--sha", SHA]);
  const seededObjects = structuredClone(via ? valueAt(via.seed, via.list) : sim.state.rest.objects);
  const objectsNow = () => (via ? valueAt((sim.state as unknown as Record<string, unknown>)[via.name], via.list) : sim.state.rest.objects);
  try {
    let res = await run.cli("plan --json", sim);
    expect(res.code, `plan${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("create");

    res = await run.cli("apply --json", sim);
    expect(res.code, `apply${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("applied");
    if (op.kind === "resource") {
      expect(simItems(sim, op, spec)).toHaveLength(1);
      for (const [f, v] of Object.entries((spec.fields as Record<string, unknown> | undefined) ?? {})) expect(valueAt(simItems(sim, op, spec)[0], f), `field ${f}`).toEqual(v);
    } else expect(parentList(sim, op, spec).has(), "the item is in the parent's collection").toBe(true);

    res = await run.cli("apply --json", sim);
    expect({ code: res.code, writes: res.writes, status: lineOf(res).status }, `re-apply${diag(res)}`).toEqual({ code: 0, writes: 0, status: "unchanged" });

    if (op.kind === "resource") await resourceDrift(run, sim, op, spec);
    else await listDrift(run, sim, op, spec);

    res = await run.cli("apply --destroy --json", sim);
    expect(res.code, `destroy${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("destroyed");
    // An op the recipe keeps on destroy (shared history, or no delete API) is left in place, and nothing is sent.
    if (op.kind === "resource" && spec.destroy === "keep") expect({ items: simItems(sim, op, spec).length, writes: res.writes }).toEqual({ items: 1, writes: 0 });
    else if (op.kind === "resource") expectDestroyed(sim, op, spec);
    else expect(objectsNow(), "destroy left every other item as seeded").toEqual(seededObjects);
  } finally {
    await sim.close();
    await ws.cleanup();
  }
}

/** Gone, or for a recipe whose destroy archives (a POST with a body), still there with the archive fields set. */
function expectDestroyed(sim: SimHandle, op: RecipeOp, spec: Record<string, unknown>): void {
  const archive = (spec.delete as { body?: Record<string, unknown> } | undefined)?.body;
  // A body that names the object (`{id}`) deletes it; any other body archives it.
  if (!archive || pointerTo(archive, "{id}") !== undefined) return void expect(simItems(sim, op, spec)).toEqual([]);
  expect(simItems(sim, op, spec).length, "the archived object stays").toBeGreaterThan(0);
  for (const item of simItems(sim, op, spec)) expect(item, "every object Sponson made is archived").toMatchObject(archive);
}

async function resourceDrift(run: Run, sim: SimHandle, op: RecipeOp, spec: Record<string, unknown>): Promise<void> {
  const fields = Object.entries((spec.fields as Record<string, unknown> | undefined) ?? {});
  if (fields.length > 0) {
    const [f, v] = fields[0]!;
    setAt(simItems(sim, op, spec)[0]!, f, edited(v));
    let res = await run.cli("plan --json", sim);
    expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind) }, `changed drift${diag(res)}`).toEqual({ code: 1, status: "blocked", drift: ["changed"] });
    res = await run.cli("apply --reconcile --json", sim);
    expect(res.code, `reconcile${diag(res)}`).toBe(0);
    expect(valueAt(simItems(sim, op, spec)[0], f)).toEqual(v);
  }
  sim.state.rest.collections[collectionOf(op, spec)] = [];
  let res = await run.cli("plan --json", sim);
  expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind) }, `missing drift${diag(res)}`).toEqual({ code: 0, status: "create", drift: ["missing"] });
  res = await run.cli("apply --json", sim);
  expect(res.code, `recreate${diag(res)}`).toBe(0);
  expect(simItems(sim, op, spec)).toHaveLength(1);
}

async function listDrift(run: Run, sim: SimHandle, op: RecipeOp, spec: Record<string, unknown>): Promise<void> {
  const list = parentList(sim, op, spec);
  list.remove();
  let res = await run.cli("plan --json", sim);
  expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind).filter((k) => k !== "unmanaged") }, `missing drift${diag(res)}`).toEqual({ code: 0, status: "create", drift: ["missing"] });
  res = await run.cli("apply --json", sim);
  expect(res.code, `put back${diag(res)}`).toBe(0);
  expect(parentList(sim, op, spec).has()).toBe(true);
}

async function lifecycleLive(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  const scope = `pr-${900000 + (parseInt(randomBytes(4).toString("hex"), 16) % 99999)}`;
  const ws = await workspace("recipe-live", { plan: planText(r, name, op, exampleParams(op, process.env)) });
  const run = new Run(ws, { ...process.env }, ["--env", "preview", "--pr", scope.slice(3), "--branch", `sponson-recipe-${scope}`, "--sha", randomBytes(20).toString("hex")]);
  try {
    let res = await run.cli("apply --json");
    expect(res.code, `apply${diag(res)}`).toBe(0);
    res = await run.cli("apply --json");
    expect(lineOf(res).status, `re-apply${diag(res)}`).toBe("unchanged");
  } finally {
    const res = await run.cli("apply --destroy --json");
    await ws.cleanup();
    expect(res.code, `destroy${diag(res)}`).toBe(0);
  }
}

describe.each(cases)("recipe %s", (_ref, r, name, op) => {
  it("create, idempotent re-apply, drift and destroy against the fake cloud", () => lifecycleInSim(r, name, op), 60_000);

  // A per-account API is reached live through its base_url_env.
  const live = [...credentialVars(r), ...(r.api.base_url === undefined ? [String(r.api.base_url_env)] : []), ...Object.values(op.live?.params ?? {})];
  it.skipIf(!LIVE || live.some((v) => !process.env[v]))(`@live: create, re-apply and destroy against the real API (needs ${live.join(", ")})`, () => lifecycleLive(r, name, op), 120_000);
});
