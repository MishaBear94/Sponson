/**
 * `http.resource`: one object per item in a REST API (a feature flag, a webhook endpoint), declared entirely in the
 * plan. See ADR 0017 and docs/plan-format.md#httpresource.
 *
 * - Key: where the object lives and what identifies it there: `<find.path>[<field>=<value>,…]` when it is located
 *   by `find`, else its `read.path` (a URL that names it). A GraphQL `find` or `read` stands in for the path as
 *   `graphql:<root field>(<variables>)<data path>`. The provider block (base URL, credential) is part of the ledger
 *   identity already.
 * - Id: the request that removes it, `DELETE /things/<id>` (`KEEP /things/<id>` with `destroy: keep`), plus any
 *   `gone_status`, or `GRAPHQL {"query":…,"variables":…}` for a GraphQL delete, so `destroy` needs nothing but the
 *   ledger. A new provider id makes a new record id: replaced
 *   outside Sponson.
 * - Hash: `sha256(canonicalJson({ <field>: <value> }))` over the declared `fields` only; `diff` compares the same
 *   form, so a console edit of a declared field is `changed` drift and anything else the provider stores is not.
 */
import { SponsonError, canonicalJson, sha256, type AdapterContext, type ApplyResult, type DiffSide, type Literal, type LiveState, type OpSpec, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { ABSENT, SENSITIVE, assertNoPending, desiredSide, paramError } from "./common.js";
import { isObject, isProviderError, listAll, type ApiClient } from "./http.js";
import { failedWith, httpClient, idOf, itemOf, literalOf, withLineCredential, write } from "./http-adapter-client.js";
import { ADAPTER, apiBlock, apiEnvironment, at, credentialInputs, bodyOf, deepMerge, fieldTokens, fillPath, firstMarker, isKeep, parseResource, pointerTokens, projection, requestHeaders, resourceOutputs, stateHash, type FindSpec, type ResourceSpec } from "./http-adapter-spec.js";
import { fillVariables, graphqlRequest, requestName, usesId, variablesPending, type GraphqlSpec } from "./http-adapter-graphql.js";

/** An object as found: its provider id and its body. */
interface Located {
  id: string;
  item: Record<string, unknown>;
}

/** What `read` found, kept for `diff` and `apply` of the same inspection (the engine passes the same object). */
const found = new WeakMap<LiveState, Located>();

/** The resource key, or undefined while a value it depends on is pending. */
export function resourceKey(spec: ResourceSpec): string | undefined {
  if (!spec.find) return spec.read!.graphql ? graphqlKey(spec.read!.graphql, spec.itemPath) : fillPath(spec.read!.path, spec.vars);
  const path = spec.find.graphql ? graphqlKey(spec.find.graphql, spec.find.listPath) : fillPath(spec.find.path, spec.vars);
  const match = Object.entries(spec.find.match).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (path === undefined || match.some(([, v]) => firstMarker(v) !== undefined || isKeep(v))) return undefined;
  return `${path}[${match.map(([f, v]) => `${f}=${typeof v === "string" ? v : canonicalJson(v)}`).join(",")}]`;
}

/** A GraphQL locating request as a key: its root field, its variables and where the result is; undefined while pending. */
function graphqlKey(g: GraphqlSpec, fallbackPath: string): string | undefined {
  return variablesPending(g.variables) ? undefined : `${requestName(g)}${g.dataPath ?? fallbackPath}`;
}

/** True when any request of the line is GraphQL: its client then speaks JSON, whatever the API's encoding. */
function isGraphql(spec: ResourceSpec): boolean {
  return [spec.find, spec.read, spec.create, spec.update, spec.delete].some((r) => r?.graphql !== undefined);
}

/** The client for a line's requests. */
function clientOf(actx: AdapterContext, spec: ResourceSpec): ApiClient {
  return httpClient(actx, isGraphql(spec) ? { encoding: "json" } : {});
}

function label(spec: ResourceSpec, key: string): string {
  return `${spec.api} ${key}`;
}

/**
 * The record id: the request that removes the object (or `KEEP`), the statuses that mean it is gone, and the body
 * of an archiving `POST` (canonical JSON, last).
 */
function locator(spec: ResourceSpec, id: string): string {
  if (spec.delete.graphql) {
    const g = spec.delete.graphql;
    const request = canonicalJson({ query: g.query, variables: fillVariables(g.variables, id) });
    return `${spec.destroy === "keep" ? "KEEP " : ""}GRAPHQL ${request}`;
  }
  const method = spec.destroy === "keep" ? "KEEP" : spec.delete.method;
  const gone = spec.goneStatus.length ? ` gone=${spec.goneStatus.join(",")}` : "";
  const body = spec.delete.body ? ` body=${canonicalJson(bodyWithId(spec.delete.body, id))}` : "";
  return `${method} ${fillPath(spec.delete.path, spec.vars, id)}${gone}${body}`;
}

/**
 * A delete body with every `{id}` in its strings replaced by the object's id: a delete that names the object in its
 * body (`{ public_ids: ["{id}"] }`). The filled body is part of the record id, so destroy still needs only the ledger.
 */
function bodyWithId(body: unknown, id: string): unknown {
  if (typeof body === "string") return body.split("{id}").join(id);
  if (Array.isArray(body)) return body.map((v) => bodyWithId(v, id));
  if (isObject(body)) return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, bodyWithId(v, id)]));
  return body;
}

/** `actx` for a line: its own `credential` when it has one (`withLineCredential`). */
function lineContext(actx: AdapterContext, spec: ResourceSpec): AdapterContext {
  return withLineCredential(actx, spec.credential);
}

/**
 * What the ledger knows a line's object by: its key, and its record id with `id` standing for the provider's id.
 * The recipe identity lock (recipes.test.ts) pins it per recipe op.
 */
export function resourceIdentity(spec: ResourceSpec, id: string): { key: string | undefined; id: string } {
  return { key: resourceKey(spec), id: locator(spec, id) };
}

/** The request a record id names. */
function parseLocator(id: string): { method: string; path: string; gone: number[]; body: Record<string, unknown>; graphql?: GraphqlSpec } | null {
  const g = /^(KEEP )?GRAPHQL (\{.*\})$/s.exec(id);
  if (g) {
    try {
      const r = JSON.parse(g[2]!) as { query?: unknown; variables?: unknown };
      if (typeof r.query === "string" && isObject(r.variables)) return { method: g[1] ? "KEEP" : "GRAPHQL", path: "", gone: [], body: {}, graphql: { query: r.query, variables: r.variables, idempotent: true } };
    } catch {
      // reported by the caller
    }
    return null;
  }
  const m = /^(DELETE|POST|KEEP) (\/\S*)(?: gone=([\d,]+))?(?: body=(\{.*\}))?$/.exec(id);
  if (!m) return null;
  let body: unknown = {};
  try {
    body = m[4] ? JSON.parse(m[4]) : {};
  } catch {
    return null;
  }
  return isObject(body) ? { method: m[1]!, path: m[2]!, gone: m[3] ? m[3].split(",").map(Number) : [], body } : null;
}

function fieldNames(spec: ResourceSpec): string[] {
  return Object.keys(spec.fields);
}

/** The desired state; `{ keep: true }` fields take the live value. */
function desiredState(spec: ResourceSpec, live: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec.fields).map(([f, v]) => [f, isKeep(v) ? (at(live, fieldTokens(f)) ?? null) : v]));
}

function record(spec: ResourceSpec, key: string, l: Located): ResourceRecord {
  return { key, id: locator(spec, l.id), hash: stateHash(projection(l.item, fieldNames(spec))), label: label(spec, key) };
}

/**
 * The outputs read from `item`. A `once` output only from `revealed`, the answer of the create that made the object:
 * anywhere else the provider does not show it, and a value taken from a read would be a fake (ADR 0018).
 */
function outputsOf(spec: ResourceSpec, item: Record<string, unknown> | undefined, id: string, revealed = false): Record<string, Literal> {
  const out: Record<string, Literal> = { id };
  for (const [name, d] of Object.entries(spec.outputs)) {
    if (d.once && !revealed) continue;
    const v = literalOf(at(item, pointerTokens(d.path)));
    if (v !== undefined) out[name] = v;
  }
  return out;
}

function matches(item: Record<string, unknown>, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([f, v]) => canonicalJson(at(item, fieldTokens(f)) ?? null) === canonicalJson(v));
}

/**
 * The object's id at `id_path`. An object located by GraphQL may have none (a variable is named by the request
 * itself); unless a request needs `{id}`, the resource key then stands in for it.
 */
function idFor(spec: ResourceSpec, item: unknown, key: string | undefined): string | undefined {
  const id = idOf(item, spec.idPath);
  if (id !== undefined || key === undefined || !isGraphql(spec)) return id;
  const needsId = [spec.read, spec.update, spec.delete].some((r) => r?.graphql && usesId(r.graphql.variables)) || placeholders(spec);
  return needsId ? undefined : key;
}

/** True when a REST path of the line uses `{id}`. */
function placeholders(spec: ResourceSpec): boolean {
  return [spec.read, spec.update, spec.delete].some((r) => r !== undefined && !r.graphql && r.path.includes("{id}"));
}

function noId(spec: ResourceSpec, where: string): SponsonError {
  return new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: ${where} has no id at \`id_path\` ${spec.idPath || '""'}`, { adapter: ADAPTER, param: "id_path" });
}

/** Every object of a `find` list, following `find.next` cursors when declared. */
function listObjects(api: ApiClient, find: FindSpec, path: string): Promise<Array<Record<string, unknown>>> {
  return listAll(api, path, (body) => {
    const list = at(body, pointerTokens(find.listPath));
    if (!Array.isArray(list)) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: GET ${path}: no list at \`find.list_path\` ${find.listPath || '""'}`, { adapter: ADAPTER, param: "find.list_path" });
    const cursor = find.next ? at(body, pointerTokens(find.next.path)) : undefined;
    const next = find.next && (typeof cursor === "string" || typeof cursor === "number") && cursor !== "" ? { [find.next.param]: String(cursor) } : null;
    return { items: list.filter(isObject), next };
  });
}

/** GET a path that names the object; null when it answers 404 (or a declared `gone_status`). */
async function getObject(api: ApiClient, spec: ResourceSpec, path: string): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await api.get(path);
  } catch (e) {
    if (failedWith(e, "PROVIDER_NOT_FOUND", spec.goneStatus)) return null;
    throw e;
  }
  const item = itemOf(body, spec.itemPath);
  if (!item) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: GET ${path}: no object at \`item_path\` ${spec.itemPath || '""'}`, { adapter: ADAPTER, param: "item_path" });
  return item;
}

/** The value at a GraphQL request's result path: null when absent, a scalar as `{ value }`. */
function graphqlItem(data: unknown, path: string, name: string): Record<string, unknown> | null {
  const v = at(data, pointerTokens(path));
  if (v === undefined || v === null) return null;
  if (isObject(v)) return v;
  if (Array.isArray(v)) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: GraphQL ${name}: a list where the object should be (check \`data_path\`)`, { adapter: ADAPTER, param: "data_path" });
  return { value: v };
}

/** Run a locating GraphQL query and take the object it answers; null when absent or "not found". */
async function getGraphqlObject(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, g: GraphqlSpec, id: string | undefined): Promise<Record<string, unknown> | null> {
  try {
    return graphqlItem(await graphqlRequest(api, g, id, actx.redact, false), g.dataPath ?? spec.itemPath, requestName(g));
  } catch (e) {
    if (failedWith(e, "PROVIDER_NOT_FOUND", [])) return null;
    throw e;
  }
}

/** The objects a GraphQL `find` lists. */
async function graphqlObjects(actx: AdapterContext, api: ApiClient, find: FindSpec, g: GraphqlSpec): Promise<Array<Record<string, unknown>>> {
  const data = await graphqlRequest(api, g, undefined, actx.redact, false);
  const list = at(data, pointerTokens(g.dataPath ?? find.listPath));
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: GraphQL ${requestName(g)}: no list at ${g.dataPath ?? find.listPath}`, { adapter: ADAPTER, param: "find.list_path" });
  return list.filter(isObject);
}

/** The detail of a found object: by its `read` request, REST or GraphQL. */
async function readDetail(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, id: string): Promise<Record<string, unknown> | null> {
  const read = spec.read!;
  if (read.graphql) return getGraphqlObject(actx, api, spec, read.graphql, id);
  return getObject(api, spec, fillPath(read.path, spec.vars, id)!);
}

async function locateByFind(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, find: FindSpec, key: string | undefined): Promise<Located | null> {
  const path = find.graphql ? requestName(find.graphql) : fillPath(find.path, spec.vars)!;
  const listed = find.graphql ? await graphqlObjects(actx, api, find, find.graphql) : await listObjects(api, find, path);
  const hits = listed.filter((i) => matches(i, find.match));
  if (hits.length === 0) return null;
  if (hits.length > 1) throw paramError(ADAPTER, `\`find.match\` matches ${hits.length} objects at ${path}; add fields until it identifies one`, "find.match");
  const id = idFor(spec, hits[0], key);
  if (id === undefined) throw noId(spec, `an object listed by ${find.graphql ? path : `GET ${path}`}`);
  if (!spec.read) return { id, item: hits[0]! };
  const item = await readDetail(actx, api, spec, id);
  return item ? { id, item } : null;
}

/** Find the object the line declares; null when it does not exist. */
async function locate(actx: AdapterContext, api: ApiClient, spec: ResourceSpec): Promise<Located | null> {
  const key = resourceKey(spec);
  if (spec.find) return locateByFind(actx, api, spec, spec.find, key);
  const read = spec.read!;
  const item = read.graphql ? await getGraphqlObject(actx, api, spec, read.graphql, undefined) : await getObject(api, spec, fillPath(read.path, spec.vars)!);
  if (!item) return null;
  const id = idFor(spec, item, key);
  if (id === undefined) throw noId(spec, read.graphql ? requestName(read.graphql) : `GET ${fillPath(read.path, spec.vars)}`);
  return { id, item };
}

/** A side showing a whole state, or the first reference it waits on. */
function stateSide(state: Record<string, unknown>): DiffSide {
  const marker = firstMarker(state);
  return marker ? desiredSide(marker, false) : { state: "literal", value: canonicalJson(state) };
}

function noUpdate(spec: ResourceSpec, key: string): SponsonError {
  return paramError(ADAPTER, `${label(spec, key)}: the declared \`fields\` differ from the live object, but the line declares no \`update\` request`, "update");
}

function diffExisting(spec: ResourceSpec, key: string, current: ResourceRecord, live: Located | undefined): ResourceDiff {
  const lbl = label(spec, key);
  const before: DiffSide = live ? { state: "literal", value: canonicalJson(projection(live.item, fieldNames(spec))) } : SENSITIVE;
  if (firstMarker(spec.fields) !== undefined) return { key, kind: "update", label: lbl, before, after: stateSide(spec.fields) };
  const desired = desiredState(spec, live?.item);
  if (stateHash(desired) === current.hash) return { key, kind: "unchanged", label: lbl };
  if (!spec.update) throw noUpdate(spec, key);
  return { key, kind: "update", label: lbl, before, after: stateSide(desired) };
}

function keepWithoutObject(spec: ResourceSpec, key: string): SponsonError {
  return paramError(ADAPTER, `${label(spec, key)} declares a field \`{ keep: true }\` but does not exist, so there is no value to keep. Give it a value or remove it.`, "fields");
}

/**
 * The `Idempotency-Key` of a create: the same for every attempt of this create in this commit (a retried request
 * is answered from the provider's record), different for another key, scope, commit or body.
 */
function idempotencyKey(actx: AdapterContext, key: string, body: unknown): string {
  const { env, scope, git } = actx.ctx;
  return `sponson-${sha256(`${env}|${scope}|${git.sha}|${key}|${canonicalJson(body)}`).slice(0, 40)}`;
}

/** Send the create; null when the provider says it exists already (a conflict, or a declared `exists_status`). */
async function sendCreate(actx: AdapterContext, spec: ResourceSpec, key: string, path: string, body: Record<string, unknown>): Promise<{ response: unknown } | null> {
  const { method, idempotencyKey: withKey, contentType, graphql } = spec.create;
  if (graphql) return sendGraphqlCreate(actx, spec, graphql);
  const headers = { ...requestHeaders(spec.create, "create"), ...(withKey ? { "Idempotency-Key": idempotencyKey(actx, key, body) } : {}) };
  const api = httpClient(actx, { ...(contentType ? { contentType } : {}), headers });
  try {
    // With an idempotency key, a create whose answer was lost can be sent again: the provider answers it once.
    return { response: await write(api, method, path, body, method === "PUT" || withKey) };
  } catch (e) {
    if (failedWith(e, "PROVIDER_CONFLICT", spec.existsStatus)) return null;
    throw e;
  }
}

/** A GraphQL create: the mutation; its answer at the result path (when an object) stands for the created object. */
async function sendGraphqlCreate(actx: AdapterContext, spec: ResourceSpec, g: GraphqlSpec): Promise<{ response: unknown } | null> {
  try {
    const data = await graphqlRequest(clientOf(actx, spec), g, undefined, actx.redact, true);
    const v = at(data, pointerTokens(g.dataPath ?? spec.itemPath));
    return { response: isObject(v) ? { [CREATED]: v } : {} };
  } catch (e) {
    if (failedWith(e, "PROVIDER_CONFLICT", [])) return null;
    throw e;
  }
}

/** Where `sendGraphqlCreate` puts the created object, so `create` reads it with item_path `/<CREATED>`. */
const CREATED = "created";

/** The created object in a create's answer. */
function createdItem(spec: ResourceSpec, response: unknown): Record<string, unknown> | undefined {
  return spec.create.graphql ? itemOf(response, `/${CREATED}`) : itemOf(response, spec.itemPath);
}

async function create(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, key: string): Promise<ApplyResult> {
  if (Object.values(spec.fields).some(isKeep)) throw keepWithoutObject(spec, key);
  const path = fillPath(spec.create.path, spec.vars)!;
  const declared = spec.create.sendFields ? deepMerge(bodyOf(spec.find?.match ?? {}), bodyOf(spec.fields)) : {};
  const body = deepMerge(declared, spec.create.body);
  await actx.intend([key]);
  actx.log(`create ${label(spec, key)}`);
  const sent = await sendCreate(actx, spec, key, path, body);
  if (!sent) {
    // It exists already: someone else's, or ours from an attempt whose answer was lost. Not created by this call;
    // the engine claims it when an earlier intent of ours named it.
    const existing = await locate(actx, api, spec);
    if (!existing) throw new SponsonError("PROVIDER_CONFLICT", `${ADAPTER}: ${label(spec, key)}: the provider says it exists, but it cannot be found with the line's \`find\`/\`read\``, { adapter: ADAPTER, key });
    return { resources: [record(spec, key, existing)], outputs: outputsOf(spec, existing.item, existing.id), created: [] };
  }
  // `create.locate`: the answer is not the object (the parent it was added to, an acknowledgement).
  let item = spec.create.locate ? undefined : createdItem(spec, sent.response);
  let id = idOf(item, spec.idPath);
  const revealed = id !== undefined;
  if (id === undefined) {
    // Some APIs answer a create with no body (201, 204), with something else, or (GraphQL) with a boolean: find
    // what was created. Found so, it reveals no once-only value.
    const l = await locate(actx, api, spec);
    if (!l) throw noId(spec, spec.create.graphql ? `the answer to ${requestName(spec.create.graphql)}` : `the answer to ${spec.create.method} ${path}`);
    ({ id, item } = l);
  }
  const resource = { key, id: locator(spec, id), hash: stateHash(desiredState(spec, undefined)), label: label(spec, key) };
  return { resources: [resource], outputs: outputsOf(spec, item, id, revealed), created: [key] };
}

/** Send the update (REST, or the GraphQL mutation); the updated object when the answer holds one. */
async function sendUpdate(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, upd: NonNullable<ResourceSpec["update"]>, desired: Record<string, unknown>, id: string): Promise<Record<string, unknown> | undefined> {
  if (upd.graphql) {
    // An update sets state: sending it twice is harmless, so a dropped connection is retried.
    const data = await graphqlRequest(api, { ...upd.graphql, idempotent: true }, id, actx.redact, true);
    const v = at(data, pointerTokens(upd.graphql.dataPath ?? spec.itemPath));
    return isObject(v) ? v : undefined;
  }
  const { method, contentType, sendFields } = upd;
  // PUT replaces the object, so the identifying fields and kept fields are sent back as they are; PATCH and POST
  // send only what the plan sets; `send_fields: false` sends none (the request carries them in headers).
  const fields = !sendFields ? {} : method === "PUT" ? deepMerge(bodyOf(spec.find?.match ?? {}), bodyOf(desired)) : bodyOf(spec.fields, isKeep);
  const path = fillPath(upd.path, spec.vars, id)!;
  const headers = requestHeaders(upd, "update");
  const client = contentType || Object.keys(headers).length ? httpClient(actx, { ...(contentType ? { contentType } : {}), headers }) : api;
  const response = await write(client, method, path, deepMerge(fields, upd.body), true);
  return itemOf(response, spec.itemPath);
}

async function update(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, key: string, current: ResourceRecord, live: LiveState): Promise<ApplyResult> {
  const l = found.get(live) ?? (await locate(actx, api, spec));
  if (!l) return create(actx, api, spec, key);
  const desired = desiredState(spec, l.item);
  if (stateHash(desired) === current.hash) return { resources: [current], outputs: live.outputs, created: [] };
  if (!spec.update) throw noUpdate(spec, key);
  actx.log(`update ${label(spec, key)}`);
  const item = await sendUpdate(actx, api, spec, spec.update, desired, l.id);
  const resource = { key, id: locator(spec, l.id), hash: stateHash(desired), label: label(spec, key) };
  return { resources: [resource], outputs: { ...live.outputs, ...outputsOf(spec, item, l.id) }, created: [] };
}

const PENDING_KEY = "(pending)";

/**
 * A delete the provider accepted (2xx) but answered with something that is not JSON (Upstash answers `OK`): the
 * answer is never read, so the object is gone all the same.
 */
function acceptedWithoutJson(e: unknown): boolean {
  if (!isProviderError(e, "PROVIDER_RESPONSE")) return false;
  const status = e.details.status;
  return typeof status === "number" && status >= 200 && status < 300;
}

/** `http.resource`: one object per item, located by a path or by `find`, its declared `fields` kept as planned. */
export const resource: OpSpec = {
  outputs: { id: { available: "immediate" } },
  outputsFor: resourceOutputs,
  providerFor: apiBlock,
  credentialInputs: credentialInputs("resource"),
  writesEnvironment: apiEnvironment,

  async read(actx, params) {
    const spec = parseResource(params);
    const key = resourceKey(spec);
    // Nothing can exist under a credential that does not exist yet (the line it comes from is still to be created).
    if (key === undefined || firstMarker(spec.credential) !== undefined) return null;
    actx = lineContext(actx, spec);
    const l = await locate(actx, clientOf(actx, spec), spec);
    if (!l) return null;
    const state: LiveState = { resources: [record(spec, key, l)], outputs: outputsOf(spec, l.item, l.id) };
    found.set(state, l);
    return state;
  },

  diff(live, params) {
    const spec = parseResource(params);
    const key = resourceKey(spec);
    if (key === undefined) return [{ key: PENDING_KEY, kind: "create", label: `${spec.api} object`, before: ABSENT, after: desiredSide(firstMarker(params) ?? "", false) }];
    const current = live?.resources.find((r) => r.key === key);
    if (current) return [diffExisting(spec, key, current, live ? found.get(live) : undefined)];
    if (Object.values(spec.fields).some(isKeep)) throw keepWithoutObject(spec, key);
    return [{ key, kind: "create", label: label(spec, key), before: ABSENT, after: stateSide(spec.fields) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const spec = parseResource(params);
    const key = resourceKey(spec)!;
    actx = lineContext(actx, spec);
    const api = clientOf(actx, spec);
    const current = live?.resources.find((r) => r.key === key);
    return current && live ? update(actx, api, spec, key, current, live) : create(actx, api, spec, key);
  },

  async destroy(actx, resources) {
    for (const r of resources) {
      if (r.id === "") continue; // an intent never located: nothing was created under it
      const req = parseLocator(r.id);
      if (!req) throw new SponsonError("INTERNAL", `${ADAPTER}: ${r.key}: record id is not a delete request`, { adapter: ADAPTER, key: r.key });
      if (req.method === "KEEP") continue; // `destroy: keep`: left in place on purpose
      try {
        if (req.graphql) await graphqlRequest(httpClient(actx, { encoding: "json" }), req.graphql, undefined, actx.redact, true);
        else await write(httpClient(actx), req.method, req.path, req.method === "POST" ? req.body : undefined, true);
      } catch (e) {
        if (!failedWith(e, "PROVIDER_NOT_FOUND", req.gone) && !acceptedWithoutJson(e)) throw e;
      }
    }
  },
};
