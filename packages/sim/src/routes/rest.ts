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
 *   R1. Credentials arrive as `Authorization: Bearer <token>`, `Authorization: Basic <base64>` or a header whose
 *       name ends in `-api-key`, `-key` or `-token` (`X-Api-Key`, `Statsig-Api-Key`, `X-Auth-Token`); anything
 *       else is 401.
 *   R2. Collection objects are answered in a `{ data: <object> }` envelope, lists as `{ data: [...], next_cursor }`,
 *       paged with `?cursor=` under chaos `page_size` (`next_cursor` is null on the last page). Objects that are
 *       not in a collection are answered bare. A collection's style (seed `styles`, by collection path) changes the
 *       envelopes, the cursor's place, and the id's field and type, so that a recipe is tested in its provider's
 *       own response shapes.
 *   R3. A path is known once seeded or created: a POST to an unknown path creates the collection; a GET of an
 *       unknown path is 404. A create may choose the id (the id field, or the style's `id_from` field, in the
 *       body, like a flag key or a database name); otherwise the sim assigns `it_<n>` (the next integer with
 *       `numeric_ids`). A create whose `name` (or chosen id) already exists in the collection answers 409. Query
 *       parameters other than `cursor` are ignored: a filtered list answers the whole collection. Two style
 *       options address a collection the way some APIs do: `list_suffix` (`GET <collection>/all` lists it) and
 *       `item_query` (`<collection>?url=<id>` is the object whose id is `<id>`, for APIs that key objects by a
 *       value such as a URL).
 *   R4. PATCH (and POST to an object, or to an object of a collection, as Stripe updates) is a JSON merge patch
 *       (RFC 7396: maps merge recursively, `null` deletes a field, lists are replaced whole); PUT replaces
 *       everything but a collection object's id. Bodies may be JSON or form-encoded (`a[b]=c`, every value a
 *       string; with the style's `form_types`, `true`/`false` and numbers are read as such, as an API with a typed
 *       schema does). No write has a precondition (no ETag): the last write wins.
 *   R6. A style's `once_fields` are generated on create (`<field>_sim_<n>`) and appear only in the create's answer,
 *       never stored or listed: a webhook endpoint's signing secret.
 *   R5. DELETE answers `{ id, deleted: true }`; anything unknown is 404 `{ error }`.
 */
import type { IncomingHttpHeaders } from "node:http";
import { page, Reply, route, router, type ProviderSim, type SimCore } from "../provider.js";

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
  /** A path suffix that lists the collection (`/all`: `GET <collection>/all`), assumption R3. */
  list_suffix?: string;
  /** A query parameter that names an object of the collection by id (`url`), assumption R3. */
  item_query?: string;
}

/** Simulated REST API state, by path: collections of objects, objects that are not in a collection, and styles. */
export interface RestState {
  collections: Record<string, RestItem[]>;
  objects: Record<string, Record<string, unknown>>;
  styles: Record<string, RestStyle>;
}

/** Initial REST state, by path: objects per collection (ids assigned when absent), stand-alone objects, styles. */
export interface RestSeed {
  collections?: Record<string, Array<Record<string, unknown>>>;
  objects?: Record<string, Record<string, unknown>>;
  /** How each collection answers, by collection path (assumption R2). */
  styles?: Record<string, RestStyle>;
}

/** Simulated generic REST API; see the assumptions at the top of this file. */
export const restSim: ProviderSim<RestState, RestSeed> = {
  env: { token: "REST_API_TOKEN", url: "REST_API_URL", testToken: "tok_rest" },
  defaultSeed: {
    collections: { "/gates": [], "/flags": [], "/hooks": [] },
    objects: { "/apps/demo": { name: "demo app", allowed_origins: [], rules: [], uri_allow_list: "", env_vars: {} } },
  },

  reset(core, seed) {
    const state: RestState = { collections: {}, objects: structuredClone(seed?.objects ?? {}), styles: structuredClone(seed?.styles ?? {}) };
    for (const [path, items] of Object.entries(seed?.collections ?? {})) {
      const field = styleOf(state, path).id_field;
      state.collections[path] = items.map((i) => ({ ...structuredClone(i), [field]: isId(i[field]) ? i[field] : newId(core, state, path) }));
    }
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
    const [kind, path, b, ...more] = rest.split(".");
    if (kind === "items" && path && b) return driftItem(core, state, path, b, more.join("."), value, key);
    if (kind === "objects" && path && b && more.length === 0) return driftObject(state, path, b, value, key);
    return false;
  },

  authorized(headers) {
    return authorized(headers);
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function authorized(headers: IncomingHttpHeaders): boolean {
  if (/^(Bearer|Basic)\s+\S+$/.test(headers.authorization ?? "")) return true;
  return Object.entries(headers).some(([name, v]) => /(^|-)(api-key|key|token)$/.test(name) && typeof v === "string" && v.trim() !== "");
}

type FullStyle = Required<Omit<RestStyle, "next_path" | "list_suffix" | "item_query">> & Pick<RestStyle, "list_suffix" | "item_query"> & { next_path: string | null };

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
    ...(s.list_suffix ? { list_suffix: s.list_suffix } : {}),
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

/** What a path names in the state. */
type Target =
  | { kind: "object"; path: string; object: Record<string, unknown> }
  | { kind: "collection"; path: string; items: RestItem[] }
  | { kind: "item"; collection: string; index: number; item: RestItem }
  | { kind: "none" };

function resolve(state: RestState, raw: string, query?: URLSearchParams): Target {
  const path = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const object = state.objects[path];
  if (object) return { kind: "object", path, object };
  const items = state.collections[path];
  if (items) return queriedItem(state, path, query) ?? { kind: "collection", path, items };
  const cut = path.lastIndexOf("/");
  const collection = path.slice(0, cut);
  const style = styleOf(state, collection);
  // `GET <collection>/all` where the collection lists under a suffix (assumption R3).
  if (state.collections[collection] && style.list_suffix === path.slice(cut)) return { kind: "collection", path: collection, items: state.collections[collection] };
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

function create(core: SimCore, state: RestState, path: string, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
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

function patch(state: RestState, t: Target, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  if (t.kind === "object") {
    mergePatch(t.object, body);
    return new Reply(200, t.object);
  }
  if (t.kind !== "item") return notFound();
  const style = styleOf(state, t.collection);
  const id = t.item[style.id_field];
  mergePatch(t.item, body);
  t.item[style.id_field] = id;
  return new Reply(200, envelope(style.item_path, t.item));
}

function put(state: RestState, t: Target, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  if (t.kind === "object") {
    state.objects[t.path] = structuredClone(body);
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
    route("GET", "/*path", ({ core, state, params, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      if (t.kind === "object") return new Reply(200, t.object);
      if (t.kind === "item") return new Reply(200, envelope(styleOf(state, t.collection).item_path, t.item));
      if (t.kind === "none") return notFound();
      return list(core, state, t, url.searchParams.get("cursor"));
    }),

    route("POST", "/*path", ({ core, state, params, body, headers }) => {
      const t = resolve(state, `/${params.path}`);
      if (t.kind === "object") return patch(state, t, body);
      if (t.kind === "item") return patch(state, t, bodyFor(state, t.collection, body, headers));
      const path = t.kind === "collection" ? t.path : `/${params.path}`;
      return create(core, state, path, bodyFor(state, path, body, headers));
    }),

    route("PATCH", "/*path", ({ state, params, body, headers, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      return patch(state, t, t.kind === "item" ? bodyFor(state, t.collection, body, headers) : body);
    }),

    route("PUT", "/*path", ({ state, params, body, headers, url }) => {
      const t = resolve(state, `/${params.path}`, url.searchParams);
      return put(state, t, t.kind === "item" ? bodyFor(state, t.collection, body, headers) : body);
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
