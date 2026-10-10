/**
 * Simulated Supabase Management API (https://api.supabase.com/v1): preview branches of a project, and the project's
 * Auth redirect allow-list.
 *
 * Assumptions about the real API that this fake encodes, each marked with how far it is checked. "Verified" means
 * against Supabase's published OpenAPI document (https://api.supabase.com/api/v1-json, fetched 2026-10-11; rendered
 * at https://supabase.com/docs/reference/api/introduction) unless another source is named; see
 * docs/api-verification.md:
 *   S1. POST /v1/projects/{ref}/branches takes `{ branch_name }` (required, the only required field) and answers
 *       201 with a BranchResponse: `id` (uuid), `name` (= branch_name), `project_ref` (the branch's own project),
 *       `parent_project_ref`, `is_default`, `persistent`, `status`, `created_at` (verified: CreateBranchBody,
 *       BranchResponse). That `project_ref` is known in the 201 answer, before provisioning finishes, is implied by
 *       the schema (required) but unverified.
 *   S2. GET /v1/projects/{ref}/branches answers a bare array of BranchResponse, unpaged (verified: no page
 *       parameters, `type: array`). That the list includes the project's own default branch (`is_default: true`,
 *       `project_ref` = the parent) once branching is enabled is unverified; the adapter skips `is_default` either
 *       way and never manages it.
 *   S3. A branch is provisioned asynchronously: GET /v1/branches/{ref} answers BranchDetailResponse whose `status`
 *       (the project status enum) is `COMING_UP` until it is ready and `ACTIVE_HEALTHY` after (verified: schema and
 *       enum). Here this takes chaos `supabase_ready_ms` (default 0). That the detail answers 200 (not 404) while
 *       the branch is coming up, and that `ACTIVE_HEALTHY` is the right "ready" signal, are unverified: needs a
 *       live account. The BranchResponse `status` (CREATING_PROJECT, …) is deprecated in the spec and not used.
 *   S4. The detail carries `db_host`, `db_port` (required), `db_user` and `db_pass` (optional in the spec,
 *       verified). That `db_pass` is returned to a personal access token is unverified (pinned by the contract
 *       suite). The database is `postgres` (Supabase's default database name, verified in the connection docs,
 *       https://supabase.com/docs/guides/database/connecting-to-postgres) and the API URL is
 *       `https://<ref>.supabase.co` (verified: https://supabase.com/docs/guides/api).
 *   S5. Creating a branch whose name exists in the project answers 409. Unverified: the spec documents only 201,
 *       401, 403, 429 and 500. The adapter re-reads the list after a 409, or a 400/422, before reporting it.
 *   S6. DELETE /v1/branches/{ref} answers 200 `{ message: "ok" }` and the branch is gone from the list at once
 *       (verified: BranchDeleteResponse; "by default, deletes immediately"). An unknown ref answers 404:
 *       unverified (the spec documents no 404).
 *   S7. GET /v1/projects/{ref}/config/auth answers the auth config with `uri_allow_list`, a nullable string
 *       (verified: AuthConfigResponse, required); PATCH with `{ uri_allow_list }` alone sets that field and
 *       leaves the others, answering the whole config (verified: UpdateAuthConfigBody has no required field).
 *       PATCH offers no precondition (no ETag or version), verified by its absence from the spec.
 *   S8. The allow-list is comma-separated URLs (verified: Supabase Auth's `URI_ALLOW_LIST`, "a comma separated
 *       list of URIs", https://github.com/supabase/auth#general-config). Whitespace around commas is ignored by
 *       Auth; whether the API stores the string verbatim (here: yes) is unverified.
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One simulated Supabase branch: a project of its own (`project_ref`) under a parent project. */
export interface SupabaseBranch {
  /** The branch id (a uuid in Supabase; deprecated as a path parameter). */
  id: string;
  name: string;
  /** The branch's own project ref: its API URL, database host and the path parameter of GET/DELETE /branches. */
  project_ref: string;
  parent_project_ref: string;
  /** The project's own branch (the one that is the parent project itself). */
  is_default: boolean;
  /** `COMING_UP` until this time, `ACTIVE_HEALTHY` after (chaos `supabase_ready_ms`). */
  readyAt: number;
  db_pass: string;
  created_at: string;
  createdAt: number;
  createdBy: CreatedBy;
}

/** One simulated Supabase project: its branches and its Auth config. */
export interface SupabaseProject {
  branches: SupabaseBranch[];
  auth: { site_url: string; uri_allow_list: string | null };
}

/** The simulated Supabase's state: projects by ref. */
export interface SupabaseState {
  projects: Record<string, SupabaseProject>;
}

/** What a scenario or test seeds the simulated Supabase with (`seed: { supabase: … }`). */
export interface SupabaseSeed {
  /** Project ref → branches that already exist (made "by a human", so unmanaged) and the Auth allow-list. */
  projects: Record<string, { branches?: Array<{ name: string }>; uri_allow_list?: string | null; site_url?: string }>;
}

/** The parent project the default seed creates, a ref of 20 lowercase letters like Supabase's. */
export const SUPABASE_DEMO_PROJECT = "demoprojectrefabcdef";

/** The simulated Supabase Management API, registered in `PROVIDERS` (packages/sim/src/state.ts), served under `/supabase`. */
export const supabaseSim: ProviderSim<SupabaseState, SupabaseSeed> = {
  env: { token: "SUPABASE_ACCESS_TOKEN", url: "SUPABASE_API_URL", testToken: "tok_supabase" },
  defaultSeed: { projects: { [SUPABASE_DEMO_PROJECT]: { uri_allow_list: "http://localhost:3000/**" } } },

  reset(core, seed) {
    const projects: SupabaseState["projects"] = {};
    for (const [ref, p] of Object.entries(seed?.projects ?? {})) {
      const project: SupabaseProject = { branches: [], auth: { site_url: p.site_url ?? "http://localhost:3000", uri_allow_list: p.uri_allow_list ?? null } };
      projects[ref] = project;
      // With branching enabled the project itself is listed as its default branch (assumption S2).
      project.branches.push({ ...newSupabaseBranch(core, ref, "main", "sim"), project_ref: ref, is_default: true });
      for (const b of p.branches ?? []) project.branches.push(newSupabaseBranch(core, ref, b.name, "sim"));
    }
    return { projects };
  },

  /**
   * `branch.<name>`: "delete" | "recreate" (same name, new ref). `redirect.<url>`: "delete" | "add" — what a human
   * in the Supabase dashboard would do. `supabase:<ref>.` limits either to one project.
   */
  drift(core, state, { key, rest, value, only }) {
    const projects = Object.entries(state.projects).filter(([ref]) => only === undefined || ref === only);
    if (rest.startsWith("branch.")) return driftBranch(core, projects, key, rest.slice("branch.".length), value);
    if (rest.startsWith("redirect.")) return driftRedirect(projects, key, rest.slice("redirect.".length), value);
    return false;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function driftBranch(core: SimCore, projects: Array<[string, SupabaseProject]>, key: string, name: string, value: string): boolean {
  if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported`);
  for (const [ref, p] of projects) {
    const hit = p.branches.filter((b) => b.name === name && !b.is_default);
    p.branches = p.branches.filter((b) => !hit.includes(b));
    if (value === "recreate") for (const b of hit) p.branches.push(newSupabaseBranch(core, ref, b.name, "sim"));
  }
  return true;
}

function driftRedirect(projects: Array<[string, SupabaseProject]>, key: string, url: string, value: string): boolean {
  if (value !== "delete" && value !== "add") throw new Error(`drift ${key}: only "delete" and "add" are supported`);
  for (const [, p] of projects) {
    const rest = supabaseAllowList(p).filter((u) => u !== url);
    p.auth.uri_allow_list = (value === "add" ? [...rest, url] : rest).join(",");
  }
  return true;
}

/** The allow-list's entries: comma-separated, whitespace around them ignored (assumption S8). */
export function supabaseAllowList(p: SupabaseProject): string[] {
  return (p.auth.uri_allow_list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** The Management API, one route per method and path. Errors are `{ message }`, as Supabase's are. */
const routes = router<SupabaseState>(
  [
    route("GET", "/projects/:ref/branches", ({ state, params }) => {
      const p = state.projects[params.ref];
      return p ? new Reply(200, p.branches.map(publicBranch)) : notFound("project");
    }),

    route("POST", "/projects/:ref/branches", ({ core, state, params, body }) => {
      const p = state.projects[params.ref];
      if (!p) return notFound("project");
      const name = ((body ?? {}) as { branch_name?: unknown }).branch_name;
      if (typeof name !== "string" || name === "") return new Reply(400, { message: "branch_name must be a non-empty string" });
      if (p.branches.some((b) => b.name === name)) return new Reply(409, { message: `Branch ${name} already exists` });
      const b = newSupabaseBranch(core, params.ref, name, "api");
      b.readyAt = Date.now() + core.chaos.supabase_ready_ms;
      p.branches.push(b);
      return new Reply(201, publicBranch(b));
    }),

    route("GET", "/branches/:ref", ({ state, params }) => {
      const b = branchByRef(state, params.ref);
      return b ? new Reply(200, branchDetail(b)) : notFound("branch");
    }),

    route("DELETE", "/branches/:ref", ({ state, params }) => {
      const b = branchByRef(state, params.ref);
      if (!b) return notFound("branch");
      if (b.is_default) return new Reply(400, { message: "the default branch cannot be deleted" });
      const p = state.projects[b.parent_project_ref]!;
      p.branches = p.branches.filter((x) => x !== b);
      return new Reply(200, { message: "ok" });
    }),

    route("GET", "/projects/:ref/config/auth", ({ state, params }) => {
      const p = state.projects[params.ref];
      return p ? new Reply(200, authConfig(p)) : notFound("project");
    }),

    route("PATCH", "/projects/:ref/config/auth", ({ state, params, body }) => {
      const p = state.projects[params.ref];
      if (!p) return notFound("project");
      const b = (body ?? {}) as { uri_allow_list?: unknown; site_url?: unknown };
      if (b.uri_allow_list !== undefined && b.uri_allow_list !== null && typeof b.uri_allow_list !== "string") return new Reply(400, { message: "uri_allow_list must be a string" });
      if (b.uri_allow_list !== undefined) p.auth.uri_allow_list = b.uri_allow_list as string | null;
      if (typeof b.site_url === "string") p.auth.site_url = b.site_url;
      return new Reply(200, authConfig(p));
    }),
  ],
  () => notFound("route"),
);

/** A branch by its own project ref, in any project. */
function branchByRef(state: SupabaseState, ref: string): SupabaseBranch | undefined {
  for (const p of Object.values(state.projects)) {
    const b = p.branches.find((x) => x.project_ref === ref);
    if (b) return b;
  }
  return undefined;
}

/**
 * A new (not yet added) branch of project `parent`, ready at once. Tests use it to seed "someone else's" branch.
 * Refs are 20 lowercase letters, deterministic after a reset.
 */
export function newSupabaseBranch(core: SimCore, parent: string, name: string, createdBy: CreatedBy): SupabaseBranch {
  const n = core.nextId("");
  const ref = `br${[...n].map((d) => "abcdefghij"[Number(d)]).join("")}`.padEnd(20, "x");
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, "0")}`,
    name,
    project_ref: ref,
    parent_project_ref: parent,
    is_default: false,
    readyAt: 0,
    db_pass: `pw_${ref}`,
    created_at: new Date().toISOString(),
    createdAt: Date.now(),
    createdBy,
  };
}

/** The connection string the adapter builds from a branch's detail (assumption S4). */
export function supabaseConnectionString(b: SupabaseBranch): string {
  return `postgresql://postgres:${b.db_pass}@db.${b.project_ref}.supabase.co:5432/postgres`;
}

function publicBranch(b: SupabaseBranch) {
  const ready = Date.now() >= b.readyAt;
  return {
    id: b.id,
    name: b.name,
    project_ref: b.project_ref,
    parent_project_ref: b.parent_project_ref,
    is_default: b.is_default,
    persistent: b.is_default,
    status: ready ? "FUNCTIONS_DEPLOYED" : "CREATING_PROJECT",
    preview_project_status: ready ? "ACTIVE_HEALTHY" : "COMING_UP",
    with_data: false,
    created_at: b.created_at,
    updated_at: b.created_at,
  };
}

function branchDetail(b: SupabaseBranch) {
  return {
    ref: b.project_ref,
    postgres_version: "17.4.1",
    postgres_engine: "17",
    release_channel: "ga",
    status: Date.now() >= b.readyAt ? "ACTIVE_HEALTHY" : "COMING_UP",
    db_host: `db.${b.project_ref}.supabase.co`,
    db_port: 5432,
    db_user: "postgres",
    db_pass: b.db_pass,
  };
}

function authConfig(p: SupabaseProject) {
  return { site_url: p.auth.site_url, uri_allow_list: p.auth.uri_allow_list, disable_signup: false, jwt_exp: 3600 };
}

function notFound(what: string): Reply {
  return new Reply(404, { message: `${what} not found` });
}
