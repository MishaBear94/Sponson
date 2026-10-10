/**
 * The generic `http` adapter's plan syntax, parsed and checked: the per-API provider block, the params of
 * `http.resource` and `http.list_item`, JSON pointers and path placeholders. Pure: no I/O. Every malformed spec is
 * a PARAM_INVALID (or PLAN_INVALID for the provider block) naming the field at fault. See ADR 0017 and
 * docs/plan-format.md (`http.resource`, `http.list_item`).
 */
import { SponsonError, canonicalJson, markerKind, sha256 } from "@sponson/core";
import { paramError } from "./common.js";
import { isObject } from "./http.js";
import { expandRecipe, lineApi, resolveRecipeApi } from "./recipes.js";

export const ADAPTER = "http";

// ---------------------------------------------------------------------------
// JSON pointers (RFC 6901) and field names
// ---------------------------------------------------------------------------

/** A JSON pointer's reference tokens. `""` is the whole document. */
export function pointerTokens(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A field as the plan writes it: `name` (a top-level field) or a JSON pointer `/config/url`. */
export function fieldTokens(field: string): string[] {
  return field.startsWith("/") ? pointerTokens(field) : [field];
}

/** The value at `tokens` in `doc`, or undefined. */
export function at(doc: unknown, tokens: string[]): unknown {
  let cur = doc;
  for (const t of tokens) {
    if (Array.isArray(cur) && /^\d+$/.test(t)) cur = cur[Number(t)];
    else if (isObject(cur)) cur = cur[t];
    else return undefined;
  }
  return cur;
}

/** A copy of `doc` (an object) with `value` set at `tokens`, creating objects on the way. */
export function setAt(doc: Record<string, unknown>, tokens: string[], value: unknown): Record<string, unknown> {
  if (tokens.length === 0) return isObject(value) ? { ...value } : doc;
  const [head, ...rest] = tokens as [string, ...string[]];
  const child = isObject(doc[head]) ? (doc[head] as Record<string, unknown>) : {};
  return { ...doc, [head]: rest.length === 0 ? value : setAt(child, rest, value) };
}

/** Objects merged recursively (`b` wins); anything else is replaced by `b`. */
export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** The request body that sets every field of `fields` (names or pointers), skipping `skip`. */
export function bodyOf(fields: Record<string, unknown>, skip: (v: unknown) => boolean = () => false): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  for (const [f, v] of Object.entries(fields)) if (!skip(v)) body = setAt(body, fieldTokens(f), v);
  return body;
}

/** `item` reduced to the declared fields, in the one canonical form both hashes and diffs use. Absent is null. */
export function projection(item: unknown, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, at(item, fieldTokens(f)) ?? null]));
}

/** The hash of a resource's declared state: `sha256(canonicalJson(projection))`. */
export function stateHash(state: unknown): string {
  return sha256(canonicalJson(state));
}

/** True when the value is `{ keep: true }`'s marker. */
export function isKeep(v: unknown): boolean {
  return markerKind(v) === "keep";
}

/** The first pending or secret marker anywhere in `v`, if any. */
export function firstMarker(v: unknown): string | undefined {
  const kind = markerKind(v);
  if (kind === "pending" || kind === "secret") return v as string;
  if (Array.isArray(v)) return v.map(firstMarker).find((m) => m !== undefined);
  if (isObject(v)) return Object.values(v).map(firstMarker).find((m) => m !== undefined);
  return undefined;
}

// ---------------------------------------------------------------------------
// Param checks
// ---------------------------------------------------------------------------

function fail(message: string, param: string): SponsonError {
  return paramError(ADAPTER, message, param);
}

function optionalObject(v: unknown, param: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) throw fail(`\`${param}\` must be a map`, param);
  return v;
}

function requiredObject(v: unknown, param: string): Record<string, unknown> {
  const o = optionalObject(v, param);
  if (!o) throw fail(`\`${param}\` is required`, param);
  return o;
}

/** A path: starts with `/`; pending markers are allowed in the `{name}` values only, not here. */
function pathParam(v: unknown, param: string): string {
  if (typeof v !== "string" || !v.startsWith("/")) throw fail(`\`${param}\` must be a path starting with "/" (relative to the API's base_url)`, param);
  return v;
}

function pointerParam(v: unknown, param: string, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string" || (v !== "" && !v.startsWith("/"))) throw fail(`\`${param}\` must be a JSON pointer: "" for the whole body, or "/field/sub"`, param);
  return v;
}

function fieldParam(v: unknown, param: string): string {
  if (typeof v !== "string" || v === "") throw fail(`\`${param}\` must be a field name or a JSON pointer such as "/config/url"`, param);
  return v;
}

function methodParam(v: unknown, param: string, allowed: readonly string[], fallback: string): string {
  if (v === undefined || v === null) return fallback;
  const m = typeof v === "string" ? v.toUpperCase() : "";
  if (!allowed.includes(m)) throw fail(`\`${param}\` must be one of ${allowed.join(", ")}`, param);
  return m;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The `{name}` placeholders of a path. */
export function placeholders(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Every placeholder of `path` must be `{id}` (when `id` is allowed) or a key of `vars`. */
function checkPlaceholders(path: string, param: string, vars: Record<string, unknown>, idAllowed: boolean): void {
  for (const name of placeholders(path)) {
    if (name === "id" && idAllowed) continue;
    if (!(name in vars)) throw fail(`\`${param}\` uses \`{${name}}\`, which is ${name === "id" ? "not known here (the id exists only once the object does)" : "not declared in `vars`"}`, param);
  }
}

/**
 * `path` with `{id}` and every `{var}` substituted (URI-encoded); undefined when a value is not known yet (a pending
 * reference).
 */
export function fillPath(path: string, vars: Record<string, unknown>, id?: string): string | undefined {
  const value = (name: string): unknown => (name === "id" && id !== undefined ? id : vars[name]);
  const known = (v: unknown) => markerKind(v) === null && v !== undefined && v !== null && typeof v !== "object";
  if (!placeholders(path).every((name) => known(value(name)))) return undefined;
  return path.replace(PLACEHOLDER, (_m, name: string) => encodeURIComponent(String(value(name))));
}

// ---------------------------------------------------------------------------
// The provider block: one per API
// ---------------------------------------------------------------------------

/** How the credential is sent; `none` only for a public endpoint a manual step's verify request reads. */
export type Auth = { kind: "bearer"; env: string } | { kind: "header"; header: string; env: string } | { kind: "basic"; userEnv: string; passwordEnv: string } | { kind: "none" };

/** One API's configuration, from `providers.http.<api>`. */
export interface ApiConfig {
  baseUrl: string;
  baseUrlEnv?: string;
  auth: Auth;
  headers: Record<string, string>;
  encoding: "json" | "form";
  /** The API is a production system: lines through it need Sponson's approval (`writesEnvironment`). */
  production: boolean;
}

const API_KEYS = ["base_url", "base_url_env", "auth", "headers", "encoding", "production"];

/**
 * Variable names the engine masks everywhere (packages/core/src/engine/run-context.ts, CREDENTIAL_NAME). A
 * credential under another name would be masked only in this adapter's own error text, so it is refused.
 */
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function planError(message: string, where: string): SponsonError {
  return new SponsonError("PLAN_INVALID", `${ADAPTER}: ${where}: ${message}`, { adapter: ADAPTER, key: where });
}

function envName(v: unknown, where: string, credential: boolean): string {
  if (typeof v !== "string" || !ENV_NAME.test(v)) throw planError("must be the NAME of an environment variable, never a value", where);
  if (credential && !CREDENTIAL_NAME.test(v)) throw planError(`\`${v}\` must end in TOKEN, SECRET, PASSWORD, PASSWD, _KEY or APIKEY, so that Sponson masks its value in every output`, where);
  return v;
}

const AUTH_FORMS = "`{ bearer_env: NAME }`, `{ header: X-Api-Key, value_env: NAME }` or `{ basic: { user_env: NAME, password_env: NAME } }`";

function parseAuth(v: unknown, where: string): Auth {
  if (!isObject(v)) throw planError(`is required: ${AUTH_FORMS}`, where);
  if (v.bearer_env !== undefined) return { kind: "bearer", env: envName(v.bearer_env, `${where}.bearer_env`, true) };
  if (v.basic !== undefined) {
    if (!isObject(v.basic)) throw planError("must be `{ user_env: NAME, password_env: NAME }`", `${where}.basic`);
    return { kind: "basic", userEnv: envName(v.basic.user_env, `${where}.basic.user_env`, false), passwordEnv: envName(v.basic.password_env, `${where}.basic.password_env`, true) };
  }
  if (typeof v.header !== "string" || !HEADER_NAME.test(v.header)) throw planError(`must be one of ${AUTH_FORMS}`, where);
  return { kind: "header", header: v.header, env: envName(v.value_env, `${where}.value_env`, true) };
}

function parseEncoding(v: unknown, where: string): "json" | "form" {
  if (v === undefined || v === "json" || v === "form") return v ?? "json";
  throw planError("must be `json` (the default) or `form` (application/x-www-form-urlencoded)", where);
}

function parseHeaders(v: unknown, where: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) throw planError("must be a map of header name to string value", where);
  for (const [k, x] of Object.entries(v)) {
    if (!HEADER_NAME.test(k) || typeof x !== "string") throw planError(`\`${k}\` must be a header name with a string value`, where);
    if (/^(authorization|accept|content-type)$/i.test(k)) throw planError(`\`${k}\` is set by Sponson; configure the credential under \`auth\``, where);
  }
  return v as Record<string, string>;
}

function parseProduction(v: unknown, where: string): boolean {
  if (v === undefined || typeof v === "boolean") return v ?? false;
  throw planError("must be true (lines through this API write production and need approval) or false", where);
}

/**
 * `OpSpec.writesEnvironment` for both ops: `production` when the line's API block says `production: true` (a live
 * Stripe account, a production tenant), so the run needs approval whatever its environment; otherwise not
 * environment-specific. `provider` is the block `apiBlock` narrowed to, already checked.
 */
export function apiEnvironment(_params: Record<string, unknown>, _ctx: unknown, provider?: Record<string, unknown>): "production" | null {
  return provider?.production === true ? "production" : null;
}

/**
 * One API block, checked. `where` names it in messages (`providers.http.statsig`). `authOptional`: a block without
 * `auth` sends no credential (the `manual` adapter's verify requests to public endpoints); the `http` adapter's
 * blocks always need one.
 */
export function parseApi(block: Record<string, unknown>, where: string, opts: { authOptional?: boolean } = {}): ApiConfig {
  const base = block.base_url;
  if (typeof base !== "string" || !/^https?:\/\/[^\s]+$/.test(base)) throw planError("`base_url` must be an http(s) URL", where);
  const unknown = Object.keys(block).filter((k) => !API_KEYS.includes(k));
  if (unknown.length) throw planError(`unknown key \`${unknown[0]}\` (known: ${API_KEYS.join(", ")})`, where);
  const cfg: ApiConfig = {
    baseUrl: base,
    auth: block.auth === undefined && opts.authOptional ? { kind: "none" } : parseAuth(block.auth, `${where}.auth`),
    headers: parseHeaders(block.headers, `${where}.headers`),
    encoding: parseEncoding(block.encoding, `${where}.encoding`),
    production: parseProduction(block.production, `${where}.production`),
  };
  if (block.base_url_env !== undefined) cfg.baseUrlEnv = envName(block.base_url_env, `${where}.base_url_env`, false);
  return cfg;
}

/**
 * `OpSpec.providerFor` for both ops: the `providers.http.<api>` block the line's `api` names, checked. Lines of
 * different APIs therefore have independent ledger identities.
 */
export function apiBlock(block: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const api = lineApi(params);
  if (typeof api !== "string" || api === "") throw fail("`api` is required: the name of an API configured under `providers.http`", "api");
  const where = `providers.http.${api}`;
  const recipe = typeof params.recipe === "string" ? params.recipe.split(".")[0] : undefined;
  // A recipe line needs no block of its own: `api` defaults to the recipe's provider, and so does its block.
  const raw = block[api] ?? (recipe === api ? { recipe } : undefined);
  if (!isObject(raw)) {
    const known = Object.keys(block);
    throw planError(`no API \`${api}\` is configured (known: ${known.length ? known.join(", ") : "none"})`, where);
  }
  const cfg = resolveRecipeApi(raw, where);
  if (raw.recipe !== undefined && recipe !== undefined && recipe !== raw.recipe) throw planError(`uses recipe \`${String(raw.recipe)}\`, but the line's recipe is \`${String(params.recipe)}\``, where);
  if (raw.recipe !== undefined && cfg.base_url === undefined) throw planError(`recipe \`${String(raw.recipe)}\` has no default \`base_url\` (each account has its own): set \`base_url\` in this block`, where);
  parseApi(cfg, where);
  return cfg;
}


// ---------------------------------------------------------------------------
// Shared by both ops
// ---------------------------------------------------------------------------

/** What `destroy` does with what Sponson created: remove it (the default), or leave it in place. */
export type DestroyMode = "delete" | "keep";

function parseDestroy(v: unknown): DestroyMode {
  if (v === undefined || v === "delete" || v === "keep") return v ?? "delete";
  throw fail("`destroy` must be `delete` (the default) or `keep` (leave it in place when the scope is destroyed)", "destroy");
}

function statusList(v: unknown, param: string): number[] {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((s) => Number.isInteger(s) && (s as number) >= 400 && (s as number) <= 599)) throw fail(`\`${param}\` must be a list of HTTP error statuses (400–599)`, param);
  return list as number[];
}

function contentTypeParam(v: unknown, param: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(v)) throw fail(`\`${param}\` must be a media type such as application/merge-patch+json`, param);
  return v;
}

function apiParam(params: Record<string, unknown>): string {
  const api = params.api;
  if (typeof api !== "string" || api === "") throw fail("`api` is required: the name of an API configured under `providers.http`", "api");
  return api;
}

function noUnknownParams(params: Record<string, unknown>, known: string[], op: string): void {
  const extra = Object.keys(params).find((k) => !known.includes(k));
  if (extra) throw fail(`\`${extra}\` is not a parameter of http.${op} (known: ${known.join(", ")})`, extra);
}

// ---------------------------------------------------------------------------
// http.resource
// ---------------------------------------------------------------------------

/** One request of a spec: method and path (placeholders unfilled), the extra body it sends, its media type. */
export interface RequestSpec {
  method: string;
  path: string;
  body: Record<string, unknown>;
  contentType?: string;
}

/** How a resource is located by natural key: a list, the array in it, and the fields that must match. */
export interface FindSpec {
  path: string;
  listPath: string;
  match: Record<string, unknown>;
  /** Pointer to the next page's cursor in a list response, and the query parameter that sends it back. */
  next?: { path: string; param: string };
}

/** Declared output: a pointer into the object, and whether it must never be shown. */
export interface OutputDecl {
  path: string;
  sensitive: boolean;
}

/** `http.resource` params, checked. Values may still be markers. */
export interface ResourceSpec {
  api: string;
  vars: Record<string, unknown>;
  create: RequestSpec & { idempotencyKey: boolean };
  read?: { path: string };
  find?: FindSpec;
  update?: RequestSpec;
  delete: { method: string; path: string };
  destroy: DestroyMode;
  itemPath: string;
  idPath: string;
  fields: Record<string, unknown>;
  outputs: Record<string, OutputDecl>;
  /** Statuses that mean "it exists already" on create (besides 409 and the client's conflict wording). */
  existsStatus: number[];
  /** Statuses that mean "it is gone" on read and delete (besides 404). */
  goneStatus: number[];
}

const RESOURCE_PARAMS = ["api", "vars", "create", "read", "find", "update", "delete", "destroy", "item_path", "id_path", "fields", "outputs", "exists_status", "gone_status"];

function parseRequest(v: unknown, param: string, methods: readonly string[], fallback: string, vars: Record<string, unknown>, idAllowed: boolean, defaultPath?: string): RequestSpec {
  const o = requiredObject(v, param);
  const path = o.path === undefined && defaultPath !== undefined ? defaultPath : pathParam(o.path, `${param}.path`);
  checkPlaceholders(path, `${param}.path`, vars, idAllowed);
  const contentType = contentTypeParam(o.content_type, `${param}.content_type`);
  return { method: methodParam(o.method, `${param}.method`, methods, fallback), path, body: optionalObject(o.body, `${param}.body`) ?? {}, ...(contentType ? { contentType } : {}) };
}

function parseCreate(v: unknown, vars: Record<string, unknown>): ResourceSpec["create"] {
  const r = parseRequest(v, "create", ["POST", "PUT", "PATCH"], "POST", vars, false);
  const key = (v as Record<string, unknown>).idempotency_key;
  if (key !== undefined && typeof key !== "boolean") throw fail("`create.idempotency_key` must be true or false", "create.idempotency_key");
  return { ...r, idempotencyKey: key === true };
}

function parseFind(v: unknown, vars: Record<string, unknown>): FindSpec | undefined {
  const o = optionalObject(v, "find");
  if (!o) return undefined;
  const path = pathParam(o.path, "find.path");
  checkPlaceholders(path, "find.path", vars, false);
  const match = requiredObject(o.match, "find.match");
  if (Object.keys(match).length === 0) throw fail("`find.match` must name at least one field", "find.match");
  const spec: FindSpec = { path, listPath: pointerParam(o.list_path, "find.list_path", ""), match };
  if (o.next !== undefined) {
    const param = o.cursor_param === undefined ? "cursor" : o.cursor_param;
    if (typeof param !== "string" || param === "") throw fail("`find.cursor_param` must be a query parameter name", "find.cursor_param");
    spec.next = { path: pointerParam(o.next, "find.next", ""), param };
  }
  return spec;
}

function parseRead(v: unknown, vars: Record<string, unknown>, find: FindSpec | undefined): { path: string } | undefined {
  const o = optionalObject(v, "read");
  if (!o) {
    if (!find) throw fail("needs `read` (a path that names the object) or `find` (a list and the fields that identify it)", "read");
    return undefined;
  }
  const path = pathParam(o.path, "read.path");
  if (placeholders(path).includes("id") && !find) throw fail("`read.path` uses `{id}`, so the object can only be located with `find` (the id is not in the plan)", "read.path");
  checkPlaceholders(path, "read.path", vars, true);
  return { path };
}

/** Update and delete go to the read path by default: the object's own URL. */
function parseDelete(v: unknown, vars: Record<string, unknown>, read: { path: string } | undefined): { method: string; path: string } {
  if (v === undefined && read === undefined) throw fail("`delete` is required: `{ path: /things/{id} }` (no `read.path` to default to)", "delete");
  const r = parseRequest(v ?? {}, "delete", ["DELETE", "POST"], "DELETE", vars, true, read?.path);
  return { method: r.method, path: r.path };
}

function parseOutputs(v: unknown): Record<string, OutputDecl> {
  const o = optionalObject(v, "outputs") ?? {};
  const out: Record<string, OutputDecl> = {};
  for (const [name, decl] of Object.entries(o)) {
    const param = `outputs.${name}`;
    if (name === "id") throw fail("`outputs.id` is reserved: the object's id is always the output `id`", param);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(`output name \`${name}\` must be letters, digits and _`, param);
    if (typeof decl === "string") out[name] = { path: pointerParam(decl, param, ""), sensitive: false };
    else if (isObject(decl)) out[name] = { path: pointerParam(decl.path, `${param}.path`, ""), sensitive: decl.sensitive === true };
    else throw fail(`\`${param}\` must be a JSON pointer, or \`{ path, sensitive: true }\``, param);
  }
  return out;
}

function parseFields(v: unknown, param: string): Record<string, unknown> {
  const o = optionalObject(v, param) ?? {};
  for (const f of Object.keys(o)) fieldParam(f, `${param}.${f}`);
  return o;
}

/** `http.resource` params, checked; PARAM_INVALID naming the field otherwise. */
export function parseResource(line: Record<string, unknown>): ResourceSpec {
  const params = expandRecipe(line, "resource");
  noUnknownParams(params, RESOURCE_PARAMS, "resource");
  const api = apiParam(params);
  const vars = optionalObject(params.vars, "vars") ?? {};
  const find = parseFind(params.find, vars);
  const read = parseRead(params.read, vars, find);
  const spec: ResourceSpec = {
    api,
    vars,
    create: parseCreate(params.create, vars),
    ...(find ? { find } : {}),
    ...(read ? { read } : {}),
    delete: parseDelete(params.delete, vars, read),
    destroy: parseDestroy(params.destroy),
    itemPath: pointerParam(params.item_path, "item_path", ""),
    idPath: pointerParam(params.id_path, "id_path", "/id"),
    fields: parseFields(params.fields, "fields"),
    outputs: parseOutputs(params.outputs),
    existsStatus: statusList(params.exists_status, "exists_status"),
    goneStatus: statusList(params.gone_status, "gone_status"),
  };
  if (params.update !== undefined) spec.update = parseRequest(params.update, "update", ["PATCH", "PUT", "POST"], "PATCH", vars, true, read?.path);
  return spec;
}

/** The outputs one `http.resource` line declares: always `id`, plus its `outputs`. */
export function resourceOutputs(line: Record<string, unknown>): Record<string, { available: "immediate"; sensitive?: boolean }> {
  const params = expandRecipe(line, "resource");
  const out: Record<string, { available: "immediate"; sensitive?: boolean }> = { id: { available: "immediate" } };
  for (const [name, d] of Object.entries(parseOutputs(params.outputs))) out[name] = d.sensitive ? { available: "immediate", sensitive: true } : { available: "immediate" };
  return out;
}

// ---------------------------------------------------------------------------
// http.list_item
// ---------------------------------------------------------------------------

/**
 * How the parent holds its items: a JSON array (`array`), one string of values joined by `separator`
 * (`delimited`, such as a comma-separated allow-list), or a map of name to value (`map`, such as config vars,
 * where writing `null` for a name deletes it).
 */
export type ListShape = "array" | "delimited" | "map";

/** `http.list_item` params, checked. */
export interface ListItemSpec {
  api: string;
  vars: Record<string, unknown>;
  parent: { path: string; readPath: string; method: string; send: "field" | "parent"; contentType?: string };
  listPath: string;
  shape: ListShape;
  separator: string;
  /** The item: a value or a map (`array`), a string (`delimited`), the entry's name (`map`). */
  item: unknown;
  /** For map items of an `array`: the field that identifies an item in the list. */
  keyField?: string;
  /** For `map`: the entry's value. */
  value?: unknown;
  destroy: DestroyMode;
}

const LIST_PARAMS = ["api", "vars", "parent", "list_path", "shape", "separator", "item", "key_field", "value", "destroy"];

function parseParent(v: unknown, vars: Record<string, unknown>): ListItemSpec["parent"] {
  const o = requiredObject(v, "parent");
  const path = pathParam(o.path, "parent.path");
  checkPlaceholders(path, "parent.path", vars, false);
  const readPath = o.read_path === undefined ? path : pathParam(o.read_path, "parent.read_path");
  checkPlaceholders(readPath, "parent.read_path", vars, false);
  const send = o.send ?? "field";
  if (send !== "field" && send !== "parent") throw fail("`parent.send` must be `field` (send only the list) or `parent` (send the whole object back)", "parent.send");
  const contentType = contentTypeParam(o.content_type, "parent.content_type");
  return { path, readPath, method: methodParam(o.method, "parent.method", ["PATCH", "PUT", "POST"], "PATCH"), send, ...(contentType ? { contentType } : {}) };
}

function scalarItem(v: unknown, what: string): unknown {
  if (isObject(v) || Array.isArray(v)) throw fail(`\`item\` must be ${what}`, "item");
  if (isKeep(v)) throw fail("`item` cannot be `{ keep: true }`: it is the item's identity", "item");
  return v;
}

function parseArrayItem(v: unknown, keyField: unknown): { item: unknown; keyField?: string } {
  if (!isObject(v)) {
    if (keyField !== undefined) throw fail("`key_field` applies only when `item` is a map", "key_field");
    return { item: scalarItem(v, "a single value or a map, not a list") };
  }
  const field = fieldParam(keyField, "key_field");
  const key = at(v, fieldTokens(field));
  if (key === undefined || isObject(key) || Array.isArray(key) || isKeep(key)) throw fail(`\`item\` must set \`${field}\` (its \`key_field\`) to a value`, `item.${field}`);
  return { item: v, keyField: field };
}

function parseShape(v: unknown): ListShape {
  if (v === undefined || v === "array" || v === "delimited" || v === "map") return v ?? "array";
  throw fail("`shape` must be `array` (the default), `delimited` or `map`", "shape");
}

/** The shape-specific params: what identifies the item, and what else the shape takes. */
function parseShaped(params: Record<string, unknown>, shape: ListShape): Pick<ListItemSpec, "item" | "keyField" | "value" | "separator"> {
  if (params.item === undefined || params.item === null) throw fail("`item` is required: the value to keep in the list (for `shape: map`, the entry's name)", "item");
  const only = (name: string, allowed: boolean) => {
    if (!allowed && params[name] !== undefined) throw fail(`\`${name}\` does not apply to \`shape: ${shape}\``, name);
  };
  only("key_field", shape === "array");
  only("value", shape === "map");
  only("separator", shape === "delimited");
  if (shape === "array") return { separator: ",", ...parseArrayItem(params.item, params.key_field) };
  const sep = params.separator ?? ",";
  if (typeof sep !== "string" || sep.trim() === "") throw fail("`separator` must be a non-blank string, e.g. \",\"", "separator");
  if (shape === "delimited") return { separator: sep, item: scalarItem(params.item, "a single string for `shape: delimited`") };
  if (params.value === undefined) throw fail("`value` is required for `shape: map`: the entry's value (`null` is not a value: it deletes)", "value");
  return { separator: sep, item: scalarItem(params.item, "the entry's name for `shape: map`"), value: params.value };
}

/** `http.list_item` params, checked; PARAM_INVALID naming the field otherwise. */
export function parseListItem(line: Record<string, unknown>): ListItemSpec {
  const params = expandRecipe(line, "list_item");
  noUnknownParams(params, LIST_PARAMS, "list_item");
  const api = apiParam(params);
  const vars = optionalObject(params.vars, "vars") ?? {};
  const shape = parseShape(params.shape);
  const listPath = pointerParam(params.list_path, "list_path", "");
  if (listPath === "" && shape !== "map") throw fail("`list_path` is required: the JSON pointer to the list in the parent, e.g. /allowed_origins", "list_path");
  return { api, vars, parent: parseParent(params.parent, vars), listPath, shape, ...parseShaped(params, shape), destroy: parseDestroy(params.destroy) };
}
