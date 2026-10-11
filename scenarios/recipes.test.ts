/**
 * Every recipe op (packages/adapters/recipes/*.yaml), end to end through the in-process CLI, with no test code of
 * its own: adding a recipe file adds its cases here.
 *
 * Against the fake cloud (always): the generic REST sim is seeded and shaped from the recipe itself (the collection
 * its create posts to, answering in its `item_path`/`find.list_path` envelopes with its id field; the parent objects
 * of its `sim.objects`), then the example line runs create → idempotent re-apply (zero writes) → drift (a declared
 * field edited in the console is refused until --reconcile; the object or item removed by hand is recreated) →
 * destroy (only what Sponson made is removed; an op its recipe keeps on destroy is left, with no request). The
 * credential never reaches any output. A run-time credential is checked for real by the sim (R7): a SigV4 signature
 * with the sims' AWS key, or the token a faked CLI on PATH prints for a `command` credential.
 *
 * An op whose API the REST sim cannot stand in for (GraphQL) names a first-class sim in `sim.provider`, seeds it with
 * `sim.seed`, and says what to observe: `sim.present`, a JSON pointer into that sim's state that exists once the op
 * applied, and `sim.drift`, that sim's drift keys that edit a declared field and remove what the op made. The same
 * lifecycle then runs against it.
 *
 * An `action` op (ADR 0022) runs instead: run → re-apply unchanged (zero writes) → its trigger changed in the plan →
 * run again → destroy (its undo sent, or nothing), against REST sim endpoints that log every call (R9) and answer
 * what the op expects; a request to the app's own `url` must carry no credential.
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
import { AWS_SIM_ACCESS_KEY_ID, AWS_SIM_SECRET_ACCESS_KEY, startSim, type ProviderName, type RestStyle, type SimHandle, type SimSeed } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type CliRun, type Workspace } from "./support.js";

const LIVE = process.env.SPONSON_LIVE === "1";
const TOKEN = "tok_recipe_scenario_secret_0042";

const cases = loadRecipes().flatMap((r) => Object.entries(r.ops).map(([name, op]) => [`${r.provider}.${name}`, r, name, op] as const));

/** The credential forms a recipe's API block may take (schema/recipe.schema.json). */
interface RecipeAuth {
  bearer_env?: string;
  header?: string;
  value_env?: string;
  prefix?: string;
  basic?: { user_env: string; password_env: string };
  oauth2_client_credentials?: { client_id_env: string; client_secret_env: string; token_url_env: string };
  command?: string[];
  aws_sigv4?: { region: string; service: string; access_key_id_env: string; secret_access_key_env: string; session_token_env?: string };
}

const authOf = (r: Recipe): RecipeAuth => (r.api?.auth ?? {}) as RecipeAuth;

/** Every credential variable of the recipe's API block (an OAuth2 client's id and secret, a SigV4 key pair included). */
function credentialVars(r: Recipe): string[] {
  const auth = authOf(r);
  const s = auth.aws_sigv4;
  const o = auth.oauth2_client_credentials;
  return [auth.bearer_env, auth.value_env, auth.basic?.user_env, auth.basic?.password_env, o?.client_id_env, o?.client_secret_env, s?.access_key_id_env, s?.secret_access_key_env, s?.session_token_env].filter((v): v is string => typeof v === "string");
}

/** The secret the sim run uses: a SigV4 secret key must be the one the sims verify signatures with. */
function secretOf(r: Recipe): string {
  return authOf(r).aws_sigv4 ? AWS_SIM_SECRET_ACCESS_KEY : TOKEN;
}

/** The value of each credential variable in a sim run (an access key id is an identifier, not the secret). */
function credentialEnv(r: Recipe): Record<string, string> {
  const id = authOf(r).aws_sigv4?.access_key_id_env;
  return Object.fromEntries(credentialVars(r).map((v) => [v, v === id ? AWS_SIM_ACCESS_KEY_ID : secretOf(r)]));
}

/**
 * For a run-time or prefixed credential, the REST sim checks it for real (R7): the SigV4 signature, the OAuth2
 * client whose id and secret the harness sets (both TOKEN), the token a CLI prints, or the header value behind its
 * prefix (`SSWS <token>`). Other forms are checked as R1 says.
 */
function restAuth(r: Recipe): Record<string, unknown> {
  const auth = authOf(r);
  if (auth.aws_sigv4) return { auth: { sigv4: { keys: { [AWS_SIM_ACCESS_KEY_ID]: AWS_SIM_SECRET_ACCESS_KEY }, region: auth.aws_sigv4.region, service: auth.aws_sigv4.service } } };
  if (auth.oauth2_client_credentials) return { auth: { clients: { [TOKEN]: TOKEN } } };
  if (auth.command) return { auth: { tokens: [TOKEN] } };
  if (auth.prefix && auth.header) return { auth: { headers: [{ [auth.header.toLowerCase()]: `${auth.prefix}${TOKEN}` }] } };
  return {};
}

/** An OAuth2 recipe's token endpoint, pointed at the sim's (`<PROVIDER>_TOKEN_URL`). */
function tokenUrlEnv(r: Recipe, sim: SimHandle): Record<string, string> {
  const oauth = authOf(r).oauth2_client_credentials;
  return oauth ? { [oauth.token_url_env]: `${sim.url}/rest/oauth/token` } : {};
}

/** A `command` credential's CLI, faked first on PATH: it prints the token for exactly the recipe's arguments, and fails otherwise. */
async function fakeCli(r: Recipe, dir: string): Promise<Record<string, string>> {
  const command = authOf(r).command;
  if (!command) return {};
  const [file, ...args] = command as [string, ...string[]];
  const bin = join(dir, ".recipe-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, file), `#!/bin/sh\nif [ "$*" != ${JSON.stringify(args.join(" "))} ]; then echo "unexpected: $*" >&2; exit 2; fi\necho "${TOKEN}"\n`);
  await chmod(join(bin, file), 0o755);
  return { PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter) };
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

function planText(r: Recipe, name: string, op: RecipeOp, params: Record<string, unknown>, base = r.base_url_example): string {
  const line = { id: "it", adapter: "http", op: op.kind, recipe: `${r.provider}.${name}`, ...params };
  // A per-account API (no default base_url) needs its block; the test points base_url_env at the fake cloud. Live, the
  // block names the real account, so that what the recipe resolves against it (an OAuth2 token URL) is the account's.
  const block = r.api && r.api.base_url === undefined ? `providers:\n  http:\n    ${r.provider}: ${JSON.stringify({ recipe: r.provider, base_url: base })}\n` : "";
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
function simSeed(r: Recipe, op: RecipeOp, spec: Record<string, unknown>) {
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
      ...(r.api?.encoding === "form" ? { form_types: true } : {}),
      ...(once.length ? { once_fields: once } : {}),
    };
  }
  // A provider that lists at another URL than its objects' collection (`GET /settings/all`): the same collection.
  const findPath = (spec.find as { path?: string } | undefined)?.path;
  if (op.kind === "resource" && create?.path && findPath && fill(findPath, vars) !== collectionOf(op, spec)) aliases[fill(findPath, vars)] = collectionOf(op, spec);
  const objects = Object.fromEntries(Object.entries(op.sim?.objects ?? {}).map(([p, o]) => [fill(p, vars), structuredClone(o)]));
  // A parent read in an envelope (`parent.item_path`) is answered in it; one read with a POST (R8) is answered there.
  const parent = spec.parent as { path: string; read_path?: string; read_method?: string; item_path?: string } | undefined;
  if (op.kind === "list_item" && parent?.item_path) styles[parentPath(spec)] = { item_path: parent.item_path };
  if (op.kind === "list_item") writeFieldStyle(spec, styles);
  const reads = op.kind === "list_item" && parent?.read_method === "POST" ? { [fill(parent.read_path ?? parent.path, vars)]: parentPath(spec) } : {};
  // A credential header the sim would not recognise by its name (`X-Honeycomb-Team`).
  const header = authOf(r).header;
  return { rest: { collections, objects, styles, aliases, reads, ...(header ? { auth_headers: [header] } : {}), ...restAuth(r) } };
}

/** A collection written under another name than it is read (`parent.write_list_path`) is stored under its read name. */
function writeFieldStyle(spec: Record<string, unknown>, styles: Record<string, RestStyle>): void {
  const parent = spec.parent as { path: string; write_list_path?: string };
  if (parent.write_list_path === undefined) return;
  const at = fill(parent.path, spec.vars as Record<string, unknown>);
  styles[at] = { ...styles[at], write_fields: { [token(parent.write_list_path, "")]: token(spec.list_path, "") } };
}

/** Where a list item's parent object is kept in the sim: the read path, or for a read sent as a POST, the write path. */
function parentPath(spec: Record<string, unknown>): string {
  const parent = spec.parent as { path: string; read_path?: string; read_method?: string };
  return fill(parent.read_method === "POST" ? parent.path : (parent.read_path ?? parent.path), spec.vars as Record<string, unknown>);
}

class Run {
  constructor(
    readonly ws: Workspace,
    readonly env: NodeJS.ProcessEnv,
    readonly ctx: string[],
    readonly secret: string = TOKEN,
  ) {}

  async cli(args: string, sim?: SimHandle): Promise<CliRun & { writes: number }> {
    const before = sim?.state.writes.length ?? 0;
    const r = await runCli([...args.split(" "), ...this.ctx, "--receipts", "local", "--receipts-dir", `${this.ws.dir}/.sponson/receipts`], { env: this.env, cwd: this.ws.dir });
    // The credential, and every token obtained with it (an OAuth2 access token), never reaches output.
    const secrets = [this.secret, ...(sim?.state.rest.auth?.issued ?? []).map((t) => t.token)];
    for (const out of [r.stdout, r.stderr]) for (const s of secrets) expect(out, `${args}: a credential leaked`).not.toContain(s);
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
function parentList(sim: SimHandle, spec: Record<string, unknown>): { parent: Record<string, unknown>; field: string; has: () => boolean; remove: () => void } {
  const parent = sim.state.rest.objects[parentPath(spec)]!;
  const listPath = (spec.list_path as string | undefined) ?? "";
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
  const list = () => (shape === "delimited" ? String(value() ?? "").split(sep).map((s) => s.trim()) : shape === "map" ? Object.keys(value() as object) : (value() as unknown[]));
  return {
    parent,
    field: listPath,
    has: () => list().some((e) => (shape === "array" ? matches(e) : e === item)),
    remove: () => {
      if (shape === "delimited") set(list().filter((e) => e !== item).join(sep));
      else if (shape === "map") delete (value() as Record<string, unknown>)[String(item)];
      else set((value() as unknown[]).filter((e) => !matches(e)));
    },
  };
}

const SIM_CTX = ["--env", "preview", "--pr", "42", "--branch", "feat/x", "--sha", SHA];

/** The params a template's `{ param }` parts name, in order. */
function paramsIn(tpl: unknown): string[] {
  return [...JSON.stringify(tpl ?? null).matchAll(/\{"param":"([^"]+)"\}/g)].map((m) => m[1]!);
}

/** Where the sim stands in for the app in an action recipe's example: its `url` param, rewritten per run. */
const APP = "http://app.invalid";

/** The sim path an action's request goes to: under the app's URL, or the API's path. */
function endpointOf(req: { url?: unknown; path?: string }, vars: Record<string, unknown>): string {
  return req.url !== undefined ? String(req.url).slice(APP.length) : fill(req.path!, vars);
}

/** A reply that meets an action's `expect` and has a value at each declared output. */
function replyFor(spec: Record<string, unknown>): Record<string, unknown> {
  const reply: Record<string, unknown> = {};
  for (const [name, pointer] of Object.entries((spec.outputs as Record<string, string> | undefined) ?? {})) setAt(reply, pointer, `sim-${name}`);
  for (const [pointer, v] of Object.entries((spec.expect as Record<string, unknown> | undefined) ?? {})) setAt(reply, pointer, v);
  return reply;
}

/** The REST sim's endpoints for an action op (R9): its request's, answering what it expects, and its undo's. */
function actionEndpoints(spec: Record<string, unknown>): Record<string, unknown> {
  const vars = spec.vars as Record<string, unknown>;
  const req = spec.request as { url?: unknown; path?: string };
  const undo = spec.undo as { url?: unknown; path?: string } | undefined;
  return { [endpointOf(req, vars)]: { public: req.url !== undefined, reply: replyFor(spec) }, ...(undo ? { [endpointOf(undo, vars)]: { public: undo.url !== undefined } } : {}) };
}

async function actionInSim(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  const urlParam = paramsIn((op.http.request as { url?: unknown }).url)[0];
  const params = { ...exampleParams(op), ...(urlParam ? { [urlParam]: APP } : {}) };
  const spec = expandRecipe({ recipe: `${r.provider}.${name}`, ...interpolate(params, "pr-42") }, "action");
  const sim = await startSim({ seed: { rest: { collections: {}, endpoints: actionEndpoints(spec), ...restAuth(r) } } as Partial<SimSeed> });
  // The app's URL is the sim's (its REST provider), so every call lands in the sim's log.
  const at = (p: Record<string, unknown>) => (urlParam ? { ...p, [urlParam]: `${sim.url}/rest` } : p);
  const ws = await workspace("recipe", { plan: planText(r, name, op, at(params)) });
  const env = cliEnv(sim, r.api ? { [String(r.api.base_url_env)]: `${sim.url}/rest`, ...credentialEnv(r), ...tokenUrlEnv(r, sim), ...(await fakeCli(r, ws.dir)) } : {});
  const run = new Run(ws, env, SIM_CTX, secretOf(r));
  const calls = () => sim.state.rest.calls;
  const method = String((spec.request as { method?: string }).method ?? "POST").toUpperCase();
  try {
    let res = await run.cli("plan --json", sim);
    expect({ code: res.code, status: lineOf(res).status }, `plan${diag(res)}`).toEqual({ code: 0, status: "run" });

    res = await run.cli("apply --json", sim);
    expect({ code: res.code, status: lineOf(res).status, calls: calls().length, method: calls()[0]?.method }, `run${diag(res)}`).toEqual({ code: 0, status: "applied", calls: 1, method });
    // A request to the app's own URL never carries a credential.
    if (urlParam) expect(calls()[0]!.headers.authorization).toBeUndefined();

    res = await run.cli("apply --json", sim);
    expect({ code: res.code, writes: res.writes, status: lineOf(res).status }, `re-apply${diag(res)}`).toEqual({ code: 0, writes: 0, status: "unchanged" });

    // A new trigger value (a new revision) runs it again.
    const triggerParam = paramsIn(op.http.trigger).find((p) => p !== urlParam && op.params[p]?.type === "string" && params[p] !== undefined);
    expect(triggerParam, "the trigger has a string param besides the URL to change").toBeDefined();
    await writeFile(join(ws.dir, "release.plan.yaml"), planText(r, name, op, at({ ...params, [triggerParam!]: edited(params[triggerParam!]) })));
    res = await run.cli("plan --json", sim);
    expect({ code: res.code, status: lineOf(res).status }, `trigger changed${diag(res)}`).toEqual({ code: 0, status: "run" });
    res = await run.cli("apply --json", sim);
    expect({ code: res.code, status: lineOf(res).status, calls: calls().length }, `run again${diag(res)}`).toEqual({ code: 0, status: "applied", calls: 2 });

    res = await run.cli("apply --destroy --json", sim);
    const undo = spec.undo !== undefined;
    expect({ code: res.code, status: lineOf(res).status, writes: res.writes, calls: calls().length }, `destroy${diag(res)}`).toEqual({ code: 0, status: "destroyed", writes: undo ? 1 : 0, calls: undo ? 3 : 2 });
  } finally {
    await sim.close();
    await ws.cleanup();
  }
}

async function lifecycleInSim(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  if (op.sim?.provider) return lifecycleInProviderSim(r, name, op);
  const params = exampleParams(op);
  const spec = expandRecipe({ recipe: `${r.provider}.${name}`, ...interpolate(params, "pr-42") }, op.kind);
  const sim = await startSim({ seed: simSeed(r, op, spec) as Partial<SimSeed> });
  const ws = await workspace("recipe", { plan: planText(r, name, op, params) });
  const env = cliEnv(sim, { [String(r.api?.base_url_env)]: `${sim.url}/rest`, ...credentialEnv(r), ...tokenUrlEnv(r, sim), ...(await fakeCli(r, ws.dir)) });
  const run = new Run(ws, env, SIM_CTX, secretOf(r));
  const seededObjects = structuredClone(sim.state.rest.objects);
  try {
    let res = await run.cli("plan --json", sim);
    expect(res.code, `plan${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("create");

    res = await run.cli("apply --json", sim);
    expect(res.code, `apply${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("applied");
    expectTokenFlow(r, sim);
    if (op.kind === "resource") {
      expect(simItems(sim, op, spec)).toHaveLength(1);
      for (const [f, v] of Object.entries((spec.fields as Record<string, unknown> | undefined) ?? {})) expect(valueAt(simItems(sim, op, spec)[0], f), `field ${f}`).toEqual(v);
    } else expect(parentList(sim, spec).has(), "the item is in the parent's collection").toBe(true);

    res = await run.cli("apply --json", sim);
    expect({ code: res.code, writes: res.writes, status: lineOf(res).status }, `re-apply${diag(res)}`).toEqual({ code: 0, writes: 0, status: "unchanged" });

    if (op.kind === "resource") await resourceDrift(run, sim, op, spec);
    else await listDrift(run, sim, spec);

    res = await run.cli("apply --destroy --json", sim);
    expect(res.code, `destroy${diag(res)}`).toBe(0);
    expect(lineOf(res).status).toBe("destroyed");
    // An op the recipe keeps on destroy (shared history, or no delete API) is left in place, and nothing is sent.
    if (op.kind === "resource" && spec.destroy === "keep") expect({ items: simItems(sim, op, spec).length, writes: res.writes }).toEqual({ items: 1, writes: 0 });
    else if (op.kind === "resource") expectDestroyed(sim, op, spec);
    else expect(sim.state.rest.objects, "destroy left every other item as seeded").toEqual(seededObjects);
  } finally {
    await sim.close();
    await ws.cleanup();
  }
}

/**
 * An OAuth2 recipe got its token from the endpoint, asking for the audience it declares (a path: on the origin of
 * the plan's `base_url`, never of the base_url_env override).
 */
function expectTokenFlow(r: Recipe, sim: SimHandle): void {
  const oauth = (authOf(r).oauth2_client_credentials ?? null) as { audience?: string } | null;
  if (!oauth) return;
  const issued = sim.state.rest.auth?.issued ?? [];
  expect(issued.length, "an access token was issued").toBeGreaterThan(0);
  const base = String(r.api?.base_url ?? r.base_url_example);
  const audience = oauth.audience?.startsWith("/") ? new URL(oauth.audience, base).href : oauth.audience;
  for (const t of issued) expect(t.audience).toBe(audience);
}

/** Gone, or for a recipe whose destroy archives (a POST with a body), still there with the archive fields set. */
function expectDestroyed(sim: SimHandle, op: RecipeOp, spec: Record<string, unknown>): void {
  const archive = (spec.delete as { body?: Record<string, unknown> } | undefined)?.body;
  if (!archive) return void expect(simItems(sim, op, spec)).toEqual([]);
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

async function listDrift(run: Run, sim: SimHandle, spec: Record<string, unknown>): Promise<void> {
  const list = parentList(sim, spec);
  list.remove();
  let res = await run.cli("plan --json", sim);
  expect({ code: res.code, status: lineOf(res).status, drift: (res.json?.drift as Array<{ kind: string }>).map((d) => d.kind).filter((k) => k !== "unmanaged") }, `missing drift${diag(res)}`).toEqual({ code: 0, status: "create", drift: ["missing"] });
  res = await run.cli("apply --json", sim);
  expect(res.code, `put back${diag(res)}`).toBe(0);
  expect(parentList(sim, spec).has()).toBe(true);
}

/** One CLI step, expected to exit with `code` and leave the line with `status`. */
async function step(run: Run, sim: SimHandle, args: string, code: number, status: string): Promise<CliRun & { writes: number }> {
  const res = await run.cli(args, sim);
  expect({ code: res.code, status: lineOf(res).status }, `${args}${diag(res)}`).toEqual({ code, status });
  return res;
}

function driftKinds(res: CliRun): string[] {
  return ((res.json?.drift as Array<{ kind: string }> | undefined) ?? []).map((d) => d.kind).filter((k) => k !== "unmanaged");
}

/** The lifecycle against the first-class sim the recipe op names (`sim.provider`), observed through its hints. */
async function lifecycleInProviderSim(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  const hints = op.sim!;
  const provider = hints.provider as ProviderName;
  const params = exampleParams(op);
  const sim = await startSim({ seed: { [provider]: structuredClone(hints.seed ?? {}) } as Partial<SimSeed> });
  const ws = await workspace("recipe", { plan: planText(r, name, op, params) });
  const env = cliEnv(sim, { [String(r.api?.base_url_env)]: `${sim.url}${hints.base_path ?? `/${provider}`}`, ...credentialEnv(r), ...(await fakeCli(r, ws.dir)) });
  const run = new Run(ws, env, SIM_CTX, secretOf(r));
  const present = () => valueAt(sim.state.provider(provider), hints.present ?? "") !== undefined;
  const drift = (d: Record<string, string>) => sim.state.applyChaos({ drift: Object.fromEntries(Object.entries(d).map(([k, v]) => [`${provider}.${k}`, v])) });
  try {
    await step(run, sim, "plan --json", 0, "create");
    await step(run, sim, "apply --json", 0, "applied");
    expect(present(), `${hints.present} once applied`).toBe(true);
    expect((await step(run, sim, "apply --json", 0, "unchanged")).writes, "re-apply writes nothing").toBe(0);
    if (hints.drift?.changed) {
      drift(hints.drift.changed);
      expect(driftKinds(await step(run, sim, "plan --json", 1, "blocked"))).toEqual(["changed"]);
      await step(run, sim, "apply --reconcile --json", 0, "applied");
      expect((await step(run, sim, "apply --json", 0, "unchanged")).writes, "reconciled: nothing left to write").toBe(0);
    }
    drift(hints.drift?.missing ?? {});
    expect(present(), `${hints.present} removed by hand`).toBe(false);
    expect(driftKinds(await step(run, sim, "plan --json", 0, "create"))).toEqual(["missing"]);
    await step(run, sim, "apply --json", 0, "applied");
    expect(present(), `${hints.present} recreated`).toBe(true);
    await step(run, sim, "apply --destroy --json", 0, "destroyed");
    expect(present(), `${hints.present} after destroy`).toBe(false);
  } finally {
    await sim.close();
    await ws.cleanup();
  }
}

async function lifecycleLive(r: Recipe, name: string, op: RecipeOp): Promise<void> {
  const scope = `pr-${900000 + (parseInt(randomBytes(4).toString("hex"), 16) % 99999)}`;
  const ws = await workspace("recipe-live", { plan: planText(r, name, op, exampleParams(op, process.env), process.env[String(r.api?.base_url_env)]) });
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
  if (op.kind === "action") it("run, unchanged re-apply, run again on a new trigger, and destroy against the fake cloud", () => actionInSim(r, name, op), 60_000);
  else it("create, idempotent re-apply, drift and destroy against the fake cloud", () => lifecycleInSim(r, name, op), 60_000);

  // A per-account API is reached live through its base_url_env.
  const live = [...credentialVars(r), ...(r.api && r.api.base_url === undefined ? [String(r.api.base_url_env)] : []), ...Object.values(op.live?.params ?? {})];
  it.skipIf(!LIVE || live.some((v) => !process.env[v]))(`@live: create, re-apply and destroy against the real API (needs ${live.join(", ")})`, () => lifecycleLive(r, name, op), 120_000);
});
