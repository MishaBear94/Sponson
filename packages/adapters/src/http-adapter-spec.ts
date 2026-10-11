/**
 * The generic `http` adapter's plan syntax, parsed and checked: the per-API provider block, the params of
 * `http.resource` and `http.list_item`, JSON pointers and path placeholders. Pure: no I/O. Every malformed spec is
 * a PARAM_INVALID (or PLAN_INVALID for the provider block) naming the field at fault. See ADR 0017 and
 * docs/plan-format.md (`http.resource`, `http.list_item`).
 */
import { canonicalJson, markerKind, sha256, type OutputSpec, type SponsonError } from "@sponson/core";
import { paramError } from "./common.js";
import { isObject } from "./http.js";
import { HEADER_NAME, envName, parseAuth, planError, type Auth } from "./http-adapter-auth.js";
import { parseGraphql, usesId, type GraphqlSpec } from "./http-adapter-graphql.js";
import { expandRecipe, lineApi, resolveRecipeApi } from "./recipes.js";

export type { Auth } from "./http-adapter-auth.js";

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

/** `{name}` (the value URI-encoded as one segment) or `{+name}` (reserved expansion, RFC 6570: `/` and `:` kept). */
const PLACEHOLDER = /\{(\+?)([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The `{name}` and `{+name}` placeholders of a path, by name. */
export function placeholders(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[2]!);
}

/**
 * A value as a path placeholder: one segment, URI-encoded; or, for `{+name}`, a URL or path written as it is
 * (QStash takes the destination URL raw in the path), with only what cannot stand in a path escaped.
 */
function encodeSegment(value: string, reserved: boolean): string {
  return reserved ? encodeURI(value).replace(/[?#]/g, (c) => encodeURIComponent(c)) : encodeURIComponent(value);
}

/** Every placeholder of `path` must be `{id}` (when `id` is allowed) or a key of `vars`. */
function checkPlaceholders(path: string, param: string, vars: Record<string, unknown>, idAllowed: boolean): void {
  for (const name of placeholders(path)) {
    if (name === "id" && idAllowed) continue;
    if (!(name in vars)) throw fail(`\`${param}\` uses \`{${name}}\`, which is ${name === "id" ? "not known here (the id exists only once the object does)" : "not declared in `vars`"}`, param);
  }
}

/**
 * `path` with `{id}` and every `{var}` substituted (URI-encoded; `{+var}` keeps `/` and `:`); undefined when a value
 * is not known yet (a pending reference).
 */
export function fillPath(path: string, vars: Record<string, unknown>, id?: string): string | undefined {
  const value = (name: string): unknown => (name === "id" && id !== undefined ? id : vars[name]);
  const known = (v: unknown) => markerKind(v) === null && v !== undefined && v !== null && typeof v !== "object";
  if (!placeholders(path).every((name) => known(value(name)))) return undefined;
  return path.replace(PLACEHOLDER, (_m, plus: string, name: string) => encodeSegment(String(value(name)), plus === "+"));
}

// ---------------------------------------------------------------------------
// The provider block: one per API
// ---------------------------------------------------------------------------

/** One API's configuration, from `providers.http.<api>`. */
export interface ApiConfig {
  baseUrl: string;
  baseUrlEnv?: string;
  auth: Auth;
  headers: Record<string, string>;
  encoding: "json" | "form" | "xml";
  /** A versioned media type sent as `Accept` and as the `Content-Type` of JSON bodies (Atlas `application/vnd.atlas.2023-01-01+json`). */
  mediaType?: string;
  /** The API is a production system: lines through it need Sponson's approval (`writesEnvironment`). */
  production: boolean;
  /**
   * Credentials this API refuses: a value starting with one of `prefixes` (Stripe's `sk_live_`) is PROVIDER_AUTH
   * before any request, unless the variable `unlessEnv` is `1` or `true`.
   */
  refuse?: { prefixes: string[]; unlessEnv: string };
}

const API_KEYS = ["base_url", "base_url_env", "auth", "headers", "encoding", "media_type", "production", "refuse_credential"];

function parseEncoding(v: unknown, where: string): "json" | "form" | "xml" {
  if (v === undefined || v === "json" || v === "form" || v === "xml") return v ?? "json";
  throw planError("must be `json` (the default), `form` (application/x-www-form-urlencoded) or `xml` (S3-style XML documents)", where);
}

function parseHeaders(v: unknown, where: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) throw planError("must be a map of header name to string value", where);
  for (const [k, x] of Object.entries(v)) {
    if (!HEADER_NAME.test(k) || typeof x !== "string") throw planError(`\`${k}\` must be a header name with a string value`, where);
    if (/^(authorization|accept|content-type)$/i.test(k)) throw planError(`\`${k}\` is set by Sponson; configure the credential under \`auth\` and a versioned media type under \`media_type\``, where);
  }
  return v as Record<string, string>;
}

function parseMediaType(v: unknown, where: string, encoding: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(v)) throw planError("must be a media type such as application/vnd.atlas.2023-01-01+json", where);
  if (encoding !== "json") throw planError("applies to `encoding: json` only", where);
  return v;
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
  const encoding = parseEncoding(block.encoding, `${where}.encoding`);
  const mediaType = parseMediaType(block.media_type, `${where}.media_type`, encoding);
  const cfg: ApiConfig = {
    baseUrl: base,
    auth: block.auth === undefined && opts.authOptional ? { kind: "none" } : parseAuth(block.auth, `${where}.auth`, base),
    headers: parseHeaders(block.headers, `${where}.headers`),
    encoding,
    ...(mediaType ? { mediaType } : {}),
    production: parseProduction(block.production, `${where}.production`),
  };
  if (block.base_url_env !== undefined) cfg.baseUrlEnv = envName(block.base_url_env, `${where}.base_url_env`, false);
  if (block.refuse_credential !== undefined) cfg.refuse = parseRefuse(block.refuse_credential, `${where}.refuse_credential`);
  return cfg;
}

function parseRefuse(v: unknown, where: string): { prefixes: string[]; unlessEnv: string } {
  const prefixes = isObject(v) ? v.prefixes : undefined;
  if (!isObject(v) || !Array.isArray(prefixes) || prefixes.length === 0 || !prefixes.every((p) => typeof p === "string" && p.length >= 3)) {
    throw planError("must be `{ prefixes: [sk_live_, …], unless_env: NAME }`: credential prefixes to refuse, and the variable that allows them", where);
  }
  const extra = Object.keys(v).find((k) => k !== "prefixes" && k !== "unless_env");
  if (extra) throw planError(`unknown key \`${extra}\` (known: prefixes, unless_env)`, where);
  return { prefixes: prefixes as string[], unlessEnv: envName(v.unless_env, `${where}.unless_env`, false) };
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
  if (raw.recipe !== undefined && raw.refuse_credential !== undefined) {
    // A recipe's refusal is a safety rule (Stripe: never live keys from a preview), not a default to tune per plan.
    throw planError("`refuse_credential` comes from the recipe and cannot be overridden; its `unless_env` variable is the opt-out", `${where}.refuse_credential`);
  }
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

/**
 * One request of a spec: method and path (placeholders unfilled), the extra body it sends, its media type, the
 * headers it sends (values may be references until apply), and whether the declared `fields` go in its body
 * (`send_fields: false` when the request carries them elsewhere, such as in headers); or a GraphQL request (`path`
 * is then "", the endpoint being the API's base URL).
 */
export interface RequestSpec {
  method: string;
  path: string;
  body: Record<string, unknown>;
  contentType?: string;
  headers: Record<string, unknown>;
  sendFields: boolean;
  graphql?: GraphqlSpec;
}

/** How a resource is located by natural key: a list, the array in it, and the fields that must match. */
export interface FindSpec {
  /** "" for a GraphQL find. */
  path: string;
  graphql?: GraphqlSpec;
  listPath: string;
  match: Record<string, unknown>;
  /** Pointer to the next page's cursor in a list response, and the query parameter that sends it back. */
  next?: { path: string; param: string };
}

/**
 * Declared output: a pointer into the object, whether it must never be shown, and whether the provider reveals it
 * only in the answer that creates the object (`once`, ADR 0018: an API key's token, a signing secret).
 */
export interface OutputDecl {
  path: string;
  sensitive: boolean;
  once: boolean;
}

/** `http.resource` params, checked. Values may still be markers. */
export interface ResourceSpec {
  api: string;
  vars: Record<string, unknown>;
  /** `locate`: the create's answer is not the object (the parent, an acknowledgement); find it afterwards. */
  create: RequestSpec & { idempotencyKey: boolean; locate: boolean };
  read?: { path: string; graphql?: GraphqlSpec };
  find?: FindSpec;
  update?: RequestSpec;
  /**
   * How the object is removed. A `POST` with a `body` archives instead of deleting (Stripe prices cannot be deleted,
   * only set `active: false`); the body is part of the record id, so destroy needs nothing but the ledger. Or a
   * GraphQL mutation.
   */
  delete: { method: string; path: string; body?: Record<string, unknown>; graphql?: GraphqlSpec };
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

/** Per-request headers: names Sponson does not set itself; values are checked once resolved (`requestHeaders`). */
function requestHeadersParam(v: unknown, param: string): Record<string, unknown> {
  const o = optionalObject(v, param) ?? {};
  for (const k of Object.keys(o)) {
    if (!HEADER_NAME.test(k)) throw fail(`\`${param}.${k}\` is not a header name`, `${param}.${k}`);
    if (/^(authorization|accept|content-type|idempotency-key)$/i.test(k)) throw fail(`\`${param}.${k}\` is set by Sponson or the API block`, `${param}.${k}`);
  }
  return o;
}

/** `{ graphql }` in place of a REST request: nothing else may be next to it. */
function asGraphql(o: Record<string, unknown>, param: string, idAllowed: boolean): RequestSpec | undefined {
  if (o.graphql === undefined) return undefined;
  const extra = Object.keys(o).find((k) => k !== "graphql");
  if (extra) throw fail(`\`${param}.${extra}\` does not apply to a GraphQL request (the query and its variables say everything)`, `${param}.${extra}`);
  return { method: "POST", path: "", body: {}, headers: {}, sendFields: true, graphql: parseGraphql(o.graphql, `${param}.graphql`, idAllowed) };
}

function parseRequest(v: unknown, param: string, methods: readonly string[], fallback: string, vars: Record<string, unknown>, idAllowed: boolean, defaultPath?: string): RequestSpec {
  const o = requiredObject(v, param);
  const gql = asGraphql(o, param, idAllowed);
  if (gql) return gql;
  const path = o.path === undefined && defaultPath !== undefined ? defaultPath : pathParam(o.path, `${param}.path`);
  checkPlaceholders(path, `${param}.path`, vars, idAllowed);
  const contentType = contentTypeParam(o.content_type, `${param}.content_type`);
  if (o.send_fields !== undefined && typeof o.send_fields !== "boolean") throw fail(`\`${param}.send_fields\` must be true or false`, `${param}.send_fields`);
  return {
    method: methodParam(o.method, `${param}.method`, methods, fallback),
    path,
    body: optionalObject(o.body, `${param}.body`) ?? {},
    ...(contentType ? { contentType } : {}),
    headers: requestHeadersParam(o.headers, `${param}.headers`),
    sendFields: o.send_fields !== false,
  };
}

/** A request's headers with their resolved values, as strings; PARAM_INVALID for a value that is not a scalar. */
export function requestHeaders(req: RequestSpec, param: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw fail(`\`${param}.headers.${k}\` must be a string, number or boolean`, `${param}.headers.${k}`);
    out[k] = String(v);
  }
  return out;
}

function parseCreate(v: unknown, vars: Record<string, unknown>): ResourceSpec["create"] {
  const r = parseRequest(v, "create", ["POST", "PUT", "PATCH"], "POST", vars, false);
  if (r.graphql) return { ...r, idempotencyKey: false, locate: false };
  const { idempotency_key: key, locate } = v as Record<string, unknown>;
  if (key !== undefined && typeof key !== "boolean") throw fail("`create.idempotency_key` must be true or false", "create.idempotency_key");
  if (locate !== undefined && typeof locate !== "boolean") throw fail("`create.locate` must be true or false", "create.locate");
  return { ...r, idempotencyKey: key === true, locate: locate === true };
}

function parseFind(v: unknown, vars: Record<string, unknown>): FindSpec | undefined {
  const o = optionalObject(v, "find");
  if (!o) return undefined;
  if (o.graphql !== undefined) return parseGraphqlFind(o);
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

/** A find whose list comes from a GraphQL query: no path, no cursor pages. */
function parseGraphqlFind(o: Record<string, unknown>): FindSpec {
  const extra = Object.keys(o).find((k) => !["graphql", "list_path", "match"].includes(k));
  if (extra) throw fail(`\`find.${extra}\` does not apply to a GraphQL find (known: graphql, list_path, match)`, `find.${extra}`);
  const match = requiredObject(o.match, "find.match");
  if (Object.keys(match).length === 0) throw fail("`find.match` must name at least one field", "find.match");
  return { path: "", graphql: parseGraphql(o.graphql, "find.graphql", false), listPath: pointerParam(o.list_path, "find.list_path", ""), match };
}

function parseRead(v: unknown, vars: Record<string, unknown>, find: FindSpec | undefined): { path: string; graphql?: GraphqlSpec } | undefined {
  const o = optionalObject(v, "read");
  if (!o) {
    if (!find) throw fail("needs `read` (a path or a GraphQL query that names the object) or `find` (a list and the fields that identify it)", "read");
    return undefined;
  }
  if (o.graphql !== undefined) {
    const gql = asGraphql(o, "read", true)!.graphql!;
    if (usesId(gql.variables) && !find) throw fail('`read.graphql.variables` uses "{id}", so the object can only be located with `find` (the id is not in the plan)', "read.graphql.variables");
    return { path: "", graphql: gql };
  }
  const path = pathParam(o.path, "read.path");
  if (placeholders(path).includes("id") && !find) throw fail("`read.path` uses `{id}`, so the object can only be located with `find` (the id is not in the plan)", "read.path");
  checkPlaceholders(path, "read.path", vars, true);
  return { path };
}

/** Update and delete go to the read path by default: the object's own URL. */
function parseDelete(v: unknown, vars: Record<string, unknown>, read: { path: string; graphql?: GraphqlSpec } | undefined): ResourceSpec["delete"] {
  if (v === undefined && (read === undefined || read.graphql)) throw fail("`delete` is required: `{ path: /things/{id} }` or `{ graphql: { query: … } }` (no `read.path` to default to)", "delete");
  const r = parseRequest(v ?? {}, "delete", ["DELETE", "POST"], "DELETE", vars, true, read?.graphql ? undefined : read?.path);
  if (r.graphql) return { method: r.method, path: r.path, graphql: r.graphql };
  if (Object.keys(r.body).length === 0) return { method: r.method, path: r.path };
  if (r.method !== "POST") throw fail("`delete.body` needs `method: POST` (an archive request such as `{ active: false }`)", "delete.body");
  // The body travels in the record id, which the ledger keeps: plain values only, never a reference or a secret.
  if (firstMarker(r.body) !== undefined || JSON.stringify(r.body).includes("${")) throw fail("`delete.body` must hold literal values only", "delete.body");
  return { method: r.method, path: r.path, body: r.body };
}

function parseOutputs(v: unknown): Record<string, OutputDecl> {
  const o = optionalObject(v, "outputs") ?? {};
  const out: Record<string, OutputDecl> = {};
  for (const [name, decl] of Object.entries(o)) {
    const param = `outputs.${name}`;
    if (name === "id") throw fail("`outputs.id` is reserved: the object's id is always the output `id`", param);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(`output name \`${name}\` must be letters, digits and _`, param);
    if (typeof decl === "string") out[name] = { path: pointerParam(decl, param, ""), sensitive: false, once: false };
    else if (isObject(decl)) out[name] = outputDecl(decl, param);
    else throw fail(`\`${param}\` must be a JSON pointer, or \`{ path, sensitive: true, once?: true }\``, param);
  }
  return out;
}

/** `{ path, sensitive?, once? }`. A value shown only at creation is a credential, so `once` requires `sensitive`. */
function outputDecl(decl: Record<string, unknown>, param: string): OutputDecl {
  for (const flag of ["sensitive", "once"]) {
    if (decl[flag] !== undefined && typeof decl[flag] !== "boolean") throw fail(`\`${param}.${flag}\` must be true or false`, `${param}.${flag}`);
  }
  if (decl.once === true && decl.sensitive !== true) throw fail(`\`${param}\` is \`once\` (shown only when the object is created), so it must be \`sensitive: true\` too`, `${param}.sensitive`);
  return { path: pointerParam(decl.path, `${param}.path`, ""), sensitive: decl.sensitive === true, once: decl.once === true };
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
  if (params.update !== undefined) spec.update = parseRequest(params.update, "update", ["PATCH", "PUT", "POST"], "PATCH", vars, true, read?.graphql ? undefined : read?.path);
  noSecretIn(find?.graphql?.variables, "find.graphql.variables");
  noSecretIn(read?.graphql?.variables, "read.graphql.variables");
  noSecretIn(spec.delete.graphql?.variables, "delete.graphql.variables");
  return spec;
}

/**
 * The variables of a locating or deleting GraphQL request become part of the resource key or the record id, which
 * receipts keep: a `{ secret }` there is refused (it would be masked, and the key or the delete broken).
 */
function noSecretIn(v: unknown, param: string): void {
  if (v !== undefined && firstSecret(v)) throw fail(`\`${param}\` may not hold a \`{ secret }\`: it becomes part of the resource key or the delete request kept in receipts`, param);
}

function firstSecret(v: unknown): boolean {
  if (markerKind(v) === "secret") return true;
  if (Array.isArray(v)) return v.some(firstSecret);
  return isObject(v) && Object.values(v).some(firstSecret);
}

/** The outputs one `http.resource` line declares: always `id`, plus its `outputs` (`once` ones as in ADR 0018). */
export function resourceOutputs(line: Record<string, unknown>): Record<string, OutputSpec> {
  const params = expandRecipe(line, "resource");
  const out: Record<string, OutputSpec> = { id: { available: "immediate" } };
  for (const [name, d] of Object.entries(parseOutputs(params.outputs))) out[name] = { available: "immediate", ...(d.sensitive ? { sensitive: true } : {}), ...(d.once ? { once: true } : {}) };
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

/**
 * What a write of the parent sends besides the collection: nothing (`field`; a keyed map's one entry, as a merge
 * patch), nothing but the whole collection (`collection`; a keyed map too, for an API that replaces the map it is
 * sent), the whole object read just before (`parent`), or the listed fields of it (names or pointers), for a
 * replace that resets what it is not sent.
 */
export type ParentSend = "field" | "parent" | "collection" | string[];

/** `http.list_item` params, checked. */
export interface ListItemSpec {
  api: string;
  vars: Record<string, unknown>;
  /**
   * `itemPath`: where the parent object is in the read answer (`/feature` for `{ feature: {...} }`); default the whole
   * body. `ifMissing: empty`: a 404 parent reads as an empty collection; `whenEmpty: delete`: an empty collection is
   * removed with DELETE instead of written. `readMethod: POST`: the parent is read with a POST without a body (an
   * Azure Resource Manager list action such as `listAppSettings`), which changes nothing. `writeListPath`: where a
   * write puts the collection, when the API names it otherwise than its read (Kinde reads `{ redirect_urls }` and replaces with `{ urls }`); default `list_path`.
   */
  parent: { path: string; readPath: string; readMethod: "GET" | "POST"; method: string; send: ParentSend; itemPath: string; contentType?: string; ifMissing: "error" | "empty"; whenEmpty: "write" | "delete"; writeListPath?: string };
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
  const ifMissing = oneOf(o.if_missing, ["error", "empty"] as const, "parent.if_missing", "`error` (the default: a parent that is not there is an error) or `empty` (a 404 reads as an empty collection, S3 CORS)");
  const whenEmpty = oneOf(o.when_empty, ["write", "delete"] as const, "parent.when_empty", "`write` (the default: write the empty collection) or `delete` (DELETE `parent.path` instead, S3 CORS)");
  const contentType = contentTypeParam(o.content_type, "parent.content_type");
  const writeListPath = o.write_list_path === undefined ? undefined : pointerParam(o.write_list_path, "parent.write_list_path", "");
  return {
    path,
    readPath,
    readMethod: methodParam(o.read_method, "parent.read_method", ["GET", "POST"], "GET") as "GET" | "POST",
    method: methodParam(o.method, "parent.method", ["PATCH", "PUT", "POST"], "PATCH"),
    send: parseSend(o.send),
    itemPath: pointerParam(o.item_path, "parent.item_path", ""),
    ifMissing,
    whenEmpty,
    ...(contentType ? { contentType } : {}),
    ...(writeListPath !== undefined ? { writeListPath } : {}),
  };
}

/** One of `allowed` (the first when absent); PARAM_INVALID saying what each means otherwise. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], param: string, meaning: string): T {
  if (v === undefined) return allowed[0]!;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw fail(`\`${param}\` must be ${meaning}`, param);
}

function parseSend(v: unknown): ParentSend {
  if (v === undefined || v === "field" || v === "parent" || v === "collection") return v ?? "field";
  if (Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === "string" && f !== "")) return v as string[];
  throw fail("`parent.send` must be `field` (send only the list; a map entry as a merge patch), `collection` (send only the list, a map whole), `parent` (send the whole object back) or a list of the object's fields to send back with it", "parent.send");
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
