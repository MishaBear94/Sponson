import { canonicalJson, isPendingMarker, sha256, type AdapterContext, type LiveState, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { assertNoPending, deleteIgnoringNotFound, diffValue, requireEnv, requireProvider, stringParam } from "./common.js";
import { apiClient, type ApiClient } from "./http.js";

export const NEON_DEFAULT_API_URL = "https://console.neon.tech/api/v2";
/** Branches Sponson creates live under this prefix; listScope only reports these so `main` never shows as unmanaged. */
export const NEON_MANAGED_PREFIX = "sponson/";

interface NeonBranch {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

interface Client {
  api: ApiClient;
  project: string;
}

function client(actx: AdapterContext): Client {
  const token = requireEnv(actx.env, "NEON_API_KEY", "neon");
  const project = requireProvider(actx, "project", "neon");
  return { api: apiClient({ baseUrl: actx.env.NEON_API_URL || NEON_DEFAULT_API_URL, token }), project };
}

function branchKey(name: string): string {
  return `branch:${name}`;
}

/** Identity hash: name and parent, the two things that define a branch for us. */
function branchHash(b: { name: string; parent_id: string | null }): string {
  return sha256(canonicalJson({ name: b.name, parent_id: b.parent_id }));
}

function record(b: NeonBranch): ResourceRecord {
  return { key: branchKey(b.name), id: b.id, hash: branchHash(b), label: `Neon branch ${b.name}` };
}

async function listBranches(c: Client): Promise<NeonBranch[]> {
  const r = await c.api.get<{ branches: NeonBranch[] }>(`/projects/${c.project}/branches`);
  return r.branches;
}

async function outputsFor(c: Client, b: NeonBranch): Promise<LiveState["outputs"]> {
  const ep = await c.api.get<{ endpoints: Array<{ id: string; host: string }> }>(`/projects/${c.project}/branches/${b.id}/endpoints`);
  const host = ep.endpoints[0]?.host;
  if (!host) throw new Error(`neon: branch ${b.name} has no endpoint`);
  const q = new URLSearchParams({ branch_id: b.id, database_name: "neondb", role_name: "neondb_owner" });
  const uri = await c.api.get<{ uri: string }>(`/projects/${c.project}/connection_uri?${q}`);
  return { branch_id: b.id, connection_string: uri.uri, host };
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
    const name = stringParam(params, "name");
    const found = (await listBranches(c)).find((b) => b.name === name);
    if (!found) return null;
    return { resources: [record(found)], outputs: await outputsFor(c, found) };
  },

  diff(live, params) {
    const name = params.name;
    if (isPendingMarker(name)) return [diffValue({ key: "branch:(pending)", label: "Neon branch", live: undefined, desired: name, sensitive: false })];
    const key = branchKey(String(name));
    const current = live?.resources.find((r) => r.key === key);
    // A branch's identity is its name; re-parenting is not supported, so an existing branch is unchanged whatever `parent` says.
    if (current) return [{ key, kind: "unchanged", label: current.label ?? key }];
    return [{ key, kind: "create", label: `Neon branch ${String(name)}`, after: String(name) }];
  },

  async apply(actx, params, live) {
    assertNoPending(params, "neon");
    const c = client(actx);
    const name = stringParam(params, "name");
    const existing = live?.resources.find((r) => r.key === branchKey(name));
    if (existing && live) return { resources: live.resources, outputs: live.outputs, created: [] };

    const parentName = stringParam(params, "parent", "main");
    const branches = await listBranches(c);
    const parent = branches.find((b) => b.name === parentName || b.id === parentName);
    if (!parent) throw new Error(`neon: parent branch \`${parentName}\` not found in project ${c.project}`);

    actx.log(`create branch ${name} from ${parent.name}`);
    const r = await c.api.post<{ branch: NeonBranch; endpoints: Array<{ id: string; host: string }>; connection_uris: Array<{ connection_uri: string }> }>(
      `/projects/${c.project}/branches`,
      { branch: { name, parent_id: parent.id }, endpoints: [{ type: "read_write" }] },
    );
    const host = r.endpoints[0]?.host;
    const uri = r.connection_uris[0]?.connection_uri;
    const outputs = host && uri ? { branch_id: r.branch.id, connection_string: uri, host } : await outputsFor(c, r.branch);
    return { resources: [record(r.branch)], outputs, created: [branchKey(name)] };
  },

  async destroy(actx, resources) {
    const c = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(c.api, `/projects/${c.project}/branches/${r.id}`);
  },

  async listScope(actx) {
    const c = client(actx);
    return (await listBranches(c)).filter((b) => b.name.startsWith(NEON_MANAGED_PREFIX)).map(record);
  },
};

export const neonAdapter: ResourceAdapter = { name: "neon", ops: { branch } };
