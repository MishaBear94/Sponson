/**
 * Simulated generic REST API: the provider the `http` adapter (packages/adapters/src/http-adapter*.ts) is tested
 * against. It models no particular SaaS. Any path can hold one of two things, so a plan written for a real API
 * (`/gates`, `/clients/abc123`) can be planned and applied against it once its collections and objects are seeded:
 *
 *   - a collection of objects with ids: `<path>` lists and creates, `<path>/<id>` reads, updates, deletes;
 *   - an object (a parent holding lists, maps or delimited strings, such as an application with its allowed
 *     origins, or a map of config vars): `<path>` reads, updates (PATCH, PUT, POST), deletes.
 *
 * Assumptions it encodes (about "a conventional JSON REST API", not about one provider; every real API the adapter
 * is pointed at is described by its plan line instead, see docs/api-verification.md):
 *   R1. Credentials arrive as `Authorization: Bearer <token>`, `Authorization: Basic <base64>` or a `*-Api-Key`
 *       header (`X-Api-Key`, `Statsig-Api-Key`); anything else is 401.
 *   R2. Collection objects are answered in a `{ data: <object> }` envelope, lists as `{ data: [...], next_cursor }`,
 *       paged with `?cursor=` under chaos `page_size` (`next_cursor` is null on the last page). Objects that are
 *       not in a collection are answered bare.
 *   R3. A path is known once seeded or created: a POST to an unknown path creates the collection; a GET of an
 *       unknown path is 404. A create may choose the id (`"id"` in the body, like a flag key); otherwise the sim
 *       assigns `it_<n>`. A create whose `name` (or chosen id) already exists in the collection answers 409.
 *   R4. PATCH (and POST to an object) is a JSON merge patch (RFC 7396: maps merge recursively, `null` deletes a
 *       field, lists are replaced whole); PUT replaces everything but a collection object's id. Bodies may be JSON
 *       or form-encoded (`a[b]=c`, every value a string). No write has a precondition (no ETag): the last write
 *       wins.
 *   R5. DELETE answers `{ id, deleted: true }`; anything unknown is 404 `{ error }`.
 *   R6. With an `auth` seed, credentials are checked for real instead of R1, one scheme or several: bearer tokens
 *       issued by the OAuth2 client-credentials endpoint `POST /rest/oauth/token` (RFC 6749 §4.4; Basic or form
 *       client authentication; tokens expire after `token_ttl` seconds and the drift key `auth.revoke_tokens`
 *       revokes them), fixed bearer tokens (`tokens`, what a CLI prints), HTTP Digest (RFC 7616, qop=auth; a
 *       request without valid credentials gets a 401 with a fresh challenge), and AWS SigV4 (the signature
 *       recomputed and compared; see ../auth.ts). Anything else is 401.
 */
import type { IncomingHttpHeaders } from "node:http";
import { digestChallenge, digestProblem, issueToken, sigV4Problem, tokenValid, type DigestConfig, type IssuedToken, type SigV4Config } from "../auth.js";
import { page, Reply, route, router, type AuthRequest, type ProviderSim, type SimCore } from "../provider.js";

/** One object of a collection, as stored and answered: its id and every field a client wrote. */
export type RestItem = { id: string } & Record<string, unknown>;

/** Simulated REST API state, by path: collections of objects, and objects that are not in a collection. */
export interface RestState {
  collections: Record<string, RestItem[]>;
  objects: Record<string, Record<string, unknown>>;
  /** Present when the seed configures real credentials (R6). */
  auth?: RestAuthState;
}

/**
 * Real credentials for the REST sim (R6). Each key enables one scheme; with none of them, R1 applies (any
 * non-empty credential).
 */
export interface RestAuthSeed {
  /** OAuth2 clients the token endpoint accepts: client id → client secret. */
  clients?: Record<string, string>;
  /** Lifetime of the tokens it issues, in seconds (default 3600). */
  token_ttl?: number;
  /** Bearer tokens accepted as they are (the token a CLI such as `gcloud auth print-access-token` prints). */
  tokens?: string[];
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

/** Initial REST state, by path: objects per collection (ids assigned when absent), and stand-alone objects. */
export interface RestSeed {
  collections?: Record<string, Array<Record<string, unknown>>>;
  objects?: Record<string, Record<string, unknown>>;
  /** Real credentials (R6). */
  auth?: RestAuthSeed;
}

/** Simulated generic REST API; see the assumptions at the top of this file. */
export const restSim: ProviderSim<RestState, RestSeed> = {
  env: { token: "REST_API_TOKEN", url: "REST_API_URL", testToken: "tok_rest" },
  defaultSeed: {
    collections: { "/gates": [], "/flags": [], "/hooks": [] },
    objects: { "/apps/demo": { name: "demo app", allowed_origins: [], rules: [], uri_allow_list: "", env_vars: {} } },
  },

  reset(core, seed) {
    const collections: Record<string, RestItem[]> = {};
    for (const [path, items] of Object.entries(seed?.collections ?? {})) {
      collections[path] = items.map((i) => ({ ...structuredClone(i), id: typeof i.id === "string" ? i.id : core.nextId("it_") }));
    }
    const state: RestState = { collections, objects: structuredClone(seed?.objects ?? {}) };
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

  isWrite(req) {
    return !(req.method === "POST" && req.path === "/oauth/token");
  },

  authorized(headers, req, state) {
    if (!state.auth) return authorized(headers);
    // The token endpoint authenticates the client itself.
    if (req.method === "POST" && req.url.pathname === "/rest/oauth/token") return true;
    if (strictlyAuthorized(headers, req, state.auth)) return true;
    state.auth.refused += 1;
    return state.auth.digest ? digestChallenge(state.auth.digest, state.auth, state.auth.nonces.length + 1) : false;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

/** R6: the request carries one of the credentials the seed configures, valid. */
function strictlyAuthorized(headers: IncomingHttpHeaders, req: AuthRequest, auth: RestAuthState): boolean {
  const value = headers.authorization ?? "";
  const bearer = /^Bearer\s+(\S+)$/.exec(value)?.[1];
  if (bearer !== undefined) return (auth.tokens ?? []).includes(bearer) || tokenValid({ clients: auth.clients ?? {}, ttlSeconds: 0, issued: auth.issued }, bearer);
  if (/^Digest\s/i.test(value) && auth.digest) return digestProblem(headers, req, auth.digest, auth) === null;
  if (value.startsWith("AWS4-HMAC-SHA256") && auth.sigv4) return sigV4Problem(headers, req, auth.sigv4) === null;
  return false;
}

function authorized(headers: IncomingHttpHeaders): boolean {
  if (/^(Bearer|Basic)\s+\S+$/.test(headers.authorization ?? "")) return true;
  return Object.entries(headers).some(([name, v]) => /(^|-)api-key$/.test(name) && typeof v === "string" && v.trim() !== "");
}

function driftItem(core: SimCore, state: RestState, coll: string, which: string, field: string, value: string, key: string): boolean {
  const list = state.collections[coll] ?? [];
  const item = list.find((i) => i.id === which || i.name === which);
  if (!item) throw new Error(`drift ${key}: no item ${which} in ${coll}`);
  if (field) {
    item[field] = parseValue(value);
    return true;
  }
  if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported without a field`);
  const rest = list.filter((i) => i !== item);
  if (value === "recreate") rest.push({ ...item, id: core.nextId("it_") });
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

function resolve(state: RestState, raw: string): Target {
  const path = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const object = state.objects[path];
  if (object) return { kind: "object", path, object };
  const items = state.collections[path];
  if (items) return { kind: "collection", path, items };
  const cut = path.lastIndexOf("/");
  const collection = path.slice(0, cut);
  const id = decodeURIComponent(path.slice(cut + 1));
  const index = (state.collections[collection] ?? []).findIndex((i) => i.id === id);
  return index >= 0 ? { kind: "item", collection, index, item: state.collections[collection]![index]! } : { kind: "none" };
}

const notFound = (): Reply => error(404, "not found");

function create(core: SimCore, state: RestState, path: string, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  const list = (state.collections[path] ??= []);
  const chosen = typeof body.id === "string" && body.id !== "" ? body.id : undefined;
  const clash = list.find((i) => (chosen !== undefined && i.id === chosen) || (body.name !== undefined && i.name === body.name));
  if (clash) return error(409, `already exists: ${clash.id}`);
  const item: RestItem = { ...structuredClone(body), id: chosen ?? core.nextId("it_") };
  list.push(item);
  return new Reply(201, { data: item });
}

function patch(state: RestState, t: Target, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  if (t.kind === "object") {
    mergePatch(t.object, body);
    return new Reply(200, t.object);
  }
  if (t.kind !== "item") return notFound();
  mergePatch(t.item, body);
  t.item.id = state.collections[t.collection]![t.index]!.id;
  return new Reply(200, { data: t.item });
}

function put(state: RestState, t: Target, body: unknown): Reply {
  if (!isRecord(body)) return error(400, "body must be a JSON object");
  if (t.kind === "object") {
    state.objects[t.path] = structuredClone(body);
    return new Reply(200, state.objects[t.path]);
  }
  if (t.kind !== "item") return notFound();
  const next: RestItem = { ...structuredClone(body), id: t.item.id };
  state.collections[t.collection]![t.index] = next;
  return new Reply(200, { data: next });
}

const routes = router<RestState>(
  [
    route("POST", "/oauth/token", ({ state, headers, body }) => {
      if (!state.auth?.clients) return error(404, "no token endpoint: the rest sim's auth seed configures no OAuth2 clients");
      const issued = { clients: state.auth.clients, ttlSeconds: state.auth.token_ttl ?? 3600, issued: state.auth.issued };
      return issueToken(issued, headers, body);
    }),

    route("GET", "/*path", ({ core, state, params, url }) => {
      const t = resolve(state, `/${params.path}`);
      if (t.kind === "object") return new Reply(200, t.object);
      if (t.kind === "item") return new Reply(200, { data: t.item });
      if (t.kind === "none") return notFound();
      const pg = page(core, t.items, url.searchParams.get("cursor"));
      return new Reply(200, { data: pg.items, next_cursor: pg.next === null ? null : String(pg.next) });
    }),

    route("POST", "/*path", ({ core, state, params, body }) => {
      const t = resolve(state, `/${params.path}`);
      if (t.kind === "object") return patch(state, t, body);
      if (t.kind === "item") return error(405, "cannot POST to an object of a collection");
      return create(core, state, t.kind === "collection" ? t.path : `/${params.path}`, body);
    }),

    route("PATCH", "/*path", ({ state, params, body }) => patch(state, resolve(state, `/${params.path}`), body)),

    route("PUT", "/*path", ({ state, params, body }) => put(state, resolve(state, `/${params.path}`), body)),

    route("DELETE", "/*path", ({ state, params }) => {
      const t = resolve(state, `/${params.path}`);
      if (t.kind === "item") {
        state.collections[t.collection]!.splice(t.index, 1);
        return new Reply(200, { id: t.item.id, deleted: true });
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
