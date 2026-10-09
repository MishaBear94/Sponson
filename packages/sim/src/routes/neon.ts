/**
 * Simulated Neon: branches, their endpoints and connection strings.
 *
 * Assumptions about the real API that this fake encodes and that are most likely wrong (see vercel.ts for how
 * they are checked):
 *   N1. Branch deletion is synchronous; the branch is gone when DELETE returns.
 *   N2. Branch creation runs async operations: for chaos `neon_op_ms` (default 0) after a create, further
 *       creates in the project and writes to the new branch answer 423 Locked. The endpoint is usable at once.
 *   N3. Connection strings use database `neondb` and role `neondb_owner`, the defaults of a new project.
 *       Branches carry `default: true` on the project's root branch.
 *   N4. Pagination (chaos `page_size`): `{ branches, pagination: { next } }` with `?cursor=`. Cursors are opaque
 *       to the client.
 */
import { page, Reply, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

export interface NeonBranch {
  id: string;
  name: string;
  parent_id: string | null;
  /** The project's root branch (Neon's `default`, formerly `primary`). */
  default: boolean;
  /** Async operations started by the create are running until this time: writes to the branch answer 423. */
  opUntil: number;
  created_at: string;
  endpoint: { id: string; host: string };
  createdAt: number;
  createdBy: CreatedBy;
}

export interface NeonProject {
  branches: NeonBranch[];
  /** A branch create's operations are running until this time: further creates answer 423. */
  opUntil: number;
}

export interface NeonState {
  projects: Record<string, NeonProject>;
}

export interface NeonSeed {
  projects: Record<string, { branches: Array<{ name: string; parent?: string }> }>;
}

export const neonSim: ProviderSim<NeonState, NeonSeed> = {
  env: { token: "NEON_API_KEY", url: "NEON_API_URL", testToken: "tok_neon" },
  defaultSeed: { projects: { proj_demo: { branches: [{ name: "main" }] } } },

  reset(core, seed) {
    const state: NeonState = { projects: {} };
    for (const [id, p] of Object.entries(seed?.projects ?? {})) {
      const project: NeonProject = { branches: [], opUntil: 0 };
      state.projects[id] = project;
      for (const b of p.branches) {
        const parent = b.parent ? project.branches.find((x) => x.name === b.parent) : undefined;
        const branch = createBranch(core, project, b.name, parent?.id ?? null, "sim");
        // The first root branch is the project's default, like the one Neon creates with the project.
        if (!branch.parent_id && !project.branches.some((x) => x.default)) branch.default = true;
      }
    }
    return state;
  },

  /** `branch.<name>`: "delete" | "recreate". */
  drift(core, state, { key, rest, value, only }) {
    if (!rest.startsWith("branch.")) return false;
    const name = rest.slice("branch.".length);
    if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported`);
    for (const [id, p] of Object.entries(state.projects)) {
      if (only !== undefined && id !== only) continue;
      const hit = p.branches.filter((b) => b.name === name);
      p.branches = p.branches.filter((b) => !hit.includes(b));
      if (value === "recreate") for (const b of hit) createBranch(core, p, b.name, b.parent_id, "sim");
    }
    return true;
  },

  routes(core, state, { method, url, path, body }) {
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/projects\/([^/]+)\/branches$/))) {
      const p = state.projects[m[1]!];
      if (!p) return new Reply(404, { error: "project not found" });
      if (method === "GET") {
        const pg = page(core, p.branches, url.searchParams.get("cursor"));
        return new Reply(200, { branches: pg.items.map(publicBranch), pagination: pg.next === null ? {} : { next: String(pg.next) } });
      }
      if (method === "POST") {
        if (Date.now() < p.opUntil) return locked();
        const b = (body ?? {}) as { branch?: { name?: string; parent_id?: string } };
        const name = b.branch?.name;
        if (!name) return new Reply(400, { error: "branch.name required" });
        if (p.branches.some((x) => x.name === name)) return new Reply(409, { code: "", message: "branch already exists" });
        const parentId = b.branch?.parent_id ?? null;
        if (parentId && !p.branches.some((x) => x.id === parentId)) return new Reply(404, { error: "parent branch not found" });
        const branch = createBranch(core, p, name, parentId, "api");
        if (core.chaos.neon_op_ms > 0) branch.opUntil = p.opUntil = Date.now() + core.chaos.neon_op_ms;
        return new Reply(201, {
          branch: publicBranch(branch),
          endpoints: [{ id: branch.endpoint.id, host: branch.endpoint.host }],
          connection_uris: [{ connection_uri: connectionUri(branch) }],
        });
      }
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)\/endpoints$/)) && method === "GET") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === m![2]);
      if (!p || !b) return new Reply(404, { error: "branch not found" });
      return new Reply(200, { endpoints: [{ id: b.endpoint.id, host: b.endpoint.host }] });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/connection_uri$/)) && method === "GET") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === url.searchParams.get("branch_id"));
      if (!p || !b) return new Reply(404, { error: "branch not found" });
      return new Reply(200, { uri: connectionUri(b) });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)$/)) && method === "DELETE") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === m![2]);
      if (!p || !b) return new Reply(404, { error: "branch not found" });
      if (Date.now() < b.opUntil) return locked();
      p.branches = p.branches.filter((x) => x !== b);
      return new Reply(200, { branch: { id: b.id, name: b.name } });
    }
    return new Reply(404, { error: "not found" });
  },
};

export function createBranch(core: SimCore, project: NeonProject, name: string, parentId: string | null, createdBy: CreatedBy): NeonBranch {
  const id = core.nextId("br-");
  const branch: NeonBranch = {
    id,
    name,
    parent_id: parentId,
    default: false,
    opUntil: 0,
    created_at: new Date().toISOString(),
    endpoint: { id: core.nextId("ep-"), host: `${id}.sim.neon.tech` },
    createdAt: Date.now(),
    createdBy,
  };
  project.branches.push(branch);
  return branch;
}

export function connectionUri(branch: NeonBranch): string {
  return `postgres://neondb_owner:pw_${branch.id}@${branch.endpoint.host}/neondb`;
}

function publicBranch(b: NeonBranch) {
  return { id: b.id, name: b.name, parent_id: b.parent_id, default: b.default, created_at: b.created_at };
}

function locked(): Reply {
  return new Reply(423, { code: "", message: "project already has running conflicting operations, scheduling of new ones is prohibited" });
}
