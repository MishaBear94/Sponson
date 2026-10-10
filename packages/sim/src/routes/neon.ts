/**
 * Simulated Neon: branches, their endpoints, databases and connection strings.
 *
 * Assumptions about the real API that this fake encodes, each marked with how far it is checked. "Verified" means
 * against Neon's published OpenAPI document (https://neon.tech/api_spec/release/v2.json, fetched 2026-10-10); see
 * docs/api-verification.md:
 *   N1. Branch deletion is synchronous here: the branch is gone when DELETE returns. Contradicted in part: the
 *       spec says "the deletion completes after all operations finish" and DELETE answers with `operations`.
 *       Whether the list still shows the branch meanwhile is unverified: needs a live account.
 *   N2. Branch creation runs async operations (verified: the create answer carries `operations`): for chaos
 *       `neon_op_ms` (default 0) after a create, further creates in the project and writes to the new branch
 *       answer 423 Locked, which the spec documents as safe to retry (verified). Which requests are locked, and
 *       that the endpoint is usable at once, are unverified: needs a live account.
 *   N3. A root branch has one database `neondb` owned by role `neondb_owner` (a new project's defaults); a child
 *       copies its parent's. The adapter no longer relies on these names: it reads them from
 *       GET /projects/:id/branches/:id/databases (verified), and connection_uri requires both (verified).
 *       Branches carry `default: true` on the project's root branch (verified; `primary` is deprecated).
 *   N4. Pagination (chaos `page_size`): `{ branches, pagination: { next } }` with `?cursor=`, cursors opaque
 *       (verified: CursorPagination). Without `limit` the list is not paged here; the spec says a paged read
 *       starts with `limit`, and the adapter follows `next` either way.
 *   N5. Creating a branch whose name exists answers 409. Unverified: the spec documents only the generic error.
 */
import { page, Reply, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One simulated Neon branch. */
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
  /** The branch's one database and the role owning it; a child branch copies its parent's. */
  database: { name: string; owner_name: string };
  createdAt: number;
  createdBy: CreatedBy;
}

/** One simulated Neon project and its branches. */
export interface NeonProject {
  branches: NeonBranch[];
  /** A branch create's operations are running until this time: further creates answer 423. */
  opUntil: number;
}

/** Simulated Neon: projects by id. */
export interface NeonState {
  projects: Record<string, NeonProject>;
}

/** Initial Neon state. */
export interface NeonSeed {
  projects: Record<string, { branches: Array<{ name: string; parent?: string }> }>;
}

/** Simulated Neon (projects, branches, operations); see the assumptions at the top of this file. */
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
      if (!p) return notFound("project");
      if (method === "GET") {
        const pg = page(core, p.branches, url.searchParams.get("cursor"));
        return new Reply(200, { branches: pg.items.map(publicBranch), pagination: pg.next === null ? {} : { next: String(pg.next) } });
      }
      if (method === "POST") {
        if (Date.now() < p.opUntil) return locked();
        const b = (body ?? {}) as { branch?: { name?: string; parent_id?: string } };
        const name = b.branch?.name;
        if (!name) return new Reply(400, { code: "", message: "branch.name required" });
        if (p.branches.some((x) => x.name === name)) return new Reply(409, { code: "", message: "branch already exists" });
        const parentId = b.branch?.parent_id ?? null;
        if (parentId && !p.branches.some((x) => x.id === parentId)) return notFound("parent branch");
        const branch = createBranch(core, p, name, parentId, "api");
        if (core.chaos.neon_op_ms > 0) branch.opUntil = p.opUntil = Date.now() + core.chaos.neon_op_ms;
        // CreatedBranch: branch, endpoints, operations, roles, databases and (one database and role) connection_uris.
        return new Reply(201, {
          branch: publicBranch(branch),
          endpoints: [publicEndpoint(branch)],
          operations: [{ id: core.nextId("op-"), branch_id: branch.id, action: "create_branch", status: core.chaos.neon_op_ms > 0 ? "running" : "finished" }],
          roles: [{ branch_id: branch.id, name: branch.database.owner_name }],
          databases: [publicDatabase(branch)],
          connection_uris: [{ connection_uri: connectionUri(branch), connection_parameters: { database: branch.database.name, role: branch.database.owner_name, host: branch.endpoint.host } }],
        });
      }
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)\/endpoints$/)) && method === "GET") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === m![2]);
      if (!p || !b) return notFound("branch");
      return new Reply(200, { endpoints: [publicEndpoint(b)] });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)\/databases$/)) && method === "GET") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === m![2]);
      if (!p || !b) return notFound("branch");
      return new Reply(200, { databases: [publicDatabase(b)] });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/connection_uri$/)) && method === "GET") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === url.searchParams.get("branch_id"));
      if (!p || !b) return notFound("branch");
      // Both are required query parameters in the spec.
      const database = url.searchParams.get("database_name");
      const role = url.searchParams.get("role_name");
      if (!database || !role) return new Reply(400, { code: "", message: "database_name and role_name are required" });
      if (database !== b.database.name) return notFound(`database ${database}`);
      if (role !== b.database.owner_name) return notFound(`role ${role}`);
      return new Reply(200, { uri: connectionUri(b) });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/branches\/([^/]+)$/)) && method === "DELETE") {
      const p = state.projects[m[1]!];
      const b = p?.branches.find((x) => x.id === m![2]);
      if (!p || !b) return notFound("branch");
      if (Date.now() < b.opUntil) return locked();
      // The real deletion "completes after all operations finish" (assumption N1); the sim removes it at once.
      p.branches = p.branches.filter((x) => x !== b);
      return new Reply(200, { branch: publicBranch(b), operations: [{ id: core.nextId("op-"), branch_id: b.id, action: "delete_timeline", status: "finished" }] });
    }
    return notFound("route");
  },
};

/**
 * Add a branch to a project as Neon would (ids, timestamps, default flag). Tests use it to seed "someone else's"
 * branch.
 */
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
    database: { ...(project.branches.find((b) => b.id === parentId)?.database ?? { name: DATABASE, owner_name: ROLE }) },
    createdAt: Date.now(),
    createdBy,
  };
  project.branches.push(branch);
  return branch;
}

/** A root branch's database and its owner: a new Neon project's defaults. */
const DATABASE = "neondb";
const ROLE = "neondb_owner";

/** The connection string Neon would hand out for a branch. */
export function connectionUri(branch: NeonBranch): string {
  return `postgres://${branch.database.owner_name}:pw_${branch.id}@${branch.endpoint.host}/${branch.database.name}`;
}

function publicEndpoint(b: NeonBranch) {
  return { id: b.endpoint.id, host: b.endpoint.host, branch_id: b.id, type: "read_write" };
}

function publicDatabase(b: NeonBranch) {
  return { id: 1, branch_id: b.id, name: b.database.name, owner_name: b.database.owner_name, created_at: b.created_at, updated_at: b.created_at };
}

/** Neon's GeneralError: `{ code, message }`. */
function notFound(what: string): Reply {
  return new Reply(404, { code: "", message: `${what} not found` });
}

function publicBranch(b: NeonBranch) {
  return { id: b.id, name: b.name, parent_id: b.parent_id, default: b.default, current_state: "ready", created_at: b.created_at };
}

function locked(): Reply {
  return new Reply(423, { code: "", message: "project already has running conflicting operations, scheduling of new ones is prohibited" });
}
