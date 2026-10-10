/**
 * Xata adapter (the Postgres platform): a copy-on-write branch per scope, child of a parent branch. A new branch
 * takes a moment to come up, so `apply` waits for it to be healthy, then reads its credentials: the wait and the
 * second request are why this is an adapter and not an `http` recipe (ADR 0017, "No polling"). The API assumptions
 * it relies on are numbered XA1… at the top of packages/sim/src/routes/xata.ts.
 *
 * - Key: `branch:<name>`. Id: Xata's branch id. The organization and project are the provider block.
 * - Hash: the name only. The parent is used when the branch is created; a branch cannot be moved to another
 *   parent, so changing `parent_id` later changes nothing, and a deleted branch is `missing` (re-created by the
 *   next apply, from the parent as it is then).
 * - Outputs: the branch id, and its connection string (sensitive), read from the credentials endpoint on every run
 *   (XA6), so dependents in later runs get it too.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError, canonicalJson, markerKind, sha256, type AdapterContext, type Literal, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
// Only the stable authoring API exported from `@sponson/adapters` (listed in CONTRIBUTING.md).
import { assertNoPending, clientFor, deleteIgnoringNotFound, optionalEnv, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isObject, records, type ApiClient } from "./http.js";

const ADAPTER = "xata";
/** The environment Xata reads; declared once, used by the code below and by the generated docs (`about`). */
const ABOUT = { credentialEnv: "XATA_API_KEY", baseUrlEnv: "XATA_API_URL" } as const;

/** Xata's API base URL (XA1). `XATA_API_URL` overrides it; tests and scenarios point that at the sim. */
export const XATA_DEFAULT_API_URL = "https://api.xata.tech";

/** How often a new branch is polled, and for how long (milliseconds; overridable for tests). */
const POLL_MS = { env: "SPONSON_XATA_POLL_MS", fallback: 2000 };
const READY_TIMEOUT_MS = { env: "SPONSON_XATA_READY_TIMEOUT_MS", fallback: 10 * 60 * 1000 };

function msFromEnv(env: NodeJS.ProcessEnv, s: { env: string; fallback: number }): number {
  const raw = optionalEnv(env, s.env);
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : s.fallback;
}

interface Client {
  api: ApiClient;
  /** `/organizations/<org>/projects/<project>/branches`. */
  base: string;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, ADAPTER);
  const org = requireProvider(actx, "organization", ADAPTER);
  const project = requireProvider(actx, "project", ADAPTER);
  const api = clientFor(actx, ADAPTER, { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? XATA_DEFAULT_API_URL, token });
  return { api, base: `/organizations/${enc(org)}/projects/${enc(project)}/branches` };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

interface Branch {
  id: string;
  name: string;
}

const PREFIX = "branch:";

function branchRecord(b: Branch): ResourceRecord {
  return { key: `${PREFIX}${b.name}`, id: b.id, hash: sha256(canonicalJson({ name: b.name })), label: `Xata branch ${b.name}` };
}

/** The branch named `name`, or null (XA3: names are not unique, so more than one is refused, never guessed). */
async function findBranch(c: Client, name: string): Promise<Branch | null> {
  const list = await c.api.get(c.base, (b) => {
    if (!isObject(b)) throw new ShapeError("expected `{ branches }`");
    return records(b.branches, "`branches`", ["id", "name"]);
  });
  const hits = list.filter((b) => b.name === name);
  if (hits.length > 1) throw paramError(ADAPTER, `${hits.length} branches are named ${name} in the project; rename one or give this line another name`, "name");
  return hits[0] ? { id: hits[0].id, name: hits[0].name } : null;
}

/** The connection string from the credentials endpoint (XA6). */
async function connectionString(c: Client, id: string): Promise<string> {
  return c.api.get(`${c.base}/${enc(id)}/credentials?username=xata`, (b) => {
    if (!isObject(b) || typeof b.connectionString !== "string" || b.connectionString === "") throw new ShapeError("expected `{ connectionString }`");
    return b.connectionString;
  });
}

async function outputsOf(c: Client, b: Branch): Promise<Record<string, Literal>> {
  return { branch_id: b.id, connection_string: await connectionString(c, b.id) };
}

/** `status.statusType` of a branch (XA5), or "" when the answer has none yet. */
function statusType(body: unknown): string {
  const status = isObject(body) ? body.status : undefined;
  return isObject(status) && typeof status.statusType === "string" ? status.statusType : "";
}

/** Poll the branch until it is healthy (XA5); FAULT fails, a timeout is WAIT_TIMEOUT that the next run resumes. */
async function waitHealthy(actx: AdapterContext, c: Client, b: Branch): Promise<void> {
  const deadline = Date.now() + msFromEnv(actx.env, READY_TIMEOUT_MS);
  for (;;) {
    const type = statusType(await c.api.get(`${c.base}/${enc(b.id)}`));
    if (/HEALTHY$/.test(type)) return;
    if (/FAULT$/.test(type)) throw new SponsonError("PROVIDER_INVALID", `xata: branch ${b.name} reports ${type} while coming up`, { adapter: ADAPTER, branch: b.name });
    if (Date.now() > deadline) {
      throw new SponsonError("WAIT_TIMEOUT", `xata: branch ${b.name} is not healthy after ${msFromEnv(actx.env, READY_TIMEOUT_MS)}ms (${READY_TIMEOUT_MS.env}); run again to keep waiting`, { adapter: ADAPTER, branch: b.name });
    }
    actx.log(`branch ${b.name} not healthy yet (${type || "no status"})`);
    await sleep(msFromEnv(actx.env, POLL_MS));
  }
}

const branch: OpSpec = {
  outputs: { branch_id: { available: "immediate" }, connection_string: { available: "immediate", sensitive: true } },

  async read(actx, params) {
    if (markerKind(params.name) !== null) return null;
    const c = client(actx);
    const found = await findBranch(c, stringParam(params, "name", ADAPTER));
    if (!found) return null;
    return { resources: [branchRecord(found)], outputs: await outputsOf(c, found) };
  },

  diff(live, params) {
    const name = params.name;
    const key = markerKind(name) !== null ? `${PREFIX}(pending)` : `${PREFIX}${String(name)}`;
    const label = `Xata branch ${String(name)}`;
    if (live?.resources.some((r) => r.key === key)) return [{ key, kind: "unchanged", label }];
    const parent = params.parent_id;
    const after = markerKind(parent) !== null ? { state: "pending" as const, ref: String(parent) } : { state: "literal" as const, value: `child of ${String(parent)}` };
    return [{ key, kind: "create", label, before: { state: "absent" }, after }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const name = stringParam(params, "name", ADAPTER);
    const parent = stringParam(params, "parent_id", ADAPTER);
    const key = `${PREFIX}${name}`;
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: live.outputs, created: [] };
    const c = client(actx);
    // Announce the create before sending it; a create whose answer was lost is found by name next time (XA3).
    await actx.intend([key]);
    actx.log(`create branch ${name} from ${parent}`);
    const created = await c.api.post(c.base, { mode: "inherit", parentID: parent, name }, (b) => {
      const [r] = records([b], "the branch", ["id", "name"]);
      return { id: r!.id, name: r!.name };
    });
    await waitHealthy(actx, c, created);
    return { resources: [branchRecord(created)], outputs: await outputsOf(c, created), created: [key] };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    // An intent the engine could not locate has no id: nothing is deleted on a guess (names are not unique, XA3).
    for (const r of resources) if (r.id !== "") await deleteIgnoringNotFound(c.api, `${c.base}/${enc(r.id)}`);
  },
};

/**
 * The Xata adapter (`adapter: xata` in a plan). Registered in `createRegistry()`; needs `XATA_API_KEY` and
 * `providers.xata.organization` and `.project`.
 */
export const xataAdapter: ResourceAdapter = { name: ADAPTER, ops: { branch }, about: ABOUT };
