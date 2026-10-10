/**
 * PlanetScale adapter (Vitess / MySQL databases): a development branch per scope, and a password for it whose
 * plaintext PlanetScale shows only once. The API assumptions this relies on are numbered PS1… at the top of
 * packages/sim/src/routes/planetscale.ts and checked in docs/api-verification.md.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type Ctx, type Literal, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { ABSENT, assertNoPending, clientFor, deleteIgnoringNotFound, desiredSide, optionalEnv, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { isProviderError, listAll, obj, records, ShapeError, type ApiClient, type Page } from "./http.js";

const ADAPTER = "planetscale";
/**
 * The environment PlanetScale reads; declared once, used by the code below and by the generated docs. A service
 * token is two values, sent as `Authorization: <id>:<token>` (PS1).
 */
const ABOUT = { credentialEnv: "PLANETSCALE_SERVICE_TOKEN", extraCredentialEnv: ["PLANETSCALE_SERVICE_TOKEN_ID"], baseUrlEnv: "PLANETSCALE_API_URL" } as const;

/** PlanetScale's API base URL; `PLANETSCALE_API_URL` overrides it (the sim and tests use that). */
export const PLANETSCALE_DEFAULT_API_URL = "https://api.planetscale.com/v1";

/** How often a new branch is polled until it is ready, and for how long at most; both overridable from the environment. */
const POLL_MS = { env: "SPONSON_PLANETSCALE_POLL_MS", fallback: 2000 };
const READY_TIMEOUT_MS = { env: "SPONSON_PLANETSCALE_READY_TIMEOUT_MS", fallback: 10 * 60 * 1000 };

/** The query a connection string ends with by default: the form PlanetScale documents for Node.js drivers. */
const DEFAULT_CONNECTION_PARAMS = 'ssl={"rejectUnauthorized":true}';

interface Client {
  api: ApiClient;
  /** `/organizations/<o>/databases/<d>` (PS2). */
  base: string;
  database: string;
}

function client(actx: AdapterContext): Client {
  const id = requireEnv(actx.env, ABOUT.extraCredentialEnv[0], ADAPTER);
  const secret = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const organization = requireProvider(actx, "organization", ADAPTER);
  const database = requireProvider(actx, "database", ADAPTER);
  const api = clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? PLANETSCALE_DEFAULT_API_URL, token: `${id}:${secret}`, authHeader: "header:authorization" });
  return { api, base: `/organizations/${enc(organization)}/databases/${enc(database)}`, database };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function msFromEnv(env: NodeJS.ProcessEnv, s: { env: string; fallback: number }): number {
  const raw = optionalEnv(env, s.env);
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : s.fallback;
}

/** `sponson-<env>-<scope>`, lowercase letters, digits and dashes only (PS14). */
function defaultName(ctx: Ctx): string {
  return `sponson-${ctx.env}-${ctx.scope}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

interface Branch {
  id: string;
  name: string;
  parent_branch: string | null;
  production: boolean;
  ready: boolean;
}

function parseBranch(v: unknown, what: string): Branch {
  const [b] = records([v], what, ["id", "name"]);
  const parent = b!.parent_branch;
  if (parent !== undefined && parent !== null && typeof parent !== "string") throw new ShapeError(`expected ${what}.parent_branch to be a string or null`);
  return { id: b!.id, name: b!.name, parent_branch: parent ?? null, production: b!.production === true, ready: b!.ready === true };
}

/** One page of a PlanetScale list: `{ data, next_page }`, the next page being `?page=<next_page>` (PS3). */
function pageOf<T>(body: unknown, parse: (v: unknown, what: string) => T): Page<T> {
  const o = obj(body, "the list");
  if (!Array.isArray(o.data)) throw new ShapeError("expected `data` to be an array");
  const items = o.data.map((v, i) => parse(v, `\`data\`[${i}]`));
  return { items, next: typeof o.next_page === "number" ? { page: String(o.next_page) } : null };
}

/** The branch by name (PS2), or null when it does not exist. */
async function getBranch(c: Client, name: string): Promise<Branch | null> {
  try {
    return await c.api.get(`${c.base}/branches/${enc(name)}`, (b) => parseBranch(b, "the branch"));
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
}

/** Poll the branch until it reports `ready` (PS4). Reads only. */
async function waitReady(actx: AdapterContext, c: Client, name: string): Promise<Branch> {
  const deadline = Date.now() + msFromEnv(actx.env, READY_TIMEOUT_MS);
  for (;;) {
    const b = await getBranch(c, name);
    if (!b) throw new SponsonError("PROVIDER_NOT_FOUND", `planetscale: branch ${name} disappeared while waiting for it to become ready`, { adapter: ADAPTER, branch: name });
    if (b.ready) return b;
    if (Date.now() > deadline) {
      throw new SponsonError("WAIT_TIMEOUT", `planetscale: branch ${name} is not ready after ${msFromEnv(actx.env, READY_TIMEOUT_MS)}ms (${READY_TIMEOUT_MS.env}); run again to keep waiting`, { adapter: ADAPTER, branch: name });
    }
    actx.log(`branch ${name} not ready yet`);
    await sleep(msFromEnv(actx.env, POLL_MS));
  }
}

const BRANCH_PREFIX = "branch:";

/** Identity hash: name and parent, the two things that define a branch for us (as `neon.branch`). */
function branchRecord(b: Branch): ResourceRecord {
  return { key: `${BRANCH_PREFIX}${b.name}`, id: b.id, hash: sha256(canonicalJson({ name: b.name, parent_branch: b.parent_branch })), label: `PlanetScale branch ${b.name}` };
}

function branchOutputs(b: Branch): Record<string, Literal> {
  return { name: b.name, branch_id: b.id };
}

/** Create the branch, or find it when it exists already (a lost answer of ours, or someone else's). */
async function createBranch(actx: AdapterContext, c: Client, name: string, parent: string): Promise<{ branch: Branch; created: boolean }> {
  try {
    await c.api.post(`${c.base}/branches`, { name, parent_branch: parent }, (b) => parseBranch(b, "the created branch"));
    return { branch: await waitReady(actx, c, name), created: true };
  } catch (e) {
    // PS5: a duplicate name answers 422 (perhaps 409). Whatever the wording, the branch existing is what matters.
    if (!isProviderError(e, ["PROVIDER_CONFLICT", "PROVIDER_INVALID"])) throw e;
    const found = await getBranch(c, name);
    if (!found) throw e;
    // Not created by this call; the engine claims it when an earlier intent of ours named it.
    return { branch: found.ready ? found : await waitReady(actx, c, name), created: false };
  }
}

const branch: OpSpec = {
  outputs: {
    name: { available: "immediate" },
    branch_id: { available: "immediate" },
  },

  defaults(params, ctx) {
    return { parent: "main", name: defaultName(ctx), ...params };
  },

  async read(actx, params) {
    if (markerKind(params.name) !== null) return null;
    const c = client(actx);
    const found = await getBranch(c, stringParam(params, "name", ADAPTER));
    return found ? { resources: [branchRecord(found)], outputs: branchOutputs(found) } : null;
  },

  diff(live, params) {
    const name = params.name;
    if (markerKind(name) !== null) return [{ key: `${BRANCH_PREFIX}(pending)`, kind: "create", label: "PlanetScale branch", before: ABSENT, after: desiredSide(name, false) }];
    const key = `${BRANCH_PREFIX}${String(name)}`;
    const current = live?.resources.find((r) => r.key === key);
    // A branch's identity is its name; re-parenting is not possible, so an existing branch is unchanged whatever `parent` says.
    if (current) return [{ key, kind: "unchanged", label: current.label ?? key }];
    return [{ key, kind: "create", label: `PlanetScale branch ${String(name)}`, before: ABSENT, after: desiredSide(name, false) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const name = stringParam(params, "name", ADAPTER);
    const key = `${BRANCH_PREFIX}${name}`;
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: live.outputs, created: [] };

    const c = client(actx);
    const parent = stringParam(params, "parent", ADAPTER, "main");
    if (!(await getBranch(c, parent))) throw paramError(ADAPTER, `parent branch \`${parent}\` not found in database ${c.database}`, "parent");

    await actx.intend([key]);
    actx.log(`create branch ${name} from ${parent}`);
    const r = await createBranch(actx, c, name, parent);
    return { resources: [branchRecord(r.branch)], outputs: branchOutputs(r.branch), created: r.created ? [key] : [] };
  },

  /** Deletes by name (PS2), and only the branch the ledger recorded: one re-created under that name by someone else is left alone. */
  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) {
      const name = r.key.slice(BRANCH_PREFIX.length);
      const live = await getBranch(c, name);
      if (!live || (r.id && live.id !== r.id)) continue;
      await deleteIgnoringNotFound(c.api, `${c.base}/branches/${enc(name)}`);
    }
  },

  /** Every development branch: production branches are never a scope's. */
  async listScope(actx) {
    const c = client(actx);
    const all = await listAll(c.api, `${c.base}/branches`, (body) => pageOf(body, parseBranch));
    return all.filter((b) => !b.production).map(branchRecord);
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
// Passwords
// ---------------------------------------------------------------------------

interface Password {
  id: string;
  name: string;
  role: string;
  username: string;
  host: string;
}

function parsePassword(v: unknown, what: string): Password {
  const [p] = records([v], what, ["id", "role", "username", "access_host_url"]);
  return { id: p!.id, name: typeof p!.name === "string" ? p!.name : "", role: p!.role, username: p!.username, host: p!.access_host_url };
}

/** The create answer: the password, and its plaintext, which no other answer carries (PS8). */
function parseCreatedPassword(v: unknown): Password & { plainText: string } {
  const p = parsePassword(v, "the created password");
  const plain = (v as Record<string, unknown>).plain_text;
  if (typeof plain !== "string" || plain === "") throw new ShapeError("expected `plain_text` to be a non-empty string in the create answer");
  return { ...p, plainText: plain };
}

const PASSWORD_PREFIX = "password:";

/** The branch is part of the key: two branches may each have a password of the same name. */
function passwordKey(branchName: string, name: string): string {
  return `${PASSWORD_PREFIX}${enc(branchName)}/${name}`;
}

function branchOfKey(key: string): string {
  const rest = key.slice(PASSWORD_PREFIX.length);
  return decodeURIComponent(rest.slice(0, rest.indexOf("/")));
}

function passwordHash(name: string, role: string): string {
  return sha256(canonicalJson({ name, role }));
}

function passwordRecord(branchName: string, p: Password): ResourceRecord {
  return { key: passwordKey(branchName, p.name), id: p.id, hash: passwordHash(p.name, p.role), label: `PlanetScale password ${p.name} on branch ${branchName}` };
}

function passwordOutputs(p: Password): Record<string, Literal> {
  return { id: p.id, username: p.username, host: p.host, role: p.role };
}

/** The passwords of a branch named `name`; null when the branch does not exist. */
async function findPassword(c: Client, branchName: string, name: string): Promise<Password | null> {
  let all: Password[];
  try {
    all = await listAll(c.api, `${c.base}/branches/${enc(branchName)}/passwords`, (body) => pageOf(body, parsePassword));
  } catch (e) {
    if (isProviderError(e, "PROVIDER_NOT_FOUND")) return null;
    throw e;
  }
  const named = all.filter((p) => p.name === name);
  // PS9: names are not unique. Guessing could hand a dependent the wrong credential's identity.
  if (named.length > 1) {
    throw new SponsonError("PROVIDER_CONFLICT", `planetscale: branch ${branchName} has ${named.length} passwords named ${name}; delete the extra ones in PlanetScale, then run again`, { adapter: ADAPTER, branch: branchName, name });
  }
  return named[0] ?? null;
}

interface PasswordParams {
  branch: string;
  name: string;
  role: string;
}

function passwordParams(params: Record<string, unknown>): PasswordParams {
  return { branch: stringParam(params, "branch", ADAPTER), name: stringParam(params, "name", ADAPTER), role: stringParam(params, "role", ADAPTER, "admin") };
}

/** `mysql://<username>:<plaintext>@<access host>/<database>?<params>`, as PlanetScale documents it (PS8). */
function connectionString(p: Password & { plainText: string }, database: string, query: string): string {
  return `mysql://${enc(p.username)}:${enc(p.plainText)}@${p.host}/${enc(database)}${query ? `?${query}` : ""}`;
}

function roleChangeError(p: PasswordParams, liveRole: string): SponsonError {
  return paramError(
    ADAPTER,
    `password ${p.name} on branch ${p.branch} has role ${liveRole}; PlanetScale cannot change a password's role in place, and Sponson does not replace a password on its own. ` +
      `Give the line a new \`name\` to create a ${p.role} password (dependents then receive its value), or set \`role: ${liveRole}\`.`,
    "role",
  );
}

const password: OpSpec = {
  outputs: {
    id: { available: "immediate" },
    username: { available: "immediate" },
    host: { available: "immediate" },
    role: { available: "immediate" },
    password: { available: "immediate", sensitive: true, once: true },
    connection_string: { available: "immediate", sensitive: true, once: true },
  },

  defaults(params, ctx) {
    return { name: defaultName(ctx), role: "admin", ...params };
  },

  async read(actx, params) {
    if (markerKind(params.branch) !== null || markerKind(params.name) !== null) return null;
    const p = passwordParams(params);
    const c = client(actx);
    const found = await findPassword(c, p.branch, p.name);
    // The plaintext is never readable (PS8): `password` and `connection_string` exist only in the run that creates it.
    return found ? { resources: [passwordRecord(p.branch, found)], outputs: passwordOutputs(found) } : null;
  },

  diff(live, params) {
    if (markerKind(params.branch) !== null || markerKind(params.name) !== null) {
      return [{ key: `${PASSWORD_PREFIX}(pending)`, kind: "create", label: "PlanetScale password", before: ABSENT, after: desiredSide(params.name, false) }];
    }
    const p = passwordParams(params);
    const key = passwordKey(p.branch, p.name);
    const label = `PlanetScale password ${p.name} on branch ${p.branch}`;
    const current = live?.resources.find((r) => r.key === key);
    if (!current) return [{ key, kind: "create", label, before: ABSENT, after: { state: "literal", value: p.role } }];
    if (current.hash === passwordHash(p.name, p.role)) return [{ key, kind: "unchanged", label }];
    // PS10: the only way to another role is a new password, and that is the plan's decision, never Sponson's.
    throw roleChangeError(p, String(live?.outputs.role ?? "another role"));
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const p = passwordParams(params);
    const key = passwordKey(p.branch, p.name);
    const current = live?.resources.find((r) => r.key === key);
    if (current) {
      if (current.hash !== passwordHash(p.name, p.role)) throw roleChangeError(p, String(live?.outputs.role ?? "another role"));
      return { resources: live!.resources, outputs: live!.outputs, created: [] };
    }

    const c = client(actx);
    if (!(await getBranch(c, p.branch))) throw paramError(ADAPTER, `branch \`${p.branch}\` not found in database ${c.database}`, "branch");
    // PS12: a password needs a ready branch; a branch an earlier run left provisioning is waited for here.
    await waitReady(actx, c, p.branch);

    await actx.intend([key]);
    actx.log(`create password ${p.name} (${p.role}) on branch ${p.branch}`);
    const created = await c.api.post(`${c.base}/branches/${enc(p.branch)}/passwords`, { name: p.name, role: p.role }, parseCreatedPassword);
    const query = stringParam(params, "connection_params", ADAPTER, DEFAULT_CONNECTION_PARAMS);
    const record = passwordRecord(p.branch, { ...created, name: p.name });
    const outputs = { ...passwordOutputs(created), password: created.plainText, connection_string: connectionString(created, c.database, query) };
    return { resources: [record], outputs, created: [key] };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(c.api, `${c.base}/branches/${enc(branchOfKey(r.key))}/passwords/${enc(r.id)}`);
  },
};

/**
 * PlanetScale (Vitess / MySQL databases): op `branch` creates a development branch per scope and waits until it
 * is ready; op `password` creates a password on it whose `connection_string` and `password` outputs (sensitive)
 * exist only in the run that creates it (`once`). Needs `PLANETSCALE_SERVICE_TOKEN_ID`,
 * `PLANETSCALE_SERVICE_TOKEN` and `providers.planetscale.{organization,database}`.
 */
export const planetscaleAdapter: ResourceAdapter = { name: ADAPTER, ops: { branch, password }, about: ABOUT };
