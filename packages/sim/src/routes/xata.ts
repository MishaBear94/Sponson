/**
 * Simulated Xata (the Postgres platform): branches of projects, created as copy-on-write children of a parent.
 *
 * Assumptions about the real API this fake encodes, checked against the official OpenAPI document
 * (https://api.xata.tech/openapi.json) and the docs (https://xata.io/docs) unless marked unverified. The critical
 * ones are pinned in scenarios/contract.test.ts (`assumption XA…`).
 *   XA1. The API is served at `https://api.xata.tech`, authenticated with an API key as `Authorization: Bearer`;
 *        the CLI reads it from `XATA_API_KEY`. (verified: spec security scheme; https://xata.io/docs/cli)
 *   XA2. `POST /organizations/{org}/projects/{project}/branches` with `{ mode: "inherit", parentID, name }`
 *        creates a copy-on-write child of the parent branch (by id) and answers 201 with the branch, bare:
 *        `{ id, name, parentID, region, createdAt, … }`. (verified: spec)
 *   XA3. `GET` of the same path answers `{ branches: [{ id, name, parentID, … }] }`, unpaginated. Names are not
 *        documented as unique and the create documents no 409, so a lookup by name may find more than one.
 *        (verified: spec; uniqueness unverified)
 *   XA4. `GET …/branches/{branchID}` answers the branch with `status: { statusType, … }`, and 404 when it does
 *        not exist; `DELETE` on the same path removes it permanently (204; 404 when gone). (verified: spec)
 *   XA5. A new branch "takes a moment to come up"; it is ready when `statusType` is healthy and broken when it is
 *        a fault (`STATUS_TYPE_HEALTHY`, `STATUS_TYPE_FAULT`; the adapter matches the suffix). (verified: the CLI's
 *        `branch wait-ready`, https://xata.io/docs/cli/branch; the exact enum spelling is unverified)
 *   XA6. `GET …/branches/{branchID}/credentials?username=xata` answers `{ username, password, hostname, port,
 *        dbname, connectionString }`, readable at any time (not only after the create). (verified: spec and
 *        https://xata.io/docs/platform/branch; "any time" inferred from it being a plain GET)
 *   XA7. A branch is ready within minutes, usually seconds (unverified: the adapter waits up to
 *        SPONSON_XATA_READY_TIMEOUT_MS, ten minutes by default).
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** A branch as the simulated Xata stores it. */
export interface XataBranch {
  id: string;
  name: string;
  parentID: string | null;
  password: string;
  /** GETs of the branch that still answer a transient status before it is healthy. */
  pending: number;
  createdBy: CreatedBy;
}

/** The simulated Xata's state: branches per `<org>/<project>`. */
export interface XataState {
  projects: Record<string, { branches: XataBranch[] }>;
  /** GETs of a new branch that answer a transient status (default 1). */
  readyPolls: number;
}

/** What a scenario or test seeds the simulated Xata with (`seed: { xata: … }`). */
export interface XataSeed {
  /** `<org>/<project>` → branches that exist already (unmanaged), by id and name. */
  projects?: Record<string, Array<{ id: string; name: string }>>;
  readyPolls?: number;
}

/** The simulated Xata API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/xata`. */
export const xataSim: ProviderSim<XataState, XataSeed> = {
  env: { token: "XATA_API_KEY", url: "XATA_API_URL", testToken: "tok_xata" },
  defaultSeed: { projects: { "acme/app": [{ id: "br_main", name: "main" }] } },

  reset(core, seed) {
    const projects: XataState["projects"] = {};
    for (const [key, list] of Object.entries(seed?.projects ?? {})) {
      projects[key] = { branches: list.map((b) => ({ id: b.id, name: b.name, parentID: null, password: password(core), pending: 0, createdBy: "sim" })) };
    }
    return { projects, readyPolls: seed?.readyPolls ?? 1 };
  },

  /** `branch.<name>`: "delete" — what a human in the Xata console would do. */
  drift(_core, state, { key, rest, value, only }) {
    if (only !== undefined || !rest.startsWith("branch.")) return false;
    const name = rest.slice("branch.".length);
    if (value !== "delete") throw new Error(`drift ${key}: only "delete" is supported`);
    let hit = false;
    for (const p of Object.values(state.projects)) {
      const before = p.branches.length;
      p.branches = p.branches.filter((b) => b.name !== name);
      hit ||= p.branches.length < before;
    }
    if (!hit) throw new Error(`drift ${key}: no branch ${name}`);
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function password(core: SimCore): string {
  return `xata_pw_sim_${core.nextId("")}`;
}

/** The connection string of a branch (XA6), as the sim makes it up. */
export function xataConnectionString(b: XataBranch): string {
  return `postgresql://xata:${b.password}@${b.id}.us-east-1.sim.xata.tech:5432/xata?sslmode=require`;
}

function publicBranch(b: XataBranch): Record<string, unknown> {
  return { id: b.id, name: b.name, parentID: b.parentID, region: "us-east-1", publicAccess: false };
}

type BranchParams = { org: string; project: string; id: string };

function find(state: XataState, p: BranchParams): XataBranch | undefined {
  return state.projects[`${p.org}/${p.project}`]?.branches.find((b) => b.id === p.id);
}

const notFound = () => new Reply(404, { id: "not_found", message: "branch not found" });

const routes = router<XataState>(
  [
    // A token check (`sponson init --setup`): the organizations the key reaches.
    route("GET", "/organizations", ({ state }) => new Reply(200, { organizations: [...new Set(Object.keys(state.projects).map((k) => k.split("/")[0]!))].map((id) => ({ id, name: id })) })),

    route("GET", "/organizations/:org/projects/:project/branches", ({ state, params }) => {
      const p = state.projects[`${params.org}/${params.project}`];
      return p ? new Reply(200, { branches: p.branches.map(publicBranch) }) : new Reply(404, { id: "not_found", message: "project not found" });
    }),

    route("POST", "/organizations/:org/projects/:project/branches", ({ core, state, params, body }) => {
      const p = state.projects[`${params.org}/${params.project}`];
      if (!p) return new Reply(404, { id: "not_found", message: "project not found" });
      const b = (body ?? {}) as { mode?: unknown; parentID?: unknown; name?: unknown };
      if (b.mode !== "inherit" || typeof b.name !== "string" || b.name === "" || typeof b.parentID !== "string") return new Reply(400, { id: "bad_request", message: "mode inherit, parentID and name are required" });
      if (!p.branches.some((x) => x.id === b.parentID)) return new Reply(404, { id: "not_found", message: "parent branch not found" });
      const created: XataBranch = { id: core.nextId("br_"), name: b.name, parentID: b.parentID, password: password(core), pending: state.readyPolls, createdBy: "api" };
      p.branches.push(created);
      return new Reply(201, publicBranch(created));
    }),

    route("GET", "/organizations/:org/projects/:project/branches/:id", ({ state, params }) => {
      const b = find(state, params);
      if (!b) return notFound();
      const transient = b.pending > 0;
      if (transient) b.pending--;
      return new Reply(200, { ...publicBranch(b), status: { statusType: transient ? "STATUS_TYPE_TRANSIENT" : "STATUS_TYPE_HEALTHY", instanceCount: 1, instanceReadyCount: transient ? 0 : 1 } });
    }),

    route("GET", "/organizations/:org/projects/:project/branches/:id/credentials", ({ state, params }) => {
      const b = find(state, params);
      if (!b) return notFound();
      return new Reply(200, { username: "xata", password: b.password, hostname: `${b.id}.us-east-1.sim.xata.tech`, port: 5432, dbname: "xata", connectionString: xataConnectionString(b) });
    }),

    route("DELETE", "/organizations/:org/projects/:project/branches/:id", ({ state, params }) => {
      const p = state.projects[`${params.org}/${params.project}`];
      const b = find(state, params);
      if (!p || !b) return notFound();
      p.branches = p.branches.filter((x) => x !== b);
      return new Reply(204, null);
    }),
  ],
  notFound,
);
