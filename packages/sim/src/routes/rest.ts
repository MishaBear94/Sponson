/**
 * Simulated generic REST API: the provider the `http` adapter (packages/adapters/src/http-adapter*.ts) and its
 * recipes (packages/adapters/recipes/) are tested against. It models no particular SaaS. Any path can hold one of
 * two things, so a plan written for a real API (`/gates`, `/clients/abc123`) can be planned and applied against it
 * once its collections and objects are seeded:
 *
 *   - a collection of objects with ids: `<path>` lists and creates, `<path>/<id>` reads, updates, deletes;
 *   - an object (a parent holding lists, maps or delimited strings, such as an application with its allowed
 *     origins, or a map of config vars): `<path>` reads, updates (PATCH, PUT, POST), deletes.
 *
 * Assumptions it encodes (about "a conventional JSON REST API", not about one provider; every real API the adapter
 * is pointed at is described by its plan line or recipe instead, see docs/api-verification.md):
 *   R1. Credentials arrive as `Authorization: Bearer <token>`, `Authorization: Basic <base64>`, a bare token in
 *       `Authorization` (`Authorization: <token>`, as Unleash takes it), a header whose name ends in `-api-key`,
 *       `-key` or `-token` (`X-Api-Key`, `Statsig-Api-Key`, `X-Auth-Token`), or one the seed declares in
 *       `auth_headers` (`X-Honeycomb-Team`); anything else is 401.
 *   R2. Collection objects are answered in a `{ data: <object> }` envelope, lists as `{ data: [...], next_cursor }`,
 *       paged with `?cursor=` under chaos `page_size` (`next_cursor` is null on the last page). Objects that are
 *       not in a collection are answered bare. A collection's style (seed `styles`, by collection path) changes the
 *       envelopes, the cursor's place, and the id's field and type, so that a recipe is tested in its provider's
 *       own response shapes. An object's style (by its path) may give it an `item_path` envelope for reads; writes
 *       go to the object itself, and its `write_fields` store a written field under another name (an API that
 *       reads `{ redirect_urls }` and replaces it with `{ urls }`). A create may be posted to another path than the
 *       collection's (seed `aliases`: `POST /gates/g/rule` adds to `/gates/g/rules`).
 *   R3. A path is known once seeded or created: a POST to an unknown path creates the collection; a GET of an
 *       unknown path is 404. A create may choose the id (the id field, or the style's `id_from` field, in the
 *       body, like a flag key or a database name); otherwise the sim assigns `it_<n>` (the next integer with
 *       `numeric_ids`). A create whose `name` (or chosen id) already exists in the collection answers 409. Query
 *       parameters other than `cursor` are ignored: a filtered list answers the whole collection. A trailing slash
 *       is ignored (`/releases/` is `/releases`). An alias (R2) names its collection for every method, so it also
 *       serves a provider that lists at another URL than it creates at (`GET /settings/all` lists `/settings`).
 *       An alias of a collection also addresses its objects (`/databases/<id>` when `/databases` aliases
 *       `/projects/p/databases`). With the style's `header_fields`, a create also stores those request headers as
 *       fields; with its `suffix_field`, a POST to `<collection>/<suffix>` creates the object with the suffix in that
 *       field, or updates the one whose id the request chooses (QStash's schedule upsert). A PUT to
 *       `<collection>/<id>` that does not exist creates the object with that id (an upsert at a client-chosen key,
 *       such as an environment variable by name), answering 200.
 *       A style's `item_query` names an object by a query parameter (`<collection>?url=<id>` is the object whose
 *       id is `<id>`, for APIs that key objects by a value such as a URL).
 *   R4. PATCH (and POST to an object, or to an object of a collection, as Stripe updates) is a JSON merge patch
 *       (RFC 7396: maps merge recursively, `null` deletes a field, lists are replaced whole); PUT replaces
 *       everything but a collection object's id. Bodies may be JSON or form-encoded (`a[b]=c`, every value a
 *       string; with the style's `form_types`, `true`/`false` and numbers are read as such, as an API with a typed
 *       schema does). No write has a precondition (no ETag): the last write wins.
 *   R6. A style's `once_fields` are generated on create (`<field>_sim_<n>`) and appear only in the create's answer,
 *       never stored or listed: a webhook endpoint's signing secret.
 *   R5. DELETE answers `{ id, deleted: true }`; anything unknown is 404 `{ error }`.
 *   R7. With an `auth` seed, credentials are checked for real instead of R1, one scheme or several: bearer tokens
 *       issued by the OAuth2 client-credentials endpoint `POST /rest/oauth/token` (RFC 6749 §4.4; Basic or form
 *       client authentication; tokens expire after `token_ttl` seconds and the drift key `auth.revoke_tokens`
 *       revokes them), fixed bearer tokens (`tokens`, what a CLI prints), exact header values (`headers`, a key
 *       behind a scheme prefix such as `Authorization: Api-Key <key>`), HTTP Digest (RFC 7616, qop=auth; a
 *       request without valid credentials gets a 401 with a fresh challenge), and AWS SigV4 (the signature
 *       recomputed and compared; see ../auth.ts). Anything else is 401.
 *   R8. A path the seed lists in `reads` is a read sent as a POST (an Azure Resource Manager list action such as
 *       `…/listAppSettings`): it answers the object it names, as a GET of that object would, and is not a write.
 *   R9. A seeded endpoint (seed `endpoints`, by path) stands for a one-off action's target (an app's sync URL, a
 *       purge or notification endpoint): it answers every method with its fixed status and reply (default 200
 *       `{}`), keeps nothing but a log of the calls (`calls`: method, path, headers, body), and with `public: true`
 *       answers without a credential, as an app's own endpoint does.
 */
import type { IncomingHttpHeaders } from "node:http";
import { digestChallenge, digestProblem, issueToken, sigV4Problem, tokenValid, type DigestConfig, type IssuedToken, type SigV4Config } from "../auth.js";
import { page, Reply, route, router, type AuthRequest, type ProviderSim, type SimCore } from "../provider.js";

/** One object of a collection, as stored and answered: its id (under the style's id field) and every field a client wrote. */
export type RestItem = Record<string, unknown>;

/**
 * How one collection answers (assumption R2). Every member is optional; the defaults are the conventional shape:
 * `{ data: <object> }`, `{ data: [...], next_cursor }`, string ids under `id`.
 */
export interface RestStyle {
  /** JSON pointer where a list answer holds the array. Default `/data`; `""` answers the bare array. */
  list_path?: string;
  /** JSON pointer where a single-object answer holds the object. Default `/data`; `""` answers it bare. */
  item_path?: string;
  /** JSON pointer of the next page's cursor in a list answer. Default `/next_cursor`; null: no cursor and no paging. */
  next_path?: string | null;
  /** The field holding the id. Default `id`. */
  id_field?: string;
  /** The body field a create may choose the id with. Default: the id field. */
  id_from?: string;
  /** Assign integer ids instead of `it_<n>`. */
  numeric_ids?: boolean;
  /** Read form-encoded `true`/`false` and numbers as booleans and numbers (assumption R4). */
  form_types?: boolean;
  /** Fields generated on create and shown only in its answer (assumption R6). */
  once_fields?: string[];
  /** A query parameter that names an object of the collection by id (`url`), assumption R3. */
  item_query?: string;
  /** For an object: top-level fields a write names otherwise than a read, written name → stored name (R2). */
  write_fields?: Record<string, string>;
  /**
   * Request headers (lower-case names) whose values a create or update stores as fields, for an API that takes an
   * object's settings in headers (QStash: `upstash-cron` → `cron`, `upstash-schedule-id` → `scheduleId`).
   */
  header_fields?: Record<string, string>;
  /**
   * A POST to `<collection>/<suffix>` creates the object with the suffix (a URL, kept as written) in this field, or
   * updates the one whose id the request chooses (an upsert): QStash's `POST /v2/schedules/<destination>`.
   */
  suffix_field?: string;
}

/** A one-off action's endpoint (assumption R9): a fixed answer to every method, and whether it needs a credential. */
export interface RestEndpoint {
  /** Default 200. */
  status?: number;
  /** Default `{}`. */
  reply?: unknown;
  /** Answers without a credential (an app's own endpoint). */
  public?: boolean;
}

/** One call to a seeded endpoint (R9), as received. */
export interface RestCall {
  method: string;
  path: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: unknown;
}

/** Simulated REST API state, by path: collections of objects, objects that are not in a collection, and styles. */
export interface RestState {
  collections: Record<string, RestItem[]>;
  objects: Record<string, Record<string, unknown>>;
  styles: Record<string, RestStyle>;
  /** Paths that name a collection kept under another path, by path: a create posted elsewhere
   * (`/gates/g/rule` adds to `/gates/g/rules`), or a list at another URL (`/settings/all` lists `/settings`). */
  aliases: Record<string, string>;
  /** Further header names (lower-case) that carry a credential (assumption R1). */
  auth_headers: string[];
  /** Paths read with a POST, by path: the object each answers (assumption R8). */
  reads: Record<string, string>;
  /** Present when the seed configures real credentials (R7). */
  auth?: RestAuthState;
  /** One-off action endpoints by path (R9), and every call they received. */
  endpoints: Record<string, RestEndpoint>;
  calls: RestCall[];
}

/**
 * Real credentials for the REST sim (R7). Each key enables one scheme; with none of them, R1 applies (any
 * non-empty credential).
 */
export interface RestAuthSeed {
  /** OAuth2 clients the token endpoint accepts: client id → client secret. */
  clients?: Record<string, string>;
  /** Lifetime of the tokens it issues, in seconds (default 3600). */
  token_ttl?: number;
  /** Bearer tokens accepted as they are (the token a CLI such as `gcloud auth print-access-token` prints). */
  tokens?: string[];
  /**
   * Accepted sets of header values (lower-case name → exact value), each complete on its own: a key behind a scheme
   * prefix (`Api-Key <key>`), or an API key together with an application key.
   */
  headers?: Array<Record<string, string>>;
  /** Digest users (name → password), the algorithm (`MD5` by default) and the realm. */
  digest?: DigestConfig;
  /** SigV4 access keys (id → secret) and the region and service requests must be signed for. */
  sigv4?: Omit<SigV4Config, "now">;
}

/** The REST sim's credential state: what was seeded, every token issued and every Digest nonce handed out. */
export interface RestAuthState extends RestAuthSeed {
  issued: IssuedToken[];
  nonces: string[];
  /** Requests answered 401, for assertions ("the expired token was refused once"). */
  refused: number;
}

/** Initial REST state, by path: objects per collection (ids assigned when absent), stand-alone objects, styles. */
export interface RestSeed {
  collections?: Record<string, Array<Record<string, unknown>>>;
  objects?: Record<string, Record<string, unknown>>;
  /** How each collection answers, by collection path (assumption R2). */
  styles?: Record<string, RestStyle>;
  /** Paths that name a collection kept under another path, by path: `{ "/gates/g/rule": "/gates/g/rules" }`. */
  aliases?: Record<string, string>;
  /** Further header names that carry a credential, for an API whose header is not named `*-Key` or `*-Token`. */
  auth_headers?: string[];
  /** Paths read with a POST (an ARM list action), by path: the object each answers (assumption R8). */
  reads?: Record<string, string>;
  /** Real credentials (R7). */
  auth?: RestAuthSeed;
  /** One-off action endpoints by path (R9). */
  endpoints?: Record<string, RestEndpoint>;
}

/** Simulated generic REST API; see the assumptions at the top of this file. */
export const restSim: ProviderSim<RestState, RestSeed> = {
  env: { token: "REST_API_TOKEN", url: "REST_API_URL", testToken: "tok_rest" },
  defaultSeed: {
    collections: { "/gates": [], "/flags": [], "/hooks": [] },
    objects: { "/apps/demo": { name: "demo app", allowed_origins: [], rules: [], uri_allow_list: "", env_vars: {} } },
  },

  reset(core, seed) {
    const state = emptyState(seed ?? {});
    for (const [path, items] of Object.entries(byPath(seed?.collections ?? {}))) {
      const field = styleOf(state, path).id_field;
      state.collections[path] = items.map((i) => ({ ...structuredClone(i), [field]: isId(i[field]) ? i[field] : newId(core, state, path) }));
    }
    if (seed?.auth) state.auth = { ...structuredClone(seed.auth), issued: [], nonces: [], refused: 0 };
    return state;
  },

  /**
   * `items.<collection path>.<id or name>`: "delete" | "recreate" (same fields, new id);
   * `items.<collection path>.<id or name>.<field>`: a new value (JSON when it parses, else the string);
   * `objects.<path>.<field>`: "add:<v>" / "remove:<v>" on a list of strings, else a new value as above.
   * Paths are written as they are (`items./gates.checkout.enabled`); they must not contain dots.
   */
  drift(core, state, { key, rest, value, only }) {
    if (only !== undefined) return false;
    if (rest === "auth.revoke_tokens") {
      if (!state.auth) throw new Error(`drift ${key}: the rest sim has no auth seed`);
      for (const t of state.auth.issued) t.revoked = true;
      return true;
    }
    const [kind, path, b, ...more] = rest.split(".");
    if (kind === "items" && path && b) return driftItem(core, state, path, b, more.join("."), value, key);
    if (kind === "objects" && path && b && more.length === 0) return driftObject(state, path, b, value, key);
    return false;
  },

  isWrite(req, state) {
    return !(req.method === "POST" && (req.path === "/oauth/token" || normPath(req.path) in state.reads));
  },

  authorized(headers, state, req) {
    if (state.endpoints[normPath(req.url.pathname.replace(/^\/rest(?=\/)/, ""))]?.public) return true;
    if (!state.auth) return authorized(headers, state.auth_headers);
    // The token endpoint authenticates the client itself.
    if (req.method === "POST" && req.url.pathname === "/rest/oauth/token") return true;
    if (strictlyAuthorized(headers, req, state.auth)) return true;
    state.auth.refused += 1;
    return state.auth.digest ? digestChallenge(state.auth.digest, state.auth, state.auth.nonces.length + 1) : false;
  },

  routes(core, state, req) {
    const endpoint = state.endpoints[normPath(req.path)];
    if (!endpoint) return routes(core, state, req);
    state.calls.push({ method: req.method, path: normPath(req.path), headers: { ...(req.headers ?? {}) }, body: structuredClone(req.body) });
    return new Reply(endpoint.status ?? 200, structuredClone(endpoint.reply ?? {}));
  },
};

/** The state a seed describes, before its collections get their ids. */
function emptyState(seed: RestSeed): RestState {
  return {
    collections: {},
    objects: byPath(structuredClone(seed.objects ?? {})),
    styles: byPath(structuredClone(seed.styles ?? {})),
    aliases: pathPairs(seed.aliases),
    auth_headers: (seed.auth_headers ?? []).map((h) => h.toLowerCase()),
    reads: pathPairs(seed.reads),
    endpoints: byPath(structuredClone(seed.endpoints ?? {})),
    calls: [],
  };
}

/** R7: the request carries one of the credentials the seed configures, valid. */
function strictlyAuthorized(headers: IncomingHttpHeaders, req: AuthRequest, auth: RestAuthState): boolean {
  const sets = (auth.headers ?? []).map((set) => Object.entries(set));
  if (sets.some((set) => set.length > 0 && set.every(([name, v]) => headers[name] === v))) return true;
  const value = headers.authorization ?? "";
  const bearer = /^Bearer\s+(\S+)$/.exec(value)?.[1];
  if (bearer !== undefined) return (auth.tokens ?? []).includes(bearer) || tokenValid({ clients: auth.clients ?? {}, ttlSeconds: 0, issued: auth.issued }, bearer);
  if (/^Digest\s/i.test(value) && auth.digest) return digestProblem(headers, req, auth.digest, auth) === null;
  if (value.startsWith("AWS4-HMAC-SHA256") && auth.sigv4) return sigV4Problem(headers, req, auth.sigv4) === null;
  return false;
}

function authorized(headers: IncomingHttpHeaders, declared: string[]): boolean {
  const a = headers.authorization ?? "";
  if (/^(Bearer|Basic)\s+\S+$/.test(a) || (/^\S+$/.test(a) && !/^(Bearer|Basic)$/i.test(a))) return true;
  const carries = (name: string) => /(^|-)(api-key|key|token)$/.test(name) || declared.includes(name);
  return Object.entries(headers).some(([name, v]) => carries(name) && typeof v === "string" && v.trim() !== "");
}

type FullStyle = Required<Omit<RestStyle, "next_path" | "item_query" | "header_fields" | "suffix_field" | "write_fields">> & Pick<RestStyle, "item_query"> & { next_path: string | null };

/** The style of the collection at `path`, every default filled in. */
function styleOf(state: RestState, path: string): FullStyle {
  const s = state.styles[path] ?? {};
  const id = s.id_field ?? "id";
  return {
    list_path: s.list_path ?? "/data",
    item_path: s.item_path ?? "/data",
    next_path: s.next_path === undefined ? "/next_cursor" : s.next_path,
    id_field: id,
    id_from: s.id_from ?? id,
    numeric_ids: s.numeric_ids ?? false,
    form_types: s.form_types ?? false,
    once_fields: s.once_fields ?? [],
    ...(s.item_query ? { item_query: s.item_query } : {}),
  };
}

/** A form body's values typed (assumption R4): `true`/`false` and numerals become booleans and numbers. */
function typedForm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(typedForm);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typedForm(x)]));
  if (v === "true" || v === "false") return v === "true";
  return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

/** The body as the collection at `path` reads it. */
function bodyFor(state: RestState, path: string, body: unknown, headers: Record<string, string>): unknown {
  const form = (headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded");
  return form && styleOf(state, path).form_types ? typedForm(body) : body;
}

function isId(v: unknown): v is string | number {
  return (typeof v === "string" && v !== "") || typeof v === "number";
}

/** A fresh id for the collection at `path`: `it_<n>`, or an integer with `numeric_ids`. */
function newId(core: SimCore, state: RestState, path: string): string | number {
  const id = core.nextId("it_");
  return styleOf(state, path).numeric_ids ? Number(id.slice(3)) : id;
}

/** `value` placed at the JSON pointer `pointer` of an otherwise empty object (`""`: the value itself). */
function envelope(pointer: string, value: unknown): unknown {
  if (pointer === "") return value;
  const tokens = pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  return tokens.reduceRight<unknown>((v, token) => ({ [token]: v }), value);
}

/** A list answer, with its cursor when the style has one. */
function listBody(style: FullStyle, items: RestItem[], next: number | null): unknown {
  const list = envelope(style.list_path, items);
  if (style.next_path === null || !isRecord(list)) return list;
  return mergeInto(list, envelope(style.next_path, next === null ? null : String(next)));
}

function mergeInto(a: Record<string, unknown>, b: unknown): Record<string, unknown> {
  if (!isRecord(b)) return a;
  for (const [k, v] of Object.entries(b)) a[k] = isRecord(v) && isRecord(a[k]) ? mergeInto(a[k], v) : v;
  return a;
}

function driftItem(core: SimCore, state: RestState, coll: string, which: string, field: string, value: string, key: string): boolean {
  const list = state.collections[coll] ?? [];
  const idf = styleOf(state, coll).id_field;
  const item = list.find((i) => String(i[idf]) === which || i.name === which);
  if (!item) throw new Error(`drift ${key}: no item ${which} in ${coll}`);
  if (field) {
    item[field] = parseValue(value);
    return true;
  }
  if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported without a field`);
  const rest = list.filter((i) => i !== item);
  if (value === "recreate") rest.push({ ...item, [idf]: newId(core, state, coll) });
  state.collections[coll] = rest;
  return true;
}

function driftObject(state: RestState, path: string, field: string, value: string, key: string): boolean {
  const o = state.objects[path];
  if (!o) throw new Error(`drift ${key}: no object at ${path}`);
  const m = /^(add|remove):(.*)$/.exec(value);
  if (!m) {
    o[field] = parseValue(value);
    return true;
  }
  const list = Array.isArray(o[field]) ? (o[field] as unknown[]) : [];
  o[field] = m[1] === "add" ? [...list, m[2]] : list.filter((x) => x !== m[2]);
  return true;
}

function parseValue(v: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** A path without its trailing slash (`/releases/` and `/releases` name the same thing, assumption R3). */
function normPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** A seed map of path to path, both normalised. */
function pathPairs(m: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(m ?? {}).map(([a, p]) => [normPath(a), normPath(p)]));
}

/** A seed map keyed by normalised paths. */
function byPath<T>(m: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(m).map(([p, v]) => [normPath(p), v]));
}

/** What a path names in the state. */
type Target =
  | { kind: "object"; path: string; object: Record<string, unknown> }
  | { kind: "collection"; path: string; items: RestItem[] }
  | { kind: "item"; collection: string; index: number; item: RestItem }
  | { kind: "none" };

/** The collection stored at `path`, or the one an alias there names (R2). */
function collectionAt(state: RestState, path: string): string | undefined {
  if (state.collections[path]) return path;
  const alias = state.aliases[path];
  return alias !== undefined && state.collections[alias] ? alias : undefined;
}

function resolve(state: RestState, raw: string, query?: URLSearchParams): Target {
  const path = state.aliases[normPath(raw)] ?? normPath(raw);
  const object = state.objects[path];
  if (object) return { kind: "object", path, object };
  const items = state.collections[path];
  if (items) return queriedItem(state, path, query) ?? { kind: "collection", path, items };
  const cut = path.lastIndexOf("/");
  const collection = collectionAt(state, path.slice(0, cut)) ?? path.slice(0, cut);
  return itemTarget(state, collection, decodeURIComponent(path.slice(cut + 1)));
}

function itemTarget(state: RestState, collection: string, id: string): Target {
  const idf = styleOf(state, collection).id_field;
  const index = (state.collections[collection] ?? []).findIndex((i) => String(i[idf]) === id);
  return index >= 0 ? { kind: "item", collection, index, item: state.collections[collection]![index]! } : { kind: "none" };
}

/** `<collection>?<item_query>=<id>`: the object it names, when the collection's style has `item_query`. */
function queriedItem(state: RestState, path: string, query: URLSearchParams | undefined): Target | undefined {
  const param = styleOf(state, path).item_query;
  const id = param ? query?.get(param) : null;
  return id === null || id === undefined ? undefined : itemTarget(state, path, id);
}

const notFound = (): Reply => error(404, "not found");

/** R8: the object a read sent as a POST names, answered as a GET of it would be. */
function readObject(state: RestState, path: string): Reply {
  const object = state.objects[path];
  return object ? new Reply(200, envelope(state.styles[path]?.item_path ?? "", object)) : notFound();
}

/** The fields the request's headers set, by the collection's `header_fields`. */
function headerFields(state: RestState, collection: string, headers: Record<string, string>): Record<string, unknown> {
  const map = state.styles[collection]?.header_fields ?? {};
  return Object.fromEntries(Object.entries(map).flatMap(([h, f]) => (headers[h.toLowerCase()] === undefined ? [] : [[f, headers[h.toLowerCase()]]])));
}

/** The collection with a `suffix_field` that `path` is under, and the suffix. */
function suffixTarget(state: RestState, path: string): { collection: string; suffix: string } | undefined {
  const collection = Object.keys(state.collections).find((c) => state.styles[c]?.suffix_field !== undefined && path.startsWith(`${c}/`));
  return collection === undefined ? undefined : { collection, suffix: path.slice(collection.length + 1) };
}

/** POST `<collection>/<suffix>`: create, or update the object whose id the request chooses (R3, `suffix_field`). */
function upsertAt(core: SimCore, state: RestState, at: { collection: string; suffix: string }, body: unknown, headers: Record<string, string>): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  const style = styleOf(state, at.collection);
  const fields = { ...structuredClone(body), ...headerFields(state, at.collection, headers), [state.styles[at.collection]!.suffix_field!]: at.suffix };
  const list = state.collections[at.collection]!;
  const chosen = isId(fields[style.id_from]) ? fields[style.id_from] : undefined;
  const index = chosen === undefined ? -1 : list.findIndex((i) => i[style.id_field] === chosen);
  const item: RestItem = { ...(index >= 0 ? list[index] : {}), ...fields, [style.id_field]: chosen ?? newId(core, state, at.collection) };
  if (index >= 0) list[index] = item;
  else list.push(item);
  return new Reply(200, envelope(style.item_path, item));
}

function create(core: SimCore, state: RestState, path: string, raw: unknown, headers: Record<string, string> = {}): Reply {
  if (!isRecord(raw)) return error(400, "body must be a JSON object");
  const body = { ...raw, ...headerFields(state, path, headers) };
  const list = (state.collections[path] ??= []);
  const style = styleOf(state, path);
  const chosen = isId(body[style.id_from]) ? body[style.id_from] : undefined;
  const clash = list.find((i) => (chosen !== undefined && i[style.id_field] === chosen) || (body.name !== undefined && i.name === body.name));
  if (clash) return error(409, `already exists: ${String(clash[style.id_field])}`);
  const item: RestItem = { ...structuredClone(body), [style.id_field]: chosen ?? newId(core, state, path) };
  list.push(item);
  // Fields shown once (assumption R6): in this answer only, never stored.
  const shown = Object.fromEntries(style.once_fields.map((f) => [f, `${f}_sim_${core.nextId("")}`]));
  return new Reply(201, envelope(style.item_path, { ...item, ...shown }));
}

/** A write to the object at `path` with its style's `write_fields` stored under their read names (R2). */
function renamed(state: RestState, path: string, body: Record<string, unknown>): Record<string, unknown> {
  const names = state.styles[path]?.write_fields ?? {};
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [names[k] ?? k, v]));
}

function patch(state: RestState, t: Target, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  if (t.kind === "object") {
    mergePatch(t.object, renamed(state, t.path, body));
    return new Reply(200, t.object);
  }
  if (t.kind !== "item") return notFound();
  const style = styleOf(state, t.collection);
  const id = t.item[style.id_field];
  mergePatch(t.item, body);
  t.item[style.id_field] = id;
  return new Reply(200, envelope(style.item_path, t.item));
}

/** A PUT to `<collection>/<id>` that names no item: an upsert at a client-chosen key creates it (R3). */
function putNew(state: RestState, raw: string, body: Record<string, unknown>): Reply {
  const path = normPath(raw);
  const cut = path.lastIndexOf("/");
  const at = cut < 0 ? undefined : collectionAt(state, path.slice(0, cut));
  if (!at) return notFound();
  const style = styleOf(state, at);
  const id = decodeURIComponent(path.slice(cut + 1));
  const item: RestItem = { ...structuredClone(body), [style.id_field]: style.numeric_ids && /^\d+$/.test(id) ? Number(id) : id };
  state.collections[at]!.push(item);
  return new Reply(200, envelope(style.item_path, item));
}

function put(state: RestState, t: Target, body: unknown, raw: string): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  if (t.kind === "none") return putNew(state, raw, body);
  if (t.kind === "object") {
    state.objects[t.path] = structuredClone(renamed(state, t.path, body));
    return new Reply(200, state.objects[t.path]);
  }
  if (t.kind !== "item") return notFound();
  const style = styleOf(state, t.collection);
  const next: RestItem = { ...structuredClone(body), [style.id_field]: t.item[style.id_field] };
  state.collections[t.collection]![t.index] = next;
  return new Reply(200, envelope(style.item_path, next));
}

function list(core: SimCore, state: RestState, t: Extract<Target, { kind: "collection" }>, cursor: string | null): Reply {
  const style = styleOf(state, t.path);
  const pg = style.next_path === null ? { items: t.items, next: null } : page(core, t.items, cursor);
  return new Reply(200, listBody(style, pg.items, pg.next));
}

const routes = router<RestState>(
  [
    route("POST", "/oauth/token", ({ state, headers, body }) => {
      if (!state.auth?.clients) return error(404, "no token endpoint: the rest sim's auth seed configures no OAuth2 clients");
      const issued = { clients: state.auth.clients, ttlSeconds: state.auth.token_ttl ?? 3600, issued: state.auth.issued };
      return issueToken(issued, headers, body);
    }),

    route("GET", "/*path", ({ core, state, params, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      if (t.kind === "object") return new Reply(200, envelope(state.styles[t.path]?.item_path ?? "", t.object));
      if (t.kind === "item") return new Reply(200, envelope(styleOf(state, t.collection).item_path, t.item));
      if (t.kind === "none") return notFound();
      return list(core, state, t, url.searchParams.get("cursor"));
    }),

    route("POST", "/*path", ({ core, state, params, body, headers }) => {
      const read = state.reads[normPath(`/${params.path}`)];
      if (read !== undefined) return readObject(state, read);
      const suffix = suffixTarget(state, normPath(`/${params.path}`));
      if (suffix) return upsertAt(core, state, suffix, body, headers);
      const t = resolve(state, `/${params.path}`);
      if (t.kind === "object") return patch(state, t, body);
      if (t.kind === "item") return patch(state, t, bodyFor(state, t.collection, body, headers));
      const raw = normPath(`/${params.path}`);
      const path = t.kind === "collection" ? t.path : (state.aliases[raw] ?? raw);
      return create(core, state, path, bodyFor(state, path, body, headers), headers);
    }),

    route("PATCH", "/*path", ({ state, params, body, headers, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      return patch(state, t, t.kind === "item" ? bodyFor(state, t.collection, body, headers) : body);
    }),

    route("PUT", "/*path", ({ state, params, body, headers, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      return put(state, t, t.kind === "item" ? bodyFor(state, t.collection, body, headers) : body, `/${params.path}`);
    }),

    route("DELETE", "/*path", ({ state, params, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      if (t.kind === "item") {
        state.collections[t.collection]!.splice(t.index, 1);
        return new Reply(200, { id: t.item[styleOf(state, t.collection).id_field], deleted: true });
      }
      if (t.kind !== "object") return notFound();
      delete state.objects[t.path];
      return new Reply(200, { id: t.path, deleted: true });
    }),
  ],
  notFound,
);

/** RFC 7396 merge patch of `target` in place: maps merge recursively, `null` deletes, anything else replaces. */
function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (isRecord(v) && isRecord(target[k])) mergePatch(target[k], v);
    else target[k] = structuredClone(v);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function error(status: number, message: string): Reply {
  return new Reply(status, { error: message });
}
