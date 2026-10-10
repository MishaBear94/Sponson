/**
 * `http.list_item`: one value kept in a collection held by a parent object (an allowed origin, a callback URL, a
 * config var), by read-modify-write. The collection is a JSON array, a delimited string or a keyed map (`shape`).
 * See ADR 0017 and docs/plan-format.md#httplist_item.
 *
 * - Key: `<parent.path>#<list_path>=<item>`: which collection, and which item in it (for map items of an array,
 *   the value of `key_field`; for a keyed map, the entry's name). The provider block is part of the ledger
 *   identity already.
 * - Id: the item's locator as canonical JSON (how to read and write the parent, where and how the collection is
 *   stored, which item), so `destroy` needs nothing but the ledger.
 * - Hash: the item's state in canonical JSON: the value itself, the declared fields of a map item, or a keyed
 *   entry's value.
 * - Writes replace the whole collection (`PUT`, or `PATCH`/`POST` sent as idempotent, so a dropped connection is
 *   retried), except a keyed map with `send: field`, which is sent as a merge patch of the one entry (`null`
 *   deletes it). Then the parent is read again: the write counts only once the item is seen as planned. A
 *   collection that loses the item to a concurrent writer is written again, up to MAX_ATTEMPTS times.
 * - Lock: the parent object (`lockOn`, ADR 0019), so Sponson's writers in other scopes and environments never
 *   interleave between a read and a write. There is no precondition (ETag): only a writer outside Sponson can.
 */
import { SponsonError, canonicalJson, type AdapterContext, type DiffSide, type LiveState, type OpSpec, type ResolvedParams, type ResourceDiff, type ResourceRecord } from "@sponson/core";
import { ABSENT, SENSITIVE, assertNoPending, desiredSide, paramError } from "./common.js";
import { isObject, type ApiClient } from "./http.js";
import { failedWith, httpClient, write } from "./http-adapter-client.js";
import { ADAPTER, apiBlock, at, fieldTokens, fillPath, firstMarker, isKeep, parseListItem, pointerTokens, projection, setAt, stateHash, type ListItemSpec, type ListShape } from "./http-adapter-spec.js";

/** Read-modify-write rounds before giving up on a collection that keeps changing under us. */
export const MAX_ATTEMPTS = 3;

/** Where an item lives, resolved: every path filled in. It is the record id, as canonical JSON. */
interface Locator {
  read: string;
  write: string;
  list: string;
  send: "field" | "parent";
  shape: ListShape;
  sep?: string;
  key_field?: string;
  content_type?: string;
  item: unknown;
  /** `destroy: keep`: left in place when the scope is destroyed. */
  keep?: true;
}

/** One item of the collection: what identifies it, and its value. */
interface Entry {
  key: unknown;
  value: unknown;
}

/** What `read` found, kept for `diff` and `apply` of the same inspection. */
const found = new WeakMap<LiveState, Entry>();

/** The item's identity: the value, the `key_field` of a map item, or a keyed entry's name (strings for both string shapes). */
function keyValue(spec: ListItemSpec): unknown {
  if (spec.shape !== "array") return firstMarker(spec.item) ? spec.item : String(spec.item as string | number | boolean);
  return spec.keyField === undefined ? spec.item : at(spec.item, fieldTokens(spec.keyField));
}

function text(v: unknown): string {
  return typeof v === "string" ? v : canonicalJson(v);
}

/** The locator, or undefined while a value it depends on is pending. */
function locatorOf(spec: ListItemSpec): Locator | undefined {
  const read = fillPath(spec.parent.readPath, spec.vars);
  const path = fillPath(spec.parent.path, spec.vars);
  const item = keyValue(spec);
  if (read === undefined || path === undefined || firstMarker(item) !== undefined) return undefined;
  return {
    read,
    write: `${spec.parent.method} ${path}`,
    list: spec.listPath,
    send: spec.parent.send,
    shape: spec.shape,
    ...(spec.shape === "delimited" ? { sep: spec.separator } : {}),
    ...(spec.keyField !== undefined ? { key_field: spec.keyField } : {}),
    ...(spec.parent.contentType ? { content_type: spec.parent.contentType } : {}),
    item,
    ...(spec.destroy === "keep" ? { keep: true as const } : {}),
  };
}

function writePath(loc: Locator): string {
  return loc.write.slice(loc.write.indexOf(" ") + 1);
}

function keyOf(loc: Locator): string {
  return `${writePath(loc)}#${loc.list}=${text(loc.item)}`;
}

function labelOf(spec: ListItemSpec, loc: Locator): string {
  return `${spec.api} ${writePath(loc)}${loc.list} item ${text(loc.item)}`;
}

function sameKey(a: unknown, b: unknown): boolean {
  return a !== undefined && canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------
// The three shapes
// ---------------------------------------------------------------------------

function badShape(loc: Locator, expected: string): SponsonError {
  return new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: GET ${loc.read}: expected ${expected} at \`list_path\` ${loc.list || '""'}`, { adapter: ADAPTER, param: "list_path" });
}

/** The identifying value of one array element: itself, or its `key_field`; undefined when it has none. */
function arrayKey(e: unknown, keyField: string | undefined): unknown {
  if (keyField === undefined) return isObject(e) || Array.isArray(e) ? undefined : e;
  return isObject(e) ? at(e, fieldTokens(keyField)) : undefined;
}

/** The collection as entries. Absent or null is empty. */
function decode(raw: unknown, loc: Locator): Entry[] {
  if (raw === undefined || raw === null) return [];
  if (loc.shape === "array") {
    if (!Array.isArray(raw)) throw badShape(loc, "a list");
    return raw.map((value) => ({ key: arrayKey(value, loc.key_field), value }));
  }
  if (loc.shape === "delimited") {
    if (typeof raw !== "string") throw badShape(loc, `a string of values separated by "${loc.sep ?? ","}"`);
    return raw
      .split(loc.sep ?? ",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => ({ key: s, value: s }));
  }
  if (!isObject(raw)) throw badShape(loc, "a map");
  return Object.entries(raw).map(([key, value]) => ({ key, value }));
}

/** Entries as the collection the provider stores. */
function encode(entries: Entry[], loc: Locator): unknown {
  if (loc.shape === "array") return entries.map((e) => e.value);
  if (loc.shape === "delimited") return entries.map((e) => String(e.value as string)).join(loc.sep ?? ",");
  return Object.fromEntries(entries.map((e) => [String(e.key as string), e.value]));
}

/** `value` placed at `tokens` in `doc`; at the root, the value is the whole body. */
function place(doc: Record<string, unknown>, tokens: string[], value: unknown): unknown {
  return tokens.length === 0 ? value : setAt(doc, tokens, value);
}

/**
 * The fields an entry is compared by, when the plan declares a map: an array's map item, or a keyed entry's map
 * value (a merge patch leaves fields the plan no longer sets, so only the declared ones count).
 */
function declaredFields(spec: ListItemSpec): string[] | undefined {
  const declared = spec.shape === "map" ? spec.value : spec.shape === "array" ? spec.item : undefined;
  return isObject(declared) ? Object.keys(declared) : undefined;
}

/** The state an entry is compared by: the value, or the declared fields of a map. */
function entryState(spec: ListItemSpec, entry: Entry): unknown {
  const fields = declaredFields(spec);
  return fields ? projection(entry.value, fields) : entry.value;
}

/** The desired state; `{ keep: true }` takes the live entry's value. */
function desiredState(spec: ListItemSpec, entry: Entry | undefined): unknown {
  if (spec.shape === "map") return isKeep(spec.value) ? (entry ? entryState(spec, entry) : null) : spec.value;
  if (spec.shape === "delimited" || !isObject(spec.item)) return spec.shape === "delimited" ? String(spec.item as string) : spec.item;
  return Object.fromEntries(Object.entries(spec.item).map(([f, v]) => [f, isKeep(v) ? (at(entry?.value, fieldTokens(f)) ?? null) : v]));
}

/** The value to store: the item, a keyed entry's value, or a map item's declared (non-kept) fields over the live one. */
function nextValue(spec: ListItemSpec, entry: Entry | undefined): unknown {
  if (spec.shape === "map") return spec.value;
  if (spec.shape === "delimited" || !isObject(spec.item)) return desiredState(spec, entry);
  const set = Object.entries(spec.item).filter(([, v]) => !isKeep(v));
  return set.reduce<Record<string, unknown>>((o, [f, v]) => setAt(o, fieldTokens(f), v), isObject(entry?.value) ? entry.value : {});
}

function hasKeep(spec: ListItemSpec): boolean {
  if (spec.shape === "map") return isKeep(spec.value);
  return isObject(spec.item) && Object.values(spec.item).some(isKeep);
}

// ---------------------------------------------------------------------------
// Reading and writing the parent
// ---------------------------------------------------------------------------

/** The parent object and its collection. */
async function readParent(api: ApiClient, loc: Locator): Promise<{ doc: Record<string, unknown>; entries: Entry[] }> {
  const doc = await api.get(loc.read);
  if (!isObject(doc)) throw badShape(loc, "an object");
  return { doc, entries: decode(at(doc, pointerTokens(loc.list)), loc) };
}

function clientFor(actx: AdapterContext, loc: Locator): ApiClient {
  return httpClient(actx, loc.content_type ? { contentType: loc.content_type } : {});
}

/**
 * Write the collection after one change (`value: null` removes `key`): a keyed map with `send: field` as a merge
 * patch of that entry, anything else as the whole collection, alone or in the parent read just before.
 */
async function writeChange(api: ApiClient, loc: Locator, doc: Record<string, unknown>, entries: Entry[], change: Entry): Promise<void> {
  const tokens = pointerTokens(loc.list);
  let body: unknown;
  if (loc.shape === "map" && loc.send === "field") body = place({}, tokens, { [String(change.key as string)]: change.value });
  else body = place(loc.send === "parent" ? doc : {}, tokens, encode(entries, loc));
  const space = loc.write.indexOf(" ");
  await write(api, loc.write.slice(0, space), loc.write.slice(space + 1), body, true);
}

function raced(loc: Locator, what: string): SponsonError {
  return new SponsonError("PROVIDER_CONFLICT", `${ADAPTER}: ${loc.read}${loc.list}: ${what} after ${MAX_ATTEMPTS} read-modify-write attempts; another writer keeps changing it`, { adapter: ADAPTER, path: loc.read });
}

function keepWithoutItem(label: string): SponsonError {
  return paramError(ADAPTER, `${label} declares \`{ keep: true }\` but is not there, so there is no value to keep. Give it a value or remove it.`, "item");
}

function isPlanned(spec: ListItemSpec, entry: Entry | undefined): boolean {
  return entry !== undefined && stateHash(entryState(spec, entry)) === stateHash(desiredState(spec, entry));
}

/**
 * Put the item in the collection until a fresh read shows it as planned. Returns whether this call added it (it
 * was absent from the collection it read and wrote).
 */
async function ensure(actx: AdapterContext, spec: ListItemSpec, loc: Locator, label: string): Promise<boolean> {
  const api = clientFor(actx, loc);
  let added = false;
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const { doc, entries } = await readParent(api, loc);
    const idx = entries.findIndex((e) => sameKey(e.key, loc.item));
    if (isPlanned(spec, entries[idx])) return added;
    if (attempt === MAX_ATTEMPTS) break;
    if (idx < 0) {
      if (hasKeep(spec)) throw keepWithoutItem(label);
      if (!added) await actx.intend([keyOf(loc)]);
      added = true;
    }
    actx.log(`${idx < 0 ? "add" : "update"} ${label}`);
    const change = { key: loc.item, value: nextValue(spec, entries[idx]) };
    const next = idx < 0 ? [...entries, change] : entries.map((e, i) => (i === idx ? change : e));
    await writeChange(api, loc, doc, next, change);
  }
  throw raced(loc, "the item is still not as planned");
}

/** Take the item out until a fresh read no longer shows it; a missing parent counts as gone. */
async function remove(api: ApiClient, loc: Locator): Promise<void> {
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    let parent: { doc: Record<string, unknown>; entries: Entry[] };
    try {
      parent = await readParent(api, loc);
    } catch (e) {
      if (failedWith(e, "PROVIDER_NOT_FOUND", [])) return;
      throw e;
    }
    const rest = parent.entries.filter((e) => !sameKey(e.key, loc.item));
    if (rest.length === parent.entries.length) return;
    if (attempt === MAX_ATTEMPTS) break;
    await writeChange(api, loc, parent.doc, rest, { key: loc.item, value: null });
  }
  throw raced(loc, "the item is still there");
}

function parseLocator(id: string, key: string): Locator {
  try {
    const loc = JSON.parse(id) as Locator;
    if (typeof loc.read === "string" && typeof loc.write === "string" && typeof loc.list === "string") return loc;
  } catch {
    // reported below
  }
  throw new SponsonError("INTERNAL", `${ADAPTER}: ${key}: record id is not a list item locator`, { adapter: ADAPTER, key });
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

function recordOf(loc: Locator, spec: ListItemSpec, entry: Entry, label: string): ResourceRecord {
  return { key: keyOf(loc), id: canonicalJson(loc), hash: stateHash(entryState(spec, entry)), label };
}

function side(state: unknown): DiffSide {
  const marker = firstMarker(state);
  return marker ? desiredSide(marker, false) : { state: "literal", value: text(state) };
}

function diffExisting(spec: ListItemSpec, key: string, label: string, current: ResourceRecord, entry: Entry | undefined): ResourceDiff {
  const before: DiffSide = entry === undefined ? SENSITIVE : { state: "literal", value: text(entryState(spec, entry)) };
  const desired = desiredState(spec, entry);
  if (firstMarker(desired) !== undefined) return { key, kind: "update", label, before, after: side(desired) };
  if (stateHash(desired) === current.hash) return { key, kind: "unchanged", label };
  return { key, kind: "update", label, before, after: side(desired) };
}

/**
 * The parent object's identity for its lock (ADR 0019): `http:<base URL><parent path>`. The base URL is the API
 * block's `base_url` (not its `base_url_env` override, so every runner names the object alike) without user info,
 * query or fragment: an identity is written to receipts, so it never carries a credential. Every collection of
 * one parent shares the lock, since `send: parent` writes them all back.
 */
function parentLock(params: ResolvedParams, provider: Record<string, unknown>): string | null {
  const spec = parseListItem(params);
  const path = fillPath(spec.parent.path, spec.vars);
  if (path === undefined || typeof provider.base_url !== "string") return null;
  const base = new URL(provider.base_url);
  return `${ADAPTER}:${base.protocol}//${base.host}${base.pathname.replace(/\/+$/, "")}${path}`;
}

/** `http.list_item`: one value kept in a collection on a parent object, by read-modify-write. */
export const listItem: OpSpec = {
  outputs: {},
  providerFor: apiBlock,
  lockOn: parentLock,

  async read(actx, params) {
    const spec = parseListItem(params);
    const loc = locatorOf(spec);
    if (!loc) return null;
    const { entries } = await readParent(clientFor(actx, loc), loc);
    const entry = entries.find((e) => sameKey(e.key, loc.item));
    if (entry === undefined) return null;
    const state: LiveState = { resources: [recordOf(loc, spec, entry, labelOf(spec, loc))], outputs: {} };
    found.set(state, entry);
    return state;
  },

  diff(live, params) {
    const spec = parseListItem(params);
    const loc = locatorOf(spec);
    if (!loc) return [{ key: "(pending)", kind: "create", label: `${spec.api} list item`, before: ABSENT, after: desiredSide(firstMarker(params) ?? "", false) }];
    const key = keyOf(loc);
    const label = labelOf(spec, loc);
    const current = live?.resources.find((r) => r.key === key);
    if (current) return [diffExisting(spec, key, label, current, live ? found.get(live) : undefined)];
    if (hasKeep(spec)) throw keepWithoutItem(label);
    return [{ key, kind: "create", label, before: ABSENT, after: side(desiredState(spec, undefined)) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const spec = parseListItem(params);
    const loc = locatorOf(spec)!;
    const key = keyOf(loc);
    const label = labelOf(spec, loc);
    const current = live?.resources.find((r) => r.key === key);
    const entry = live ? found.get(live) : undefined;
    if (current && isPlanned(spec, entry)) return { resources: [current], outputs: {}, created: [] };
    const added = await ensure(actx, spec, loc, label);
    const hash = stateHash(desiredState(spec, entry));
    return { resources: [{ key, id: canonicalJson(loc), hash, label }], outputs: {}, created: added ? [key] : [] };
  },

  async destroy(actx, resources) {
    for (const r of resources) {
      if (r.id === "") continue; // an intent never located: nothing was added under it
      const loc = parseLocator(r.id, r.key);
      if (loc.keep) continue; // `destroy: keep`: left in place on purpose
      await remove(clientFor(actx, loc), loc);
    }
  },

  /** Every item of the collection: any of them may be one a scope (or nobody) manages. */
  async listScope(actx, params) {
    const spec = parseListItem(params);
    const loc = locatorOf(spec);
    if (!loc) return [];
    const { entries } = await readParent(clientFor(actx, loc), loc);
    return entries.flatMap((e) => {
      if (e.key === undefined || isObject(e.key) || Array.isArray(e.key)) return [];
      const l = { ...loc, item: e.key };
      return [recordOf(l, spec, e, labelOf(spec, l))];
    });
  },
};
