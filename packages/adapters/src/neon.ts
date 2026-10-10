import { canonicalJson, isPendingMarker, sha256, type AdapterContext, type LiveState, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { ABSENT, assertNoPending, clientFor, deleteIgnoringNotFound, desiredSide, optionalEnv, paramError, requireEnv, requireProvider, stringParam } from "./common.js";
import { ShapeError, isProviderError, listAll, obj, records, type ApiClient, type Page } from "./http.js";

/** Neon's API base URL; `NEON_API_URL` overrides it (the sim and tests use that). */
export const NEON_DEFAULT_API_URL = "https://console.neon.tech/api/v2";

interface NeonBranch {
  id: string;
  name: string;
  parent_id: string | null;
  /** The project's root branch (`primary` in older API versions). */
  default?: boolean;
  primary?: boolean;
}

interface Client {
  api: ApiClient;
  project: string;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, "NEON_API_KEY", "neon");
  const project = requireProvider(actx, "project", "neon");
  return { api: clientFor(actx, "neon", { baseUrl: optionalEnv(actx.env, "NEON_API_URL") ?? NEON_DEFAULT_API_URL, token }), project };
}

function branchKey(name: string): string {
  return `${BRANCH_PREFIX}${name}`;
}

const BRANCH_PREFIX = "branch:";

/** Identity hash: name and parent, the two things that define a branch for us. A replacement shows as a new provider id. */
function branchHash(b: { name: string; parent_id: string | null }): string {
  return sha256(canonicalJson({ name: b.name, parent_id: b.parent_id }));
}

function record(b: NeonBranch): ResourceRecord {
  return { key: branchKey(b.name), id: b.id, hash: branchHash(b), label: `Neon branch ${b.name}` };
}

function parseBranches(v: unknown, what: string): NeonBranch[] {
  return records(v, what, ["id", "name"]).map((b, i) => {
    if (b.parent_id !== undefined && b.parent_id !== null && typeof b.parent_id !== "string") throw new ShapeError(`expected ${what}[${i}].parent_id to be a string or null`);
    return { id: b.id, name: b.name, parent_id: (b.parent_id as string | null | undefined) ?? null, default: b.default === true, primary: b.primary === true };
  });
}

/** `{ branches, pagination: { next } }`; the next page is `?cursor=<next>`. Older responses call it `cursor`. */
function branchPage(body: unknown): Page<NeonBranch> {
  const o = obj(body, "the branch list");
  const items = parseBranches(o.branches, "`branches`");
  const p = o.pagination;
  const cursor = p && typeof p === "object" ? ((p as Record<string, unknown>).next ?? (p as Record<string, unknown>).cursor) : undefined;
  return { items, next: typeof cursor === "string" && cursor !== "" ? { cursor } : null };
}

async function listBranches(c: Client): Promise<NeonBranch[]> {
  return listAll(c.api, `/projects/${c.project}/branches`, branchPage);
}

async function outputsFor(c: Client, b: NeonBranch): Promise<LiveState["outputs"]> {
  const host = await c.api.get(`/projects/${c.project}/branches/${b.id}/endpoints`, (body) => {
    const h = records(obj(body, "the endpoint list").endpoints, "`endpoints`", ["id", "host"])[0]?.host;
    if (!h) throw new ShapeError(`branch ${b.name} has no endpoint`);
    return h;
  });
  const q = new URLSearchParams({ branch_id: b.id, database_name: "neondb", role_name: "neondb_owner" });
  const uri = await c.api.get(`/projects/${c.project}/connection_uri?${q}`, (body) => {
    const o = obj(body, "the connection URI");
    if (typeof o.uri !== "string") throw new ShapeError("expected `uri` to be a string");
    return o.uri;
  });
  return { branch_id: b.id, connection_string: uri, host };
}

interface Created {
  branch: NeonBranch;
  host?: string;
  uri?: string;
}

function parseCreated(body: unknown): Created {
  const o = obj(body, "the create-branch response");
  const branch = parseBranches([o.branch], "`branch`")[0]!;
  const endpoints = Array.isArray(o.endpoints) ? records(o.endpoints, "`endpoints`", ["host"]) : [];
  const uris = Array.isArray(o.connection_uris) ? records(o.connection_uris, "`connection_uris`", ["connection_uri"]) : [];
  return { branch, ...(endpoints[0] ? { host: endpoints[0].host } : {}), ...(uris[0] ? { uri: uris[0].connection_uri } : {}) };
}

const branch: OpSpec = {
  outputs: {
    branch_id: { available: "immediate" },
    connection_string: { available: "immediate", sensitive: true },
    host: { available: "immediate" },
  },

  defaults(params, ctx) {
    return { parent: "main", name: `sponson/${ctx.env}/${ctx.scope}`, ...params };
  },

  async read(actx, params) {
    if (isPendingMarker(params.name)) return null;
    const c = client(actx);
    const name = stringParam(params, "name", "neon");
    const found = (await listBranches(c)).find((b) => b.name === name);
    if (!found) return null;
    return { resources: [record(found)], outputs: await outputsFor(c, found) };
  },

  diff(live, params) {
    const name = params.name;
    if (isPendingMarker(name)) return [{ key: "branch:(pending)", kind: "create", label: "Neon branch", before: ABSENT, after: desiredSide(name, false) }];
    const key = branchKey(String(name));
    const current = live?.resources.find((r) => r.key === key);
    // A branch's identity is its name; re-parenting is not supported, so an existing branch is unchanged whatever `parent` says.
    if (current) return [{ key, kind: "unchanged", label: current.label ?? key }];
    return [{ key, kind: "create", label: `Neon branch ${String(name)}`, before: ABSENT, after: desiredSide(name, false) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, "neon");
    const c = client(actx);
    const name = stringParam(params, "name", "neon");
    const key = branchKey(name);
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: live.outputs, created: [] };

    const parentName = stringParam(params, "parent", "neon", "main");
    const branches = await listBranches(c);
    const parent = branches.find((b) => b.name === parentName || b.id === parentName);
    if (!parent) throw paramError("neon", `parent branch \`${parentName}\` not found in project ${c.project}`, "parent");

    await actx.intend([key]);
    actx.log(`create branch ${name} from ${parent.name}`);
    let r: Created;
    try {
      r = await c.api.post(`/projects/${c.project}/branches`, { branch: { name, parent_id: parent.id }, endpoints: [{ type: "read_write" }] }, parseCreated);
    } catch (e) {
      if (!isProviderError(e, "PROVIDER_CONFLICT")) throw e;
      // It exists already (a lost response of ours, or someone else's). Not created by this call; the engine
      // claims it when an earlier intent of ours named it.
      const found = (await listBranches(c)).find((b) => b.name === name);
      if (!found) throw e;
      return { resources: [record(found)], outputs: await outputsFor(c, found), created: [] };
    }
    // Trust the write's answer: listing right after a create may not show it yet.
    const outputs = r.host && r.uri ? { branch_id: r.branch.id, connection_string: r.uri, host: r.host } : await outputsFor(c, r.branch);
    return { resources: [record(r.branch)], outputs, created: [key] };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(c.api, `/projects/${c.project}/branches/${encodeURIComponent(r.id)}`);
  },

  /** Every branch but the project's root: anything else may be a preview branch some scope (or nobody) manages. */
  async listScope(actx) {
    const c = client(actx);
    return (await listBranches(c)).filter((b) => !b.default && !b.primary).map(record);
  },

  /** One line per branch, naming it: the line then manages exactly that branch. */
  adopt(resources) {
    return resources.map((r) => {
      const name = r.key.slice(BRANCH_PREFIX.length);
      return { id: `db-${name}`, params: { name }, keys: [r.key] };
    });
  },
};

/**
 * Neon: op `branch` creates a database branch per scope and outputs its connection string (sensitive). Needs
 * `NEON_API_KEY` and `providers.neon.project`.
 */
export const neonAdapter: ResourceAdapter = { name: "neon", ops: { branch } };
