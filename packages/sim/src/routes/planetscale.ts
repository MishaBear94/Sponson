/**
 * Simulated PlanetScale: organizations, databases, branches and branch passwords (Vitess / MySQL databases).
 *
 * Assumptions about the real API that this fake encodes, each marked with how far it is checked. "Verified" means
 * against PlanetScale's published OpenAPI document (https://planetscale.com/docs/openapi.yaml, fetched 2026-10-11)
 * or the documentation page cited; see docs/api-verification.md, section "PlanetScale". The ones a wrong guess
 * would break are pinned in scenarios/contract.test.ts.
 *   PS1. Authentication is `Authorization: <SERVICE_TOKEN_ID>:<SERVICE_TOKEN>`, no scheme word (verified:
 *        https://planetscale.com/docs/api/reference/service-tokens). The sim answers 401 to any other form,
 *        including `Bearer …`. The CLI's variable names, PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN,
 *        are the ones the adapter reads (verified: https://planetscale.com/docs/cli/service-tokens.md).
 *   PS2. Every path is under `/organizations/{organization}/databases/{database}`, and branches are addressed by
 *        name, not id: GET and DELETE `/branches/{branch}` (verified: path parameter "The name of the branch").
 *   PS3. Lists (`list_branches`, `list_passwords`) are `{ data, next_page, … }`; the next page is `?page=<n>`
 *        and `next_page` is null on the last page; `per_page` defaults to 25 (verified). The sim pages at 25, or
 *        at chaos `page_size` when set.
 *   PS4. POST `/branches` with `{ name, parent_branch }` answers 201 with the branch (verified), which is not
 *        ready yet: `ready: false`, `state: "pending"` (fields and enum verified; that a new branch starts not
 *        ready is verified only through the CLI's `--wait`, "Wait until the branch is ready",
 *        https://planetscale.com/docs/cli/branch.md). How long it takes is unverified; the sim reports ready
 *        from the first GET, or after chaos `planetscale_ready_ms`.
 *   PS5. Creating a branch whose name exists answers 422 (unverified: the spec lists 401/403/404/422/429/500 and
 *        no 409; the body's wording is unknown). The adapter re-reads the branch by name after any 409 or 422.
 *   PS6. A parent branch that does not exist answers 404 here (unverified); the adapter checks the parent with
 *        GET first, so the exact answer does not matter to it.
 *   PS7. DELETE `/branches/{branch}` answers 204 (verified) and the branch is gone at once (unverified: needs a
 *        live account). Deleting a branch deletes its passwords (unverified).
 *   PS8. POST `/branches/{branch}/passwords` with `{ name, role }` answers 201 with `id`, `name`, `role`,
 *        `username`, `access_host_url` and `plain_text` (verified). `plain_text` is null in every other response
 *        (verified: "Null except in the response from the create endpoint"); the CLI docs say the password "is
 *        shown once … and cannot be retrieved afterwards" (https://planetscale.com/docs/cli/password.md).
 *   PS9. Password names are not unique (unverified: the spec calls `name` "Optional name of the password" and
 *        documents no uniqueness). The sim accepts duplicates; the adapter refuses to guess between two.
 *   PS10. A password's role cannot be changed in place: PATCH takes only `name` and `cidrs` (verified).
 *   PS11. DELETE `/branches/{branch}/passwords/{id}` answers 204 (verified); a password that does not exist, 404.
 *   PS12. Creating a password on a branch that is not ready yet is refused (unverified: the real behaviour is
 *        unknown, so the sim takes the strict reading and answers 422); the adapter waits for `ready` first.
 *   PS13. Error bodies are `{ code, message }` (unverified; not in the spec). The adapter never reads them.
 *   PS14. Branch names: the sim accepts any non-empty name. Which characters the real API accepts is
 *        unverified; the adapter's default name uses only lowercase letters, digits and dashes.
 */
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One simulated branch password. `plainText` is sim bookkeeping: the API shows it only in the create answer. */
export interface PlanetscalePassword {
  id: string;
  name: string;
  role: string;
  username: string;
  plainText: string;
  createdAt: number;
  createdBy: CreatedBy;
}

/** One simulated database branch. */
export interface PlanetscaleBranch {
  id: string;
  name: string;
  parent_branch: string | null;
  production: boolean;
  /** `ready` is reported from this time on (PS4). */
  readyAt: number;
  created_at: string;
  passwords: PlanetscalePassword[];
  createdBy: CreatedBy;
}

/** The simulated PlanetScale's state: organization → database → branches. */
export interface PlanetscaleState {
  organizations: Record<string, { databases: Record<string, { branches: PlanetscaleBranch[] }> }>;
}

/** What a scenario or test seeds the simulated PlanetScale with (`seed: { planetscale: … }`). */
export interface PlanetscaleSeed {
  /** Organization → database → branches that already exist (created "by a human", so unmanaged). */
  organizations: Record<string, Record<string, Array<{ name: string; parent?: string; production?: boolean; passwords?: Array<{ name: string; role?: string }> }>>>;
}

/** The access host every simulated password hands out (the real API's `access_host_url`). */
export const PLANETSCALE_SIM_HOST = "aws.connect.psdb.sim";

/** The simulated PlanetScale API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/planetscale`. */
export const planetscaleSim: ProviderSim<PlanetscaleState, PlanetscaleSeed> = {
  env: { token: "PLANETSCALE_SERVICE_TOKEN", url: "PLANETSCALE_API_URL", testToken: "tok_planetscale", more: { PLANETSCALE_SERVICE_TOKEN_ID: "tokid_planetscale" } },
  defaultSeed: { organizations: { acme: { app: [{ name: "main", production: true }] } } },

  /** PS1: `Authorization: <id>:<token>`, no `Bearer`. */
  authorized(headers) {
    return /^[^\s:]+:\S+$/.test(headers.authorization ?? "");
  },

  reset(core, seed) {
    const organizations: PlanetscaleState["organizations"] = {};
    for (const [org, dbs] of Object.entries(seed?.organizations ?? {})) {
      const databases: PlanetscaleState["organizations"][string]["databases"] = {};
      for (const [db, branches] of Object.entries(dbs)) {
        const list: PlanetscaleBranch[] = [];
        for (const b of branches) {
          const branch = createPsBranch(core, list, b.name, b.parent ?? null, "sim", b.production === true);
          for (const pw of b.passwords ?? []) createPsPassword(core, branch, pw.name, pw.role ?? "admin", "sim");
        }
        databases[db] = { branches: list };
      }
      organizations[org] = { databases };
    }
    return { organizations };
  },

  /**
   * `branch.<name>` or `password.<branch>.<name>` (or `planetscale:<organization>.…`): "delete", or "recreate"
   * (same name, new id; a re-created password has a new plaintext) — what a human in the console would do.
   */
  drift(core, state, { key, rest, value, only }) {
    const [kind, ...path] = rest.split(".");
    if (kind !== "branch" && kind !== "password") return false;
    if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported`);
    let hit = false;
    for (const [org, o] of Object.entries(state.organizations)) {
      if (only !== undefined && org !== only) continue;
      for (const d of Object.values(o.databases)) hit = (kind === "branch" ? driftBranch(core, d.branches, path.join("."), value) : driftPassword(core, d.branches, path, value)) || hit;
    }
    if (!hit) throw new Error(`drift ${key}: nothing named ${path.join(".")}`);
    return true;
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function driftBranch(core: SimCore, branches: PlanetscaleBranch[], name: string, value: string): boolean {
  const i = branches.findIndex((b) => b.name === name);
  if (i < 0) return false;
  const [old] = branches.splice(i, 1);
  if (value === "recreate") createPsBranch(core, branches, old!.name, old!.parent_branch, "sim", old!.production);
  return true;
}

function driftPassword(core: SimCore, branches: PlanetscaleBranch[], path: string[], value: string): boolean {
  const [branchName, ...rest] = path;
  const b = branches.find((x) => x.name === branchName);
  const pw = b?.passwords.find((p) => p.name === rest.join("."));
  if (!b || !pw) return false;
  b.passwords = b.passwords.filter((p) => p !== pw);
  if (value === "recreate") createPsPassword(core, b, pw.name, pw.role, "sim");
  return true;
}

type Db = { branches: PlanetscaleBranch[] };

function dbOf(state: PlanetscaleState, org: string, db: string): Db | undefined {
  return state.organizations[org]?.databases[db];
}

const ROLES = new Set(["reader", "writer", "admin", "readwriter"]);

/** One route per method and path; `:name` segments arrive URI-decoded in `params`. */
const routes = router<PlanetscaleState>(
  [
    route("GET", "/organizations/:org/databases/:db/branches", ({ core, state, params, url }) => {
      const d = dbOf(state, params.org, params.db);
      return d ? listReply(core, d.branches.map(publicBranch), url) : notFound();
    }),

    route("POST", "/organizations/:org/databases/:db/branches", ({ core, state, params, body }) => {
      const d = dbOf(state, params.org, params.db);
      if (!d) return notFound();
      const b = (body ?? {}) as { name?: unknown; parent_branch?: unknown };
      if (typeof b.name !== "string" || b.name === "") return unprocessable("Name can't be blank");
      if (d.branches.some((x) => x.name === b.name)) return unprocessable("Name has already been taken"); // PS5
      const parent = typeof b.parent_branch === "string" ? b.parent_branch : (d.branches.find((x) => x.production)?.name ?? null);
      if (parent !== null && !d.branches.some((x) => x.name === parent)) return notFound(); // PS6
      const branch = createPsBranch(core, d.branches, b.name, parent, "api", false);
      branch.readyAt = Date.now() + core.chaos.planetscale_ready_ms;
      // PS4: the create answer always reports a branch that is still being provisioned.
      return new Reply(201, { ...publicBranch(branch), ready: false, state: "pending" });
    }),

    route("GET", "/organizations/:org/databases/:db/branches/:branch", ({ state, params }) => {
      const b = dbOf(state, params.org, params.db)?.branches.find((x) => x.name === params.branch);
      return b ? new Reply(200, publicBranch(b)) : notFound();
    }),

    route("DELETE", "/organizations/:org/databases/:db/branches/:branch", ({ state, params }) => {
      const d = dbOf(state, params.org, params.db);
      const b = d?.branches.find((x) => x.name === params.branch);
      if (!d || !b) return notFound();
      if (b.production) return unprocessable("Cannot delete a production branch");
      d.branches.splice(d.branches.indexOf(b), 1); // PS7
      return new Reply(204, undefined);
    }),

    route("GET", "/organizations/:org/databases/:db/branches/:branch/passwords", ({ core, state, params, url }) => {
      const b = dbOf(state, params.org, params.db)?.branches.find((x) => x.name === params.branch);
      return b ? listReply(core, b.passwords.map((p) => publicPassword(b, p)), url) : notFound();
    }),

    route("POST", "/organizations/:org/databases/:db/branches/:branch/passwords", ({ core, state, params, body }) => {
      const b = dbOf(state, params.org, params.db)?.branches.find((x) => x.name === params.branch);
      if (!b) return notFound();
      if (Date.now() < b.readyAt) return unprocessable("Branch is not ready yet"); // PS12
      const p = (body ?? {}) as { name?: unknown; role?: unknown };
      const role = p.role === undefined ? "admin" : p.role;
      if (typeof role !== "string" || !ROLES.has(role)) return unprocessable("Role is not included in the list");
      const pw = createPsPassword(core, b, typeof p.name === "string" ? p.name : "", role, "api");
      return new Reply(201, { ...publicPassword(b, pw), plain_text: pw.plainText }); // PS8
    }),

    route("GET", "/organizations/:org/databases/:db/branches/:branch/passwords/:id", ({ state, params }) => {
      const b = dbOf(state, params.org, params.db)?.branches.find((x) => x.name === params.branch);
      const pw = b?.passwords.find((p) => p.id === params.id);
      return b && pw ? new Reply(200, publicPassword(b, pw)) : notFound();
    }),

    route("DELETE", "/organizations/:org/databases/:db/branches/:branch/passwords/:id", ({ state, params }) => {
      const b = dbOf(state, params.org, params.db)?.branches.find((x) => x.name === params.branch);
      const pw = b?.passwords.find((p) => p.id === params.id);
      if (!b || !pw) return notFound(); // PS11
      b.passwords = b.passwords.filter((p) => p !== pw);
      return new Reply(204, undefined);
    }),
  ],
  () => notFound(),
);

/** PS3: page-numbered lists, 25 per page unless chaos `page_size` or `per_page` says otherwise. */
function listReply(core: SimCore, items: unknown[], url: URL): Reply {
  const perPage = core.chaos.page_size > 0 ? core.chaos.page_size : Number(url.searchParams.get("per_page") ?? 25) || 25;
  const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const data = items.slice((pageNo - 1) * perPage, pageNo * perPage);
  const last = pageNo * perPage >= items.length;
  return new Reply(200, { type: "list", current_page: pageNo, per_page: perPage, next_page: last ? null : pageNo + 1, prev_page: pageNo > 1 ? pageNo - 1 : null, data });
}

/**
 * Add a branch as PlanetScale would. Tests use it to seed "someone else's" branch. A seeded branch is ready at once.
 */
export function createPsBranch(core: SimCore, branches: PlanetscaleBranch[], name: string, parent: string | null, createdBy: CreatedBy, production: boolean): PlanetscaleBranch {
  const branch: PlanetscaleBranch = { id: core.nextId("psbr_"), name, parent_branch: parent, production, readyAt: 0, created_at: new Date().toISOString(), passwords: [], createdBy };
  branches.push(branch);
  return branch;
}

/** Add a password to a branch. Its plaintext starts `pscale_pw_`, like the real ones (PS8). */
export function createPsPassword(core: SimCore, branch: PlanetscaleBranch, name: string, role: string, createdBy: CreatedBy): PlanetscalePassword {
  const id = core.nextId("pspw_");
  const pw: PlanetscalePassword = { id, name, role, username: `user_${id}`, plainText: `pscale_pw_sim_${id}`, createdAt: Date.now(), createdBy };
  branch.passwords.push(pw);
  return pw;
}

function publicBranch(b: PlanetscaleBranch) {
  const ready = Date.now() >= b.readyAt;
  return { id: b.id, name: b.name, kind: "mysql", parent_branch: b.parent_branch, production: b.production, ready, state: ready ? "ready" : "pending", created_at: b.created_at, updated_at: b.created_at };
}

function publicPassword(b: PlanetscaleBranch, p: PlanetscalePassword) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    username: p.username,
    access_host_url: PLANETSCALE_SIM_HOST,
    plain_text: null,
    expired: false,
    database_branch: { id: b.id, name: b.name, production: b.production },
    created_at: new Date(p.createdAt).toISOString(),
  };
}

/** PS13: `{ code, message }`. */
function notFound(): Reply {
  return new Reply(404, { code: "not_found", message: "Not Found" });
}

function unprocessable(message: string): Reply {
  return new Reply(422, { code: "unprocessable", message });
}
