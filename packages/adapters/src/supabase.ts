/**
 * Supabase adapter, over the Management API (https://api.supabase.com/v1) with one personal access token.
 *
 *   branch         a preview branch of the project per scope (Supabase Branching): created, waited for until its
 *                  database is up, destroyed with the scope. Its outputs are the branch's own project ref, API URL
 *                  and database connection string (sensitive).
 *   auth_redirect  one URL in the project's Auth redirect allow-list (`uri_allow_list`, one comma-separated
 *                  string): read-modify-write of that string, never touching entries Sponson did not add.
 *
 * What the code assumes about the API is numbered S1–S8 at the top of packages/sim/src/routes/supabase.ts and
 * checked in docs/api-verification.md.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, isPendingMarker, sha256, type AdapterContext, type Literal, type LiveState, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { ABSENT, assertNoPending, clientFor, deleteIgnoringNotFound, desiredSide, diffValue, optionalEnv, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isProviderError, isTransient, obj, records, type ApiClient } from "./http.js";

const ADAPTER = "supabase";
/** The environment Supabase reads; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = { credentialEnv: "SUPABASE_ACCESS_TOKEN", baseUrlEnv: "SUPABASE_API_URL" } as const;

/** The Supabase Management API's base URL. `SUPABASE_API_URL` overrides it; tests and scenarios point that at the sim. */
export const SUPABASE_DEFAULT_API_URL = "https://api.supabase.com/v1";

/** How long `branch` waits for a new branch to come up unless SPONSON_SUPABASE_TIMEOUT_MS says otherwise. */
const DEFAULT_READY_TIMEOUT_MS = 600_000;
/** Polling starts this fast and doubles up to the cap: the sim is ready at once, a real branch takes minutes. */
const POLL_FIRST_MS = 100;
const POLL_MAX_MS = 5_000;
/** Read-modify-write rounds of the allow-list before a concurrent writer is reported as a conflict. */
const LIST_ATTEMPTS = 3;

interface Client {
  api: ApiClient;
  /** The parent project's ref (`providers.supabase.project`). */
  project: string;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const project = requireProvider(actx, "project", ADAPTER);
  return { api: clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? SUPABASE_DEFAULT_API_URL, token }), project: encodeURIComponent(project) };
}

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

interface Branch {
  name: string;
  /** The branch's own project ref: the path parameter of GET/DELETE /branches/{ref}, and its URL's host. */
  project_ref: string;
  is_default: boolean;
}

interface Detail {
  status: string;
  db_host: string;
  db_port: number;
  db_user?: string;
  db_pass?: string;
}

const BRANCH_PREFIX = "branch:";

function branchKey(name: string): string {
  return `${BRANCH_PREFIX}${name}`;
}

/** Identity hash: the name, the one thing the plan controls. A branch recreated under the same name shows as a new id. */
function branchHash(name: string): string {
  return sha256(canonicalJson({ name }));
}

function branchRecord(b: Branch): ResourceRecord {
  return { key: branchKey(b.name), id: b.project_ref, hash: branchHash(b.name), label: `Supabase branch ${b.name}` };
}

/** BranchResponse items (assumptions S1, S2): `name` and `project_ref` are what the adapter consumes. */
function parseBranches(v: unknown, what: string): Branch[] {
  return records(v, what, ["name", "project_ref"]).map((b) => ({ name: b.name, project_ref: b.project_ref, is_default: b.is_default === true }));
}

async function listBranches(c: Client): Promise<Branch[]> {
  return c.api.get(`/projects/${c.project}/branches`, (body) => parseBranches(body, "the branch list"));
}

/** The branch named `name`, refusing the project's default branch: that is the project itself, never a preview. */
function findBranch(branches: Branch[], name: string): Branch | undefined {
  const b = branches.find((x) => x.name === name);
  if (b?.is_default) throw paramError(ADAPTER, `branch \`${name}\` is the project's default branch; a supabase.branch line manages preview branches only`, "name");
  return b;
}

/** BranchDetailResponse (assumptions S3, S4). */
function parseDetail(body: unknown): Detail {
  const o = obj(body, "the branch detail");
  if (typeof o.status !== "string") throw new ShapeError("expected `status` to be a string");
  if (typeof o.db_host !== "string") throw new ShapeError("expected `db_host` to be a string");
  if (typeof o.db_port !== "number") throw new ShapeError("expected `db_port` to be a number");
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const user = str(o.db_user);
  const pass = str(o.db_pass);
  return { status: o.status, db_host: o.db_host, db_port: o.db_port, ...(user ? { db_user: user } : {}), ...(pass ? { db_pass: pass } : {}) };
}

/** The API URL of a project ref (assumption S4). */
function apiUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

/** Outputs known from the branch alone, before its database is up. */
function baseOutputs(ref: string): Record<string, Literal> {
  return { project_ref: ref, api_url: apiUrl(ref) };
}

/** Every output, from a ready branch's detail. The password is percent-encoded, as a connection URI requires. */
function readyOutputs(ref: string, d: Detail): Record<string, Literal> {
  if (!d.db_user || !d.db_pass) {
    throw new SponsonError("PROVIDER_RESPONSE", `supabase: GET /branches/${ref} has no database credentials (db_user, db_pass); the access token may not be allowed to read them`, { adapter: ADAPTER, branch: ref });
  }
  const uri = `postgresql://${encodeURIComponent(d.db_user)}:${encodeURIComponent(d.db_pass)}@${d.db_host}:${d.db_port}/postgres`;
  return { ...baseOutputs(ref), db_host: d.db_host, connection_string: uri };
}

const READY = "ACTIVE_HEALTHY";
/** Project states a new branch does not leave by itself: waiting longer cannot help. */
const FAILED_STATES = new Set(["INIT_FAILED", "REMOVED", "GOING_DOWN", "INACTIVE", "PAUSING", "PAUSE_FAILED", "RESTORE_FAILED"]);

/** The detail, or null while the branch is not there yet (a 404 or a transient failure right after the create). */
async function detailOrNull(c: Client, ref: string): Promise<Detail | null> {
  try {
    return await c.api.get(`/branches/${encodeURIComponent(ref)}`, parseDetail);
  } catch (e) {
    if (isTransient(e) || isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
}

/** Wait until the branch's project is `ACTIVE_HEALTHY` and return its outputs; WAIT_TIMEOUT after the deadline. */
async function untilReady(c: Client, actx: AdapterContext, b: Branch): Promise<Record<string, Literal>> {
  const timeout = Number(actx.env.SPONSON_SUPABASE_TIMEOUT_MS ?? DEFAULT_READY_TIMEOUT_MS);
  const deadline = Date.now() + timeout;
  for (let delay = POLL_FIRST_MS; ; delay = Math.min(POLL_MAX_MS, delay * 2)) {
    const d = await detailOrNull(c, b.project_ref);
    if (d?.status === READY) return readyOutputs(b.project_ref, d);
    if (d && FAILED_STATES.has(d.status)) throw new SponsonError("PROVIDER_INVALID", `supabase: branch ${b.name} (${b.project_ref}) is ${d.status} and will not come up by itself`, { adapter: ADAPTER, branch: b.project_ref, state: d.status });
    const left = deadline - Date.now();
    if (left <= 0) throw new SponsonError("WAIT_TIMEOUT", `supabase: branch ${b.name} (${b.project_ref}) not ready after ${timeout}ms (still ${d?.status ?? "not found"}); run again to keep waiting`, { adapter: ADAPTER, branch: b.project_ref, state: d?.status ?? null });
    actx.log(`waiting for branch ${b.name} (${d?.status ?? "not found yet"})`);
    await sleep(Math.min(delay, left));
  }
}

/** What read reports: every output once the database is up; the ref and URL alone while it is coming up. */
async function currentOutputs(c: Client, b: Branch): Promise<Record<string, Literal>> {
  const d = await detailOrNull(c, b.project_ref);
  return d?.status === READY ? readyOutputs(b.project_ref, d) : baseOutputs(b.project_ref);
}

/** After a refused create: the branch, when the refusal was "that name exists" (assumption S5); else the error. */
async function recoverCreate(c: Client, name: string, e: unknown): Promise<Branch> {
  const refused = isProviderError(e, "PROVIDER_INVALID") && (e.details.status === 400 || e.details.status === 422);
  if (!isProviderError(e, "PROVIDER_CONFLICT") && !refused) throw e;
  const found = findBranch(await listBranches(c), name);
  if (!found) throw e;
  return found;
}

const branch: OpSpec = {
  outputs: {
    project_ref: { available: "immediate" },
    api_url: { available: "immediate" },
    db_host: { available: "immediate" },
    connection_string: { available: "immediate", sensitive: true },
  },

  defaults(params, ctx) {
    return { name: `sponson-${ctx.env}-${ctx.scope}`, ...params };
  },

  async read(actx, params) {
    if (isPendingMarker(params.name)) return null;
    const c = client(actx);
    const name = stringParam(params, "name", ADAPTER);
    const found = findBranch(await listBranches(c), name);
    if (!found) return null;
    return { resources: [branchRecord(found)], outputs: await currentOutputs(c, found) };
  },

  diff(live, params) {
    const name = params.name;
    if (isPendingMarker(name)) return [{ key: `${BRANCH_PREFIX}(pending)`, kind: "create", label: "Supabase branch", before: ABSENT, after: desiredSide(name, false) }];
    const key = branchKey(String(name));
    const current = live?.resources.find((r) => r.key === key);
    if (current) return [{ key, kind: "unchanged", label: current.label ?? key }];
    return [{ key, kind: "create", label: `Supabase branch ${String(name)}`, before: ABSENT, after: desiredSide(name, false) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const c = client(actx);
    const name = stringParam(params, "name", ADAPTER);
    const key = branchKey(name);
    const current = live?.resources.find((r) => r.key === key);
    // Exists: no write, but wait for it, so a run that timed out waiting finishes the job and gets the outputs.
    if (current) return { resources: live!.resources, outputs: await untilReady(c, actx, { name, project_ref: current.id, is_default: false }), created: [] };

    // Announce the create before sending it: a crash or a lost response must not orphan the branch.
    await actx.intend([key]);
    actx.log(`create branch ${name} of project ${c.project}`);
    let b: Branch;
    let created: string[] = [key];
    try {
      b = await c.api.post(`/projects/${c.project}/branches`, { branch_name: name }, (body) => parseBranches([body], "the created branch")[0]!);
    } catch (e) {
      // It exists already: someone else's, or ours from an attempt whose answer was lost. Not created by this
      // call; the engine claims it when an earlier intent of ours named it.
      b = await recoverCreate(c, name, e);
      created = [];
    }
    return { resources: [branchRecord(b)], outputs: await untilReady(c, actx, b), created };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) {
      // Never the parent project itself, whatever a ledger says.
      if (r.id === decodeURIComponent(c.project)) continue;
      await deleteIgnoringNotFound(c.api, `/branches/${encodeURIComponent(r.id)}`);
    }
  },

  /** Every branch but the project's default one: anything else may be a preview branch some scope (or nobody) manages. */
  async listScope(actx) {
    return (await listBranches(client(actx))).filter((b) => !b.is_default).map(branchRecord);
  },

  /** One line per branch, naming it: the line then manages exactly that branch. */
  adopt(resources) {
    return resources.map((r) => {
      const name = r.key.slice(BRANCH_PREFIX.length);
      return { id: `db-${name}`, params: { name }, keys: [r.key] };
    });
  },
};

// ---------------------------------------------------------------------------
// auth_redirect
// ---------------------------------------------------------------------------

const REDIRECT_PREFIX = "redirect:";

function redirectKey(url: string): string {
  return `${REDIRECT_PREFIX}${url}`;
}

function redirectRecord(url: string): ResourceRecord {
  return { key: redirectKey(url), id: url, hash: sha256(url), label: `Supabase Auth redirect ${url}` };
}

const AUTH_CONFIG = (c: Client) => `/projects/${c.project}/config/auth`;

/** `uri_allow_list` from the auth config (assumption S7): a nullable string; null means empty. */
function parseAllowList(body: unknown): string {
  const v = obj(body, "the auth config").uri_allow_list;
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw new ShapeError(`expected \`uri_allow_list\` to be a string or null, got ${typeof v}`);
  return v;
}

/** The entries of an allow-list string: comma-separated, whitespace around them ignored (assumption S8). */
function entriesOf(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

async function readAllowList(c: Client): Promise<string> {
  return c.api.get(AUTH_CONFIG(c), parseAllowList);
}

/**
 * Replace the whole allow-list. PATCH carrying only `uri_allow_list` sets that one field (S7), so sending it twice
 * is harmless: `idempotent` lets the client retry it after a dropped connection.
 */
async function writeAllowList(c: Client, list: string): Promise<void> {
  await c.api.patch(AUTH_CONFIG(c), { uri_allow_list: list }, (body) => obj(body, "the auth config"), { idempotent: true });
}

/** The URL param: one allow-list entry, so no comma (it would split into two) and no surrounding whitespace. */
function urlParam(params: Record<string, unknown>): string {
  const url = stringParam(params, "url", ADAPTER);
  if (url.includes(",")) throw paramError(ADAPTER, `url \`${url}\` contains a comma; the allow-list is comma-separated`, "url");
  if (url.trim() !== url) throw paramError(ADAPTER, "url has leading or trailing whitespace", "url");
  return url;
}

function conflict(c: Client, what: string): SponsonError {
  return new SponsonError("PROVIDER_CONFLICT", `supabase: the Auth allow-list of project ${decodeURIComponent(c.project)} changed under every one of ${LIST_ATTEMPTS} attempts to ${what}; another writer is editing it`, { adapter: ADAPTER, project: decodeURIComponent(c.project) });
}

/**
 * Add `url` unless present: read, append, write, re-read. There is no precondition to make the write
 * conditional (S7), so a concurrent writer can overwrite ours; the re-read notices and the round repeats.
 * Returns whether this call wrote it.
 */
async function addEntry(c: Client, actx: AdapterContext, url: string): Promise<boolean> {
  let wrote = false;
  for (let attempt = 0; ; attempt++) {
    const list = await readAllowList(c);
    if (entriesOf(list).includes(url)) return wrote;
    if (attempt === LIST_ATTEMPTS) throw conflict(c, `add ${url}`);
    actx.log(`allow redirect ${url}`);
    // Appending keeps every other entry exactly as written.
    await writeAllowList(c, list.trim() === "" ? url : `${list.replace(/[\s,]+$/, "")},${url}`);
    wrote = true;
  }
}

/** Remove exactly `urls` (and nothing else) from the allow-list, then re-read to confirm. */
async function removeEntries(c: Client, actx: AdapterContext, urls: Set<string>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const entries = entriesOf(await readAllowList(c));
    if (!entries.some((u) => urls.has(u))) return;
    if (attempt === LIST_ATTEMPTS) throw conflict(c, "remove entries");
    actx.log(`remove redirects ${[...urls].filter((u) => entries.includes(u)).join(", ")}`);
    await writeAllowList(c, entries.filter((u) => !urls.has(u)).join(","));
  }
}

const auth_redirect: OpSpec = {
  outputs: { url: { available: "immediate" } },

  async read(actx, params) {
    if (isPendingMarker(params.url)) return null;
    const url = urlParam(params);
    if (!entriesOf(await readAllowList(client(actx))).includes(url)) return null;
    return { resources: [redirectRecord(url)], outputs: { url } };
  },

  diff(live, params) {
    const url = params.url;
    const key = isPendingMarker(url) ? `${REDIRECT_PREFIX}(pending)` : redirectKey(String(url));
    const current = live?.resources.find((r) => r.key === key);
    return [diffValue({ key, label: "Supabase Auth redirect", live: current, desired: url, sensitive: false, liveValue: String(url) })];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const url = urlParam(params);
    const key = redirectKey(url);
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: live.outputs, created: [] };
    const c = client(actx);
    await actx.intend([key]);
    // Already listed (someone else's, or ours from a run whose answer was lost): not created by this call.
    const wrote = await addEntry(c, actx, url);
    const state: LiveState = { resources: [redirectRecord(url)], outputs: { url } };
    return { ...state, created: wrote ? [key] : [] };
  },

  async destroy(actx, resources) {
    if (resources.length === 0) return;
    await removeEntries(client(actx), actx, new Set(resources.map((r) => r.id)));
  },

  /** Every URL on the allow-list. */
  async listScope(actx) {
    return entriesOf(await readAllowList(client(actx))).map(redirectRecord);
  },

  /** One line per allowed URL. */
  adopt(resources) {
    return resources.map((r) => ({ id: "auth_redirect", params: { url: r.key.slice(REDIRECT_PREFIX.length) }, keys: [r.key] }));
  },
};

/**
 * The Supabase adapter (`adapter: supabase` in a plan): op `branch` (a preview branch per scope, with its
 * connection string as a sensitive output) and op `auth_redirect` (one URL in the project's Auth redirect
 * allow-list). Needs `SUPABASE_ACCESS_TOKEN` and `providers.supabase.project` (the parent project's ref).
 */
export const supabaseAdapter: ResourceAdapter = { name: ADAPTER, ops: { branch, auth_redirect }, about: ABOUT };
