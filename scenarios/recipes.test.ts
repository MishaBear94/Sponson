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
import { describe, expect, it } from "vitest";
import { expandRecipe, loadRecipes, type Recipe, type RecipeOp } from "@sponson/adapters";
import { startSim, type RestStyle, type SimHandle } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type CliRun, type Workspace } from "./support.js";

const LIVE = process.env.SPONSON_LIVE === "1";
const TOKEN = "tok_recipe_scenario_secret_0042";

const cases = loadRecipes().flatMap((r) => Object.entries(r.ops).map(([name, op]) => [`${r.provider}.${name}`, r, name, op] as const));

/** Every credential variable of the recipe's API block. */
function credentialVars(r: Recipe): string[] {
  const auth = r.api.auth as { bearer_env?: string; value_env?: string; basic?: { user_env: string; password_env: string } };
  return [auth.bearer_env, auth.value_env, auth.basic?.user_env, auth.basic?.password_env].filter((v): v is string => typeof v === "string");
}

/** `${ctx.*}` as the CLI fills it for `scope`. */
function interpolate<T>(v: T, scope: string): T {
  return JSON.parse(JSON.stringify(v).replace(/\$\{ctx\.scope\}/g, scope).replace(/\$\{ctx\.env\}/g, "preview").replace(/\$\{ctx\.git\.sha\}/g, SHA)) as T;
}

/** The op's example params (live: with the `live.params` variables' values over them). */
function exampleParams(op: RecipeOp, env: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [p, spec] of Object.entries(op.params)) if (spec.example !== undefined) out[p] = spec.example;
  for (const [p, variable] of Object.entries(op.live?.params ?? {})) if (env[variable]) out[p] = env[variable];
  return out;
}

/** `{name}` placeholders of a sim path filled from values (the expanded line's `vars`), as the sim keys it. */
function fill(path: string, vars: Record<string, unknown>): string {
  const filled = path.split("?")[0]!.replace(/\{([A-Za-z_]\w*)\}/g, (_m, n: string) => encodeURIComponent(String(vars[n])));
  return filled.length > 1 && filled.endsWith("/") ? filled.slice(0, -1) : filled;
}

/** A declared field (`name` or a JSON pointer `/config/url`) of an object: its value, or a way to set it. */
function fieldPath(f: string): string[] {
  return f.startsWith("/") ? f.slice(1).split("/") : [f];
}
function getField(o: Record<string, unknown>, f: string): unknown {
  return fieldPath(f).reduce<unknown>((cur, t) => (cur as Record<string, unknown> | undefined)?.[t], o);
}
function setField(o: Record<string, unknown>, f: string, v: unknown): void {
  const tokens = fieldPath(f);
  const parent = tokens.slice(0, -1).reduce<Record<string, unknown>>((cur, t) => (cur[t] ??= {}) as Record<string, unknown>, o);
  parent[tokens.at(-1)!] = v;
}

function planText(r: Recipe, name: string, op: RecipeOp, params: Record<string, unknown>): string {
  const line = { id: "it", adapter: "http", op: op.kind, recipe: `${r.provider}.${name}`, ...params };
  return `version: 1\nchanges:\n  - ${JSON.stringify(line)}\n`;
}

/** The pointer's single token (`/Name` → `Name`). */
function token(pointer: unknown, fallback: string): string {
  return typeof pointer === "string" && pointer !== "" ? pointer.slice(1) : fallback;
}

/** The sim, shaped like the provider: the create's collection (envelopes, id field) and the seeded parents. */
function simSeed(r: Recipe, op: RecipeOp, spec: Record<string, unknown>) {
  const vars = spec.vars as Record<string, unknown>;
  const collections: Record<string, Array<Record<string, unknown>>> = {};
  const styles: Record<string, RestStyle> = {};
  const create = spec.create as { path?: string; method?: string } | undefined;
  if (op.kind === "resource" && create?.path) {
    const find = spec.find as { list_path?: string; next?: string } | undefined;
    const coll = fill(create.path, vars);
    collections[coll] = [];
    styles[coll] = {
      list_path: find?.list_path ?? "",
      item_path: typeof spec.item_path === "string" ? spec.item_path : "",
      next_path: find?.next ?? null,
      id_field: token(spec.id_path, "id"),
      ...(op.sim?.id_from ? { id_from: op.sim.id_from } : {}),
      ...(op.sim?.numeric_ids ? { numeric_ids: true } : {}),
    };
  }
  // A provider that lists at another URL than it creates at (`GET /settings/all`): the sim lists the same collection.
  const aliases: Record<string, string> = {};
  const findPath = (spec.find as { path?: string } | undefined)?.path;
  if (op.kind === "resource" && create?.path && findPath && fill(findPath, vars) !== fill(create.path, vars)) aliases[fill(findPath, vars)] = fill(create.path, vars);
  const objects = Object.fromEntries(Object.entries(op.sim?.objects ?? {}).map(([p, o]) => [fill(p, vars), structuredClone(o)]));
  const header = (r.api.auth as { header?: string }).header;
  return { rest: { collections, objects, styles, aliases, ...(header ? { auth_headers: [header] } : {}) } };
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
function simItems(sim: SimHandle, spec: Record<string, unknown>): Array<Record<string, unknown>> {
  const create = spec.create as { path: string };
  return sim.state.rest.collections[fill(create.path, spec.vars as Record<string, unknown>)] ?? [];
}

/** A value different from `v` of the same type. */
function edited(v: unknown): unknown {
  if (typeof v === "boolean") return !v;
  if (typeof v === "number") return v + 1;
  if (typeof v === "string") return `${v}-edited`;
  return "edited";
}

/** The parent's collection as a list of item keys, and a way to remove the item from it, for every shape. */
function parentList(sim: SimHandle, spec: Record<string, unknown>): { parent: Record<string, unknown>; field: string; has: () => boolean; remove: () => void } {
  const parentPath = fill((spec.parent as { path: string; read_path?: string }).read_path ?? (spec.parent as { path: string }).path, spec.vars as Record<string, unknown>);
  const parent = sim.state.rest.objects[parentPath]!;
  const field = token(spec.list_path, "");
  const shape = (spec.shape as string | undefined) ?? "array";
  const sep = (spec.separator as string | undefined) ?? ",";
  const item = spec.item;
  const keyField = spec.key_field as string | undefined;
  const value = () => (field === "" ? parent : parent[field]);
  const matches = (e: unknown) => JSON.stringify(keyField ? (e as Record<string, unknown>)[keyField] : e) === JSON.stringify(keyField ? (item as Record<string, unknown>)[keyField] : item);
  const list = () => (shape === "delimited" ? String(value() ?? "").split(sep).map((s) => s.trim()) : shape === "map" ? Object.keys(value() as object) : (value() as unknown[]));
  return {
    parent,
    field,
    has: () => list().some((e) => (shape === "array" ? matches(e) : e === item)),
    remove: () => {
      if (shape === "delimited") parent[field] = list().filter((e) => e !== item).join(sep);
      else if (shape === "map") delete (value() as Record<string, unknown>)[String(item)];
      else parent[field] = (value() as unknown[]).filter((e) => !matches(e));
    },
  };
}

async function lifecycleInSim(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  const params = exampleParams(op);
  const spec = expandRecipe({ recipe: `${r.provider}.${name}`, ...interpolate(params, "pr-42") }, op.kind);
  const sim = await startSim({ seed: simSeed(r, op, spec) });
  const ws = await workspace("recipe", { plan: planText(r, name, op, params) });
  const env = cliEnv(sim, { [String(r.api.base_url_env)]: `${sim.url}/rest`, ...Object.fromEntries(credentialVars(r).map((v) => [v, TOKEN])) });
  const run = new Run(ws, env, ["--env", "preview", "--pr", "42", "--branch", "feat/x", "--sha", SHA]);
  const seededObjects = structuredClone(sim.state.rest.objects);
  try {
    let res = await run.cli("plan --json", sim);
    expect(res.code, `plan${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("create");

    res = await run.cli("apply --json", sim);
    expect(res.code, `apply${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("applied");
    if (op.kind === "resource") {
      expect(simItems(sim, spec)).toHaveLength(1);
      for (const [f, v] of Object.entries((spec.fields as Record<string, unknown> | undefined) ?? {})) expect(getField(simItems(sim, spec)[0]!, f), `field ${f}`).toEqual(v);
    } else expect(parentList(sim, spec).has(), "the item is in the parent's collection").toBe(true);

    res = await run.cli("apply --json", sim);
    expect({ code: res.code, writes: res.writes, status: lineOf(res).status }, `re-apply${diag(res)}`).toEqual({ code: 0, writes: 0, status: "unchanged" });

    if (op.kind === "resource") await resourceDrift(run, sim, spec);
    else await listDrift(run, sim, spec);

    res = await run.cli("apply --destroy --json", sim);
    expect(res.code, `destroy${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("destroyed");
    // An op the recipe keeps on destroy (shared history, or no delete API) is left in place, and nothing is sent.
    if (op.kind === "resource" && spec.destroy === "keep") expect({ items: simItems(sim, spec).length, writes: res.writes }).toEqual({ items: 1, writes: 0 });
    else if (op.kind === "resource") expect(simItems(sim, spec)).toEqual([]);
    else expect(sim.state.rest.objects, "destroy left every other item as seeded").toEqual(seededObjects);
  } finally {
    await sim.close();
    await ws.cleanup();
  }
}

async function resourceDrift(run: Run, sim: SimHandle, spec: Record<string, unknown>): Promise<void> {
  const fields = Object.entries((spec.fields as Record<string, unknown> | undefined) ?? {});
  if (fields.length > 0) {
    const [f, v] = fields[0]!;
    setField(simItems(sim, spec)[0]!, f, edited(v));
    let res = await run.cli("plan --json", sim);
    expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind) }, `changed drift${diag(res)}`).toEqual({ code: 1, status: "blocked", drift: ["changed"] });
    res = await run.cli("apply --reconcile --json", sim);
    expect(res.code, `reconcile${diag(res)}`).toBe(0);
    expect(getField(simItems(sim, spec)[0]!, f)).toEqual(v);
  }
  sim.state.rest.collections[fill((spec.create as { path: string }).path, spec.vars as Record<string, unknown>)] = [];
  let res = await run.cli("plan --json", sim);
  expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind) }, `missing drift${diag(res)}`).toEqual({ code: 0, status: "create", drift: ["missing"] });
  res = await run.cli("apply --json", sim);
  expect(res.code, `recreate${diag(res)}`).toBe(0);
  expect(simItems(sim, spec)).toHaveLength(1);
}

async function listDrift(run: Run, sim: SimHandle, spec: Record<string, unknown>): Promise<void> {
  const list = parentList(sim, spec);
  list.remove();
  let res = await run.cli("plan --json", sim);
  expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind).filter((k) => k !== "unmanaged") }, `missing drift${diag(res)}`).toEqual({ code: 0, status: "create", drift: ["missing"] });
  res = await run.cli("apply --json", sim);
  expect(res.code, `put back${diag(res)}`).toBe(0);
  expect(parentList(sim, spec).has()).toBe(true);
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

  const live = [...credentialVars(r), ...Object.values(op.live?.params ?? {})];
  it.skipIf(!LIVE || live.some((v) => !process.env[v]))(`@live: create, re-apply and destroy against the real API (needs ${live.join(", ")})`, () => lifecycleLive(r, name, op), 120_000);
});
