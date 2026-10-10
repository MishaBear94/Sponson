/**
 * `http.resource`: one object per item in a REST API (a feature flag, a webhook endpoint), declared entirely in the
 * plan. See ADR 0017 and docs/plan-format.md#httpresource.
 *
 * - Key: where the object lives and what identifies it there: `<find.path>[<field>=<value>,…]` when it is located
 *   by `find`, else its `read.path` (a URL that names it). The provider block (base URL, credential) is part of
 *   the ledger identity already.
 * - Id: the request that removes it, `DELETE /things/<id>` (`KEEP /things/<id>` with `destroy: keep`), plus any
 *   `gone_status`, so `destroy` needs nothing but the ledger. A new provider id makes a new record id: replaced
 *   outside Sponson.
 * - Hash: `sha256(canonicalJson({ <field>: <value> }))` over the declared `fields` only; `diff` compares the same
 *   form, so a console edit of a declared field is `changed` drift and anything else the provider stores is not.
 */
import { SponsonError, canonicalJson, sha256, type AdapterContext, type ApplyResult, type DiffSide, type Literal, type LiveState, type OpSpec, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { ABSENT, SENSITIVE, assertNoPending, desiredSide, paramError } from "./common.js";
import { isObject, listAll, type ApiClient } from "./http.js";
import { failedWith, httpClient, idOf, itemOf, literalOf, write } from "./http-adapter-client.js";
import { ADAPTER, apiBlock, at, bodyOf, deepMerge, fieldTokens, fillPath, firstMarker, isKeep, parseResource, pointerTokens, projection, resourceOutputs, stateHash, type FindSpec, type ResourceSpec } from "./http-adapter-spec.js";

/** An object as found: its provider id and its body. */
interface Located {
  id: string;
  item: Record<string, unknown>;
}

/** What `read` found, kept for `diff` and `apply` of the same inspection (the engine passes the same object). */
const found = new WeakMap<LiveState, Located>();

/** The resource key, or undefined while a value it depends on is pending. */
export function resourceKey(spec: ResourceSpec): string | undefined {
  if (!spec.find) return fillPath(spec.read!.path, spec.vars);
  const path = fillPath(spec.find.path, spec.vars);
  const match = Object.entries(spec.find.match).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (path === undefined || match.some(([, v]) => firstMarker(v) !== undefined || isKeep(v))) return undefined;
  return `${path}[${match.map(([f, v]) => `${f}=${typeof v === "string" ? v : canonicalJson(v)}`).join(",")}]`;
}

function label(spec: ResourceSpec, key: string): string {
  return `${spec.api} ${key}`;
}

/** The record id: the request that removes the object (or `KEEP`), and the statuses that mean it is gone. */
function locator(spec: ResourceSpec, id: string): string {
  const method = spec.destroy === "keep" ? "KEEP" : spec.delete.method;
  const gone = spec.goneStatus.length ? ` gone=${spec.goneStatus.join(",")}` : "";
  return `${method} ${fillPath(spec.delete.path, spec.vars, id)}${gone}`;
}

/**
 * What the ledger knows a line's object by: its key, and its record id with `id` standing for the provider's id.
 * The recipe identity lock (recipes.test.ts) pins it per recipe op.
 */
export function resourceIdentity(spec: ResourceSpec, id: string): { key: string | undefined; id: string } {
  return { key: resourceKey(spec), id: locator(spec, id) };
}

/** The request a record id names. */
function parseLocator(id: string): { method: string; path: string; gone: number[] } | null {
  const m = /^(DELETE|POST|KEEP) (\/\S*)(?: gone=([\d,]+))?$/.exec(id);
  return m ? { method: m[1]!, path: m[2]!, gone: m[3] ? m[3].split(",").map(Number) : [] } : null;
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

async function locateByFind(api: ApiClient, spec: ResourceSpec, find: FindSpec): Promise<Located | null> {
  const path = fillPath(find.path, spec.vars)!;
  const hits = (await listObjects(api, find, path)).filter((i) => matches(i, find.match));
  if (hits.length === 0) return null;
  if (hits.length > 1) throw paramError(ADAPTER, `\`find.match\` matches ${hits.length} objects at ${path}; add fields until it identifies one`, "find.match");
  const id = idOf(hits[0], spec.idPath);
  if (id === undefined) throw noId(spec, `an object listed by GET ${path}`);
  if (!spec.read) return { id, item: hits[0]! };
  const item = await getObject(api, spec, fillPath(spec.read.path, spec.vars, id)!);
  return item ? { id, item } : null;
}

/** Find the object the line declares; null when it does not exist. */
async function locate(api: ApiClient, spec: ResourceSpec): Promise<Located | null> {
  if (spec.find) return locateByFind(api, spec, spec.find);
  const path = fillPath(spec.read!.path, spec.vars)!;
  const item = await getObject(api, spec, path);
  if (!item) return null;
  const id = idOf(item, spec.idPath);
  if (id === undefined) throw noId(spec, `GET ${path}`);
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
  const { method, idempotencyKey: withKey, contentType } = spec.create;
  const api = httpClient(actx, { ...(contentType ? { contentType } : {}), ...(withKey ? { headers: { "Idempotency-Key": idempotencyKey(actx, key, body) } } : {}) });
  try {
    // With an idempotency key, a create whose answer was lost can be sent again: the provider answers it once.
    return { response: await write(api, method, path, body, method === "PUT" || withKey) };
  } catch (e) {
    if (failedWith(e, "PROVIDER_CONFLICT", spec.existsStatus)) return null;
    throw e;
  }
}

async function create(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, key: string): Promise<ApplyResult> {
  if (Object.values(spec.fields).some(isKeep)) throw keepWithoutObject(spec, key);
  const path = fillPath(spec.create.path, spec.vars)!;
  const body = deepMerge(deepMerge(bodyOf(spec.find?.match ?? {}), bodyOf(spec.fields)), spec.create.body);
  await actx.intend([key]);
  actx.log(`create ${label(spec, key)}`);
  const sent = await sendCreate(actx, spec, key, path, body);
  if (!sent) {
    // It exists already: someone else's, or ours from an attempt whose answer was lost. Not created by this call;
    // the engine claims it when an earlier intent of ours named it.
    const existing = await locate(api, spec);
    if (!existing) throw new SponsonError("PROVIDER_CONFLICT", `${ADAPTER}: ${label(spec, key)}: the provider says it exists, but it cannot be found with the line's \`find\`/\`read\``, { adapter: ADAPTER, key });
    return { resources: [record(spec, key, existing)], outputs: outputsOf(spec, existing.item, existing.id), created: [] };
  }
  let item = itemOf(sent.response, spec.itemPath);
  let id = idOf(item, spec.idPath);
  const revealed = id !== undefined;
  if (id === undefined) {
    // Some APIs answer a create with no body (201, 204): find what was created. It reveals no once-only value.
    const l = await locate(api, spec);
    if (!l) throw noId(spec, `the answer to ${spec.create.method} ${path}`);
    ({ id, item } = l);
  }
  const resource = { key, id: locator(spec, id), hash: stateHash(desiredState(spec, undefined)), label: label(spec, key) };
  return { resources: [resource], outputs: outputsOf(spec, item, id, revealed), created: [key] };
}

async function update(actx: AdapterContext, api: ApiClient, spec: ResourceSpec, key: string, current: ResourceRecord, live: LiveState): Promise<ApplyResult> {
  const l = found.get(live) ?? (await locate(api, spec));
  if (!l) return create(actx, api, spec, key);
  const desired = desiredState(spec, l.item);
  if (stateHash(desired) === current.hash) return { resources: [current], outputs: live.outputs, created: [] };
  if (!spec.update) throw noUpdate(spec, key);
  const { method, contentType } = spec.update;
  // PUT replaces the object, so the identifying fields and kept fields are sent back as they are; PATCH and POST
  // send only what the plan sets.
  const fields = method === "PUT" ? deepMerge(bodyOf(spec.find?.match ?? {}), bodyOf(desired)) : bodyOf(spec.fields, isKeep);
  const path = fillPath(spec.update.path, spec.vars, l.id)!;
  actx.log(`update ${label(spec, key)}`);
  const response = await write(contentType ? httpClient(actx, { contentType }) : api, method, path, deepMerge(fields, spec.update.body), true);
  const resource = { key, id: locator(spec, l.id), hash: stateHash(desired), label: label(spec, key) };
  return { resources: [resource], outputs: { ...live.outputs, ...outputsOf(spec, itemOf(response, spec.itemPath), l.id) }, created: [] };
}

const PENDING_KEY = "(pending)";

/** `http.resource`: one object per item, located by a path or by `find`, its declared `fields` kept as planned. */
export const resource: OpSpec = {
  outputs: { id: { available: "immediate" } },
  outputsFor: resourceOutputs,
  providerFor: apiBlock,

  async read(actx, params) {
    const spec = parseResource(params);
    const key = resourceKey(spec);
    if (key === undefined) return null;
    const l = await locate(httpClient(actx), spec);
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
    const api = httpClient(actx);
    const current = live?.resources.find((r) => r.key === key);
    return current && live ? update(actx, api, spec, key, current, live) : create(actx, api, spec, key);
  },

  async destroy(actx, resources) {
    const api = httpClient(actx);
    for (const r of resources) {
      if (r.id === "") continue; // an intent never located: nothing was created under it
      const req = parseLocator(r.id);
      if (!req) throw new SponsonError("INTERNAL", `${ADAPTER}: ${r.key}: record id \`${r.id}\` is not a delete request`, { adapter: ADAPTER, key: r.key });
      if (req.method === "KEEP") continue; // `destroy: keep`: left in place on purpose
      try {
        await write(api, req.method, req.path, req.method === "POST" ? {} : undefined, true);
      } catch (e) {
        if (!failedWith(e, "PROVIDER_NOT_FOUND", req.gone)) throw e;
      }
    }
  },
};
