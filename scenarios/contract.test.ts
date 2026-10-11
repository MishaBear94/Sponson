/**
 * Contract suite: the same assertions against the fake cloud (default) or the real APIs (`@live`).
 *
 * Default: runs against an in-process sim, so it always runs in CI.
 * Live:    SPONSON_LIVE=1 plus real credentials; nothing is mocked.
 *
 *   SPONSON_LIVE=1 \
 *   VERCEL_TOKEN=... SPONSON_LIVE_VERCEL_PROJECT=prj_... [SPONSON_LIVE_VERCEL_TEAM=team_...] \
 *   NEON_API_KEY=... SPONSON_LIVE_NEON_PROJECT=... \
 *   CLERK_SECRET_KEY=fake_ts_... \
 *   [NETLIFY_AUTH_TOKEN=... SPONSON_LIVE_NETLIFY_SITE=<site id> [SPONSON_LIVE_NETLIFY_ACCOUNT=<slug>]] \
 *   [LAUNCHDARKLY_ACCESS_TOKEN=api-... SPONSON_LIVE_LAUNCHDARKLY_PROJECT=... \
 *    SPONSON_LIVE_LAUNCHDARKLY_ENVIRONMENT=... SPONSON_LIVE_LAUNCHDARKLY_FLAG=<a boolean flag>] \
 *   pnpm test:live
 *
 * The LaunchDarkly assumptions run live only when its four variables are set (it is optional, so a live run of
 * the original three providers needs no LaunchDarkly account); they add and remove one individual target,
 * `sponson-contract-<random>`, on the given flag and environment. Use a test environment without required approvals.
 *
 * Use throwaway projects: the suite creates a Neon branch (forked from the project's default branch), preview env
 * vars, and a Clerk redirect URL, and destroys them in `afterAll` even when an assertion fails. It never touches the
 * production target. The Vercel project's `link` decides how the preview vars are written, and the suite logs which
 * variant ran: connected to a Git repository, they are bound to a unique git branch name; not connected, Vercel
 * refuses that (assumption V9, which is then checked), so they are project-wide (`branch: "*"`), named
 * `DATABASE_URL` and `CONTRACT_TOKEN`: use a project that has no variables of those names.
 *
 * Cloudflare is optional in a live run: its block runs when these are set too, and is skipped otherwise.
 *
 *   CLOUDFLARE_API_TOKEN=... SPONSON_LIVE_CLOUDFLARE_ACCOUNT=<account id> SPONSON_LIVE_CLOUDFLARE_PROJECT=<pages project>
 *
 * It writes three preview variables named `SPONSON_CONTRACT_<tag>_*` to that Pages project and removes them in
 * `afterAll`; use a throwaway project, since a preview deployment started meanwhile would see them.
 *
 * Supabase is optional in a live run, because branching needs a paid plan: with SUPABASE_ACCESS_TOKEN and
 * SPONSON_LIVE_SUPABASE_PROJECT (the parent project's ref, branching enabled) also set, the Supabase block runs
 * live; without them it is skipped under SPONSON_LIVE=1. It creates one preview branch (billed while it exists;
 * it may take minutes to come up) and one Auth redirect URL, and removes both in its `afterAll`.
 *
 * Each `assumption <id>:` test pins the API assumption with that id, listed at the top of the sim's provider
 * file (packages/sim/src/routes/{vercel,neon,clerk,launchdarkly,planetscale,supabase,netlify,cloudflare}.ts). If one fails live, fix the sim first, then the
 * adapter.
 *
 * PlanetScale has its own block, live only when its credentials are set too (it is skipped in a live run without
 * them, so the Vercel/Neon/Clerk suite does not need a PlanetScale account):
 *
 *   PLANETSCALE_SERVICE_TOKEN_ID=... PLANETSCALE_SERVICE_TOKEN=... \
 *   SPONSON_LIVE_PLANETSCALE_ORG=... SPONSON_LIVE_PLANETSCALE_DATABASE=... (a throwaway Vitess database with a `main` branch)
 *
 * It creates one development branch and a password on it, and deletes both in `afterAll`.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLERK_DEFAULT_API_URL, CLOUDFLARE_DEFAULT_API_URL, CLOUD_RUN_DEFAULT_API_URL, algoliaAdapter, cloudRunAdapter, createCloudRunAdapter, digitaloceanAdapter, xataAdapter, LAUNCHDARKLY_DEFAULT_API_URL, NEON_DEFAULT_API_URL, NETLIFY_DEFAULT_API_URL, PLANETSCALE_DEFAULT_API_URL, SUPABASE_DEFAULT_API_URL, VERCEL_DEFAULT_API_URL, clerkAdapter, cloudflareAdapter, launchdarklyAdapter, neonAdapter, netlifyAdapter, planetscaleAdapter, supabaseAdapter, vercelAdapter } from "@sponson/adapters";
import type { AdapterContext, Ctx } from "@sponson/core";
import { SUPABASE_DEMO_PROJECT, simEnv, startSim, type SimHandle } from "@sponson/sim";
import { cliEnv, runCli, workspace, type CliRun, type Workspace } from "./support.js";

const LIVE = process.env.SPONSON_LIVE === "1";
const MISSING = ["VERCEL_TOKEN", "SPONSON_LIVE_VERCEL_PROJECT", "NEON_API_KEY", "SPONSON_LIVE_NEON_PROJECT", "CLERK_SECRET_KEY"].filter((k) => !process.env[k]);
if (LIVE && MISSING.length) throw new Error(`SPONSON_LIVE=1 but missing: ${MISSING.join(", ")}`);
const LD_VARS = ["LAUNCHDARKLY_ACCESS_TOKEN", "SPONSON_LIVE_LAUNCHDARKLY_PROJECT", "SPONSON_LIVE_LAUNCHDARKLY_ENVIRONMENT", "SPONSON_LIVE_LAUNCHDARKLY_FLAG"];
/** LaunchDarkly is checked against the sim always, and live only when all of its variables are set. */
const LD_RUNS = !LIVE || LD_VARS.every((k) => process.env[k]);
const ld = LIVE
  ? { project: process.env.SPONSON_LIVE_LAUNCHDARKLY_PROJECT ?? "", environment: process.env.SPONSON_LIVE_LAUNCHDARKLY_ENVIRONMENT ?? "", flag: process.env.SPONSON_LIVE_LAUNCHDARKLY_FLAG ?? "" }
  : { project: "demo", environment: "preview", flag: "new-checkout" };

const tag = randomBytes(4).toString("hex");
const pr = 900000 + (parseInt(tag, 16) % 99999); // unique scope per run, never collides with a real PR
const branch = `sponson-contract-${tag}`;
const sha = randomBytes(20).toString("hex");
const callbackUrl = `https://sponson-contract-${tag}.example.com/callback`;
const SECRET = `contract-secret-${tag}`;

let sim: SimHandle | null = null;
let env: NodeJS.ProcessEnv;

/**
 * The core block (Vercel, Neon, Clerk) runs once per Vercel project. Live: the given project, and what the block checks
 * depends on its `link` (GET /v9/projects/:id): connected to a Git repository, preview values are bound to the run's
 * git branch; not connected, Vercel refuses that (V9), so they are written project-wide (`branch: "*"`) and V9 is
 * asserted instead. Against the sim: both, a connected `prj_demo` and an unconnected `prj_nogit`.
 */
const VERCEL_PROJECTS = LIVE ? [process.env.SPONSON_LIVE_VERCEL_PROJECT ?? ""] : ["prj_demo", "prj_nogit"];

beforeAll(async () => {
  if (LIVE) env = { ...process.env };
  else {
    sim = await startSim({ seed: { vercel: { projects: { prj_demo: { envs: [] }, prj_nogit: { envs: [], link: false } } } } });
    env = cliEnv(sim);
  }
  env.SPONSON_CONTRACT_SECRET = SECRET;
}, 60_000);

afterAll(async () => {
  await sim?.close();
});

const CF_LIVE = ["CLOUDFLARE_API_TOKEN", "SPONSON_LIVE_CLOUDFLARE_ACCOUNT", "SPONSON_LIVE_CLOUDFLARE_PROJECT"].every((k) => process.env[k]);

/** One pass of the core block: its own scope, git branch and callback, so the sim's two passes never meet. */
interface Run {
  pr: number;
  branch: string;
  callbackUrl: string;
  providers: { vercel: Record<string, unknown>; neon: Record<string, unknown> };
}

const CORE_RUN: Run = {
  pr,
  branch,
  callbackUrl,
  providers: LIVE ? { vercel: { project: process.env.SPONSON_LIVE_VERCEL_PROJECT }, neon: { project: process.env.SPONSON_LIVE_NEON_PROJECT } } : { vercel: { project: "prj_demo" }, neon: { project: "proj_demo" } },
};

function actx(adapter: "vercel" | "neon" | "clerk" | "launchdarkly", run: Run = CORE_RUN): AdapterContext {
  const ctx: Ctx = { env: "preview", git: { branch: run.branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: run.pr }, scope: `pr-${run.pr}` };
  const provider = adapter === "clerk" ? {} : adapter === "launchdarkly" ? { project: ld.project, environment: ld.environment } : run.providers[adapter];
  return { ctx, provider, env, log: () => {}, intend: async () => {}, redact: (t) => t };
}

/** LaunchDarkly's REST API, called directly to pin what the adapter relies on (LD1: the token without `Bearer`). */
async function ldFetch(method: "GET" | "PATCH", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: env.LAUNCHDARKLY_ACCESS_TOKEN ?? "" };
  if (body !== undefined) headers["content-type"] = "application/json; domain-model=launchdarkly.semanticpatch";
  const res = await fetch(`${env.LAUNCHDARKLY_API_URL ?? LAUNCHDARKLY_DEFAULT_API_URL}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The variation index serving `key` (kind user) in the environment, from either target list (LD3); -1 when none. */
function servedIndex(flag: Record<string, unknown>, key: string): number {
  const e = (flag.environments as Record<string, Record<string, unknown>>)[ld.environment]!;
  const all = [...((e.targets as unknown[]) ?? []), ...((e.contextTargets as unknown[]) ?? [])] as Array<{ contextKind?: string; values: string[]; variation: number }>;
  return all.find((t) => (t.contextKind ?? "user") === "user" && t.values.includes(key))?.variation ?? -1;
}

/** Vercel's REST API, called directly to pin what the adapter relies on. `teamId` is added when the run has a team. */
async function vercelFetch(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const team = process.env.SPONSON_LIVE_VERCEL_TEAM;
  const url = new URL(`${env.VERCEL_API_URL ?? VERCEL_DEFAULT_API_URL}${path}`);
  if (LIVE && team) url.searchParams.set("teamId", team);
  const headers: Record<string, string> = { authorization: `Bearer ${env.VERCEL_TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/** Neon's REST API, called directly to pin what the adapter relies on. */
async function neonFetch(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${env.NEON_API_KEY}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${env.NEON_API_URL ?? NEON_DEFAULT_API_URL}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface ListedEnv {
  id: string;
  key: string;
  value?: string;
  type?: string;
  decrypted?: boolean;
  gitBranch?: string | null;
  target?: string | string[];
  createdAt: number;
  updatedAt: number;
}

describe.each(VERCEL_PROJECTS.map((project, i) => ({ project, i })))(`contract (${LIVE ? "@live" : "sim"}), vercel project $project`, ({ project, i }) => {
  const suffix = i === 0 ? "" : `-${i}`;
  const run: Run = {
    pr: pr + i,
    branch: `${branch}${suffix}`,
    callbackUrl: `https://sponson-contract-${tag}${suffix}.example.com/callback`,
    providers: { ...CORE_RUN.providers, vercel: { ...CORE_RUN.providers.vercel, project, ...(LIVE && process.env.SPONSON_LIVE_VERCEL_TEAM ? { team: process.env.SPONSON_LIVE_VERCEL_TEAM } : {}) } },
  };
  /** Whether the Vercel project is connected to a Git repository; read in beforeAll. */
  let linked = true;
  /** The `branch` param of the env line: the run's git branch when connected, project-wide otherwise. */
  let envBranch: string | undefined;
  let ws: Workspace;

  const cli = (args: string[]): Promise<CliRun> => runCli([...args, "--json", "--receipts", "local", "--receipts-dir", join(ws.dir, "r"), "--pr", String(run.pr), "--branch", run.branch, "--sha", sha], { env, cwd: ws.dir });
  const envParams = (values: Record<string, unknown>) => vercelAdapter.ops.env!.defaults!({ target: "preview", ...(envBranch ? { branch: envBranch } : {}), values }, actx("vercel", run).ctx);

  beforeAll(async () => {
    const p = await vercelFetch("GET", `/v9/projects/${project}`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    linked = typeof p.body.link === "object" && p.body.link !== null;
    envBranch = linked ? undefined : "*";
    console.info(
      linked
        ? `contract: Vercel project ${project} is connected to a Git repository: checking preview values bound to git branch ${run.branch}.`
        : `contract: Vercel project ${project} has no connected Git repository: checking project-wide preview values (branch: "*"), and V9 (a git-branch write is refused).`,
    );
    // No deploy-dependent line: a live run must not depend on a git push reaching Vercel.
    ws = await workspace("contract", {
      plan: `version: 1
providers:
  vercel: ${JSON.stringify(run.providers.vercel)}
  neon: ${JSON.stringify(run.providers.neon)}
changes:
  - id: db
    adapter: neon
    op: branch
  - id: env
    adapter: vercel
    op: env
    target: preview
${envBranch ? `    branch: "${envBranch}"\n` : ""}    values:
      DATABASE_URL: { from: db.connection_string }
      CONTRACT_TOKEN: { secret: "env://SPONSON_CONTRACT_SECRET" }
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: ${run.callbackUrl}
`,
    });
  }, 60_000);

  afterAll(async () => {
    // Always clean up, even when assertions failed half-way.
    if (ws) await cli(["apply", "--destroy"]).catch(() => {});
    await ws?.cleanup();
  }, 120_000);

  /** The CONTRACT_TOKEN record this pass wrote, as the env list shows it. */
  const listedToken = async (): Promise<ListedEnv> => {
    const r = await vercelFetch("GET", `/v10/projects/${project}/env?decrypt=true`);
    expect(r.status).toBe(200);
    const found = (r.body.envs as ListedEnv[]).find((e) => e.key === "CONTRACT_TOKEN" && (e.gitBranch ?? undefined) === (linked ? run.branch : undefined) && [e.target].flat().includes("preview"));
    expect(found, "CONTRACT_TOKEN in the env list").toBeDefined();
    return found!;
  };

  it("plan is read-only and sees every line", async () => {
    const before = sim?.state.writes.length ?? 0;
    const r = await cli(["plan"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const lines = (r.json!.lines as Array<{ id: string; status: string }>).map((l) => [l.id, l.status]);
    expect(lines).toEqual([
      ["db", "create"],
      ["env", "pending"],
      ["callback", "create"],
    ]);
    if (sim) expect(sim.state.writes.length).toBe(before);
  });

  it("apply creates all three and never prints the secret", async () => {
    const r = await cli(["apply"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    const receipt = r.json!.receipt as { status: string; lines: Record<string, { status: string }> };
    expect(receipt.status).toBe("complete");
    expect(Object.values(receipt.lines).map((l) => l.status)).toEqual(["applied", "applied", "applied"]);
  }, 120_000);

  it("assumption V1: an env var written by apply is immediately readable with the same value hash", async () => {
    const op = vercelAdapter.ops.env!;
    const params = envParams({ CONTRACT_TOKEN: SECRET });
    const live = await op.read(actx("vercel", run), params);
    // v0.2 key: env:<target>:<gitBranch|*>:<KEY> (scoped to this run's git branch when the project is connected).
    const key = `env:preview:${linked ? run.branch : "*"}:CONTRACT_TOKEN`;
    expect(live?.resources.map((r) => r.key)).toContain(key);
    expect(op.diff(live, params).find((d) => d.key === key)?.kind).toBe("unchanged");
  });

  it("assumption V3: the env list never decrypts an encrypted value, even with ?decrypt=true; GET /v1/projects/:id/env/:id does", async () => {
    const listed = await listedToken();
    expect(listed.type).toBe("encrypted");
    expect(listed.decrypted).toBe(false);
    expect(listed.value).not.toBe(SECRET);
    const one = await vercelFetch("GET", `/v1/projects/${project}/env/${listed.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: listed.id, decrypted: true, value: SECRET });
  });

  it("assumption V4: an upsert of an existing key and target answers 201 with the same id in `created`, createdAt kept, updatedAt newer", async () => {
    const before = await listedToken();
    const entry = { key: "CONTRACT_TOKEN", value: SECRET, type: "encrypted", target: ["preview"], ...(linked ? { gitBranch: run.branch } : {}) };
    const r = await vercelFetch("POST", `/v10/projects/${project}/env?upsert=true`, [entry]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Array.isArray(r.body.created)).toBe(true);
    const [created] = r.body.created as ListedEnv[];
    expect(created).toMatchObject({ id: before.id, createdAt: before.createdAt });
    expect(created!.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(r.body.failed).toEqual([]);
  });

  it("assumption V9: a git-branch value on a project with no connected Git repository is refused with 400, and nothing is written", async (t) => {
    if (linked) {
      console.info(`contract: V9 not checked: Vercel project ${project} is connected to a Git repository.`);
      t.skip();
    }
    const key = `SPONSON_CONTRACT_${tag.toUpperCase()}_V9`;
    const r = await vercelFetch("POST", `/v10/projects/${project}/env?upsert=true`, [{ key, value: "v9", type: "encrypted", target: ["preview"], gitBranch: run.branch }]);
    const leftover = async () => ((await vercelFetch("GET", `/v10/projects/${project}/env`)).body.envs as ListedEnv[]).filter((e) => e.key === key);
    try {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error).toMatchObject({ code: "BAD_REQUEST", key: "project", message: expect.stringMatching(/does not have a connected Git repository/) });
      expect(await leftover()).toEqual([]);
      // The adapter turns it into PARAM_INVALID naming both fixes.
      const op = vercelAdapter.ops.env!;
      const params = op.defaults!({ target: "preview", values: { [key]: "v9" } }, actx("vercel", run).ctx);
      await expect(op.apply(actx("vercel", run), params, null)).rejects.toMatchObject({ code: "PARAM_INVALID", message: expect.stringMatching(/no connected Git repository.*`branch: "\*"`/) });
    } finally {
      for (const e of await leftover()) await vercelFetch("DELETE", `/v9/projects/${project}/env/${e.id}`);
    }
  });

  it("assumption N2: the Neon branch and its connection string are readable right after creation", async () => {
    const op = neonAdapter.ops.branch!;
    const params = op.defaults!({}, actx("neon", run).ctx);
    const live = await op.read(actx("neon", run), params);
    expect(live?.resources).toHaveLength(1);
    expect(String(live?.outputs.connection_string)).toMatch(/^postgres(ql)?:\/\//);
  });

  it("assumption N6: the project's root branch is listed `default: true`, and a line without `parent` forked from it", async () => {
    const neonProject = String(run.providers.neon.project);
    const r = await neonFetch("GET", `/projects/${neonProject}/branches`);
    expect(r.status).toBe(200);
    const branches = r.body.branches as Array<{ id: string; name: string; parent_id?: string | null; default?: boolean }>;
    const roots = branches.filter((b) => b.default === true);
    expect(roots).toHaveLength(1);
    console.info(`contract: Neon project ${neonProject}'s default branch is \`${roots[0]!.name}\`.`);
    // A new project calls it `production` (checked live 2026-10-11); an older live project may still call it `main`.
    if (!LIVE) expect(roots[0]!.name).toBe("production");
    const ours = branches.find((b) => b.name === `sponson/preview/pr-${run.pr}`);
    expect(ours?.parent_id).toBe(roots[0]!.id);
  });

  it("assumption N5: creating a branch whose name exists answers 409 BRANCH_ALREADY_EXISTS", async () => {
    const neonProject = String(run.providers.neon.project);
    const branches = (await neonFetch("GET", `/projects/${neonProject}/branches`)).body.branches as Array<{ id: string; default?: boolean }>;
    const root = branches.find((b) => b.default === true)!;
    const name = `sponson/preview/pr-${run.pr}`;
    const r = await neonFetch("POST", `/projects/${neonProject}/branches`, { branch: { name, parent_id: root.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toMatchObject({ code: "BRANCH_ALREADY_EXISTS", message: expect.stringMatching(/branch already exists/) });
  });

  it("assumption C2: GET /redirect_urls?paginated=true answers { data, total_count } (not in the spec; how Clerk's SDKs read it)", async () => {
    const res = await fetch(`${env.CLERK_API_URL ?? CLERK_DEFAULT_API_URL}/redirect_urls?paginated=true&limit=1`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown; total_count?: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total_count).toBe("number");
    expect(body.total_count).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!LD_RUNS)("assumption LD5: adding a target its variation already serves succeeds and changes nothing; LD7: visible at once", async () => {
    const key = `sponson-contract-${tag}${suffix}`;
    const path = `/flags/${encodeURIComponent(ld.project)}/${encodeURIComponent(ld.flag)}`;
    const flag = await ldFetch("GET", `${path}?env=${encodeURIComponent(ld.environment)}`);
    expect(flag.status).toBe(200);
    const variationId = (flag.body.variations as Array<{ _id: string }>)[0]!._id;
    const add = { environmentKey: ld.environment, comment: "sponson contract suite", instructions: [{ kind: "addTargets", contextKind: "user", values: [key], variationId }] };
    try {
      expect((await ldFetch("PATCH", path, add)).status).toBe(200);
      const again = await ldFetch("PATCH", path, add);
      expect(again.status).toBe(200);
      expect(servedIndex(again.body, key)).toBe(0);
      expect(servedIndex((await ldFetch("GET", `${path}?env=${encodeURIComponent(ld.environment)}`)).body, key)).toBe(0);
    } finally {
      const remove = { ...add, instructions: [{ ...add.instructions[0], kind: "removeTargets" }] };
      expect((await ldFetch("PATCH", path, remove)).status).toBe(200);
    }
  });

  it.skipIf(!LD_RUNS)("assumption LD7: a flag target applied by the adapter reads back unchanged, and is gone after destroy", async () => {
    const op = launchdarklyAdapter.ops.flag_target!;
    const params = op.defaults!({ flag: ld.flag, key: `sponson-contract-${tag}${suffix}-adapter` }, actx("launchdarkly", run).ctx);
    const applied = await op.apply(actx("launchdarkly", run), params, null);
    try {
      const live = await op.read(actx("launchdarkly", run), params);
      expect(live?.resources).toEqual(applied.resources);
      expect(op.diff(live, params)[0]!.kind).toBe("unchanged");
    } finally {
      await op.destroy(actx("launchdarkly", run), applied.resources);
    }
    expect(await op.read(actx("launchdarkly", run), params)).toBeNull();
  });

  it("second apply writes nothing", async () => {
    const before = sim?.state.writes.length ?? 0;
    const r = await cli(["apply"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const receipt = r.json!.receipt as { lines: Record<string, { status: string }> };
    expect(Object.values(receipt.lines).map((l) => l.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    if (sim) expect(sim.state.writes.length).toBe(before);
  }, 120_000);

  it("assumption N1: destroy is visible immediately (a deleted Neon branch leaves the list at once)", async () => {
    const r = await cli(["apply", "--destroy"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const neon = neonAdapter.ops.branch!;
    expect(await neon.read(actx("neon", run), neon.defaults!({}, actx("neon", run).ctx))).toBeNull();
    const clerk = clerkAdapter.ops.redirect_allow!;
    expect(await clerk.read(actx("clerk", run), { url: run.callbackUrl })).toBeNull();
    const vercel = vercelAdapter.ops.env!;
    expect(await vercel.read(actx("vercel", run), envParams({ CONTRACT_TOKEN: SECRET, DATABASE_URL: "x" }))).toBeNull();
  }, 120_000);
});

/**
 * Cloudflare Pages variables (`cloudflare.pages_env`), against the adapter and the raw API. Live only with the
 * Cloudflare variables of the header; always against the sim.
 */
describe.skipIf(LIVE && !CF_LIVE)(`contract: cloudflare (${LIVE ? "@live" : "sim"})`, () => {
  const name = (suffix: string) => `SPONSON_CONTRACT_${tag.toUpperCase()}_${suffix}`;
  const [PLAIN, SECRET_VAR, OTHER] = [name("PLAIN"), name("SECRET"), name("OTHER")];
  const op = cloudflareAdapter.ops.pages_env!;
  const cf = () => (LIVE ? { account: process.env.SPONSON_LIVE_CLOUDFLARE_ACCOUNT!, project: process.env.SPONSON_LIVE_CLOUDFLARE_PROJECT! } : { account: "acc_demo", project: "demo" });
  const cfActx = (): AdapterContext => {
    const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
    return { ctx, provider: cf(), env, log: () => {}, intend: async () => {}, redact: (t) => t };
  };
  const params = { target: "preview", vars: { [PLAIN]: "plain-1" }, secrets: { [SECRET_VAR]: SECRET } };
  const url = () => `${env.CLOUDFLARE_API_URL ?? CLOUDFLARE_DEFAULT_API_URL}/accounts/${cf().account}/pages/projects/${cf().project}`;
  const call = async (method: "GET" | "PATCH", body?: unknown) => {
    const res = await fetch(url(), { method, headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as { result?: { deployment_configs?: { preview?: { env_vars?: Record<string, { type: string; value?: unknown } | null> | null } } } } };
  };
  const previewVars = async () => (await call("GET")).body.result?.deployment_configs?.preview?.env_vars ?? {};

  afterAll(async () => {
    await call("PATCH", { deployment_configs: { preview: { env_vars: { [PLAIN]: null, [SECRET_VAR]: null, [OTHER]: null } } } }).catch(() => {});
  });

  it("assumption CF4/CF7: a PATCH merges the map (an unnamed key survives) and is readable at once", async () => {
    expect((await call("PATCH", { deployment_configs: { preview: { env_vars: { [OTHER]: { type: "plain_text", value: "other" } } } } })).status).toBe(200);
    const r = await op.apply(cfActx(), params, null);
    expect(r.resources.map((x) => x.key)).toEqual([`env:preview:${PLAIN}`, `env:preview:${SECRET_VAR}`]);
    const vars = await previewVars();
    expect(vars[OTHER]).toEqual({ type: "plain_text", value: "other" });
    expect(vars[PLAIN]).toEqual({ type: "plain_text", value: "plain-1" });
    const live = await op.read(cfActx(), params);
    expect(op.diff(live, params).map((d) => d.kind)).toEqual(["unchanged", "unchanged"]);
  });

  it("assumption CF3: a secret's value is never returned; its type is", async () => {
    const v = (await previewVars())[SECRET_VAR];
    expect(v?.type).toBe("secret_text");
    expect(v?.value === undefined || v?.value === null || v?.value === "").toBe(true);
  });

  it("assumption CF4: a key set to null is deleted, and the others stay", async () => {
    const live = await op.read(cfActx(), params);
    await op.destroy(cfActx(), live!.resources);
    const vars = await previewVars();
    expect(vars[PLAIN] ?? null).toBeNull();
    expect(vars[SECRET_VAR] ?? null).toBeNull();
    expect(vars[OTHER]).toEqual({ type: "plain_text", value: "other" });
  });
});

const SUPABASE_LIVE = LIVE && Boolean(process.env.SUPABASE_ACCESS_TOKEN && process.env.SPONSON_LIVE_SUPABASE_PROJECT);

describe.skipIf(LIVE && !SUPABASE_LIVE)(`contract supabase (${SUPABASE_LIVE ? "@live" : "sim"})`, () => {
  const branchOp = supabaseAdapter.ops.branch!;
  const redirectOp = supabaseAdapter.ops.auth_redirect!;
  const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
  const params = branchOp.defaults!({}, ctx);
  const redirect = () => ({ key: `redirect:${callbackUrl}`, id: `${project}:${callbackUrl}`, hash: "" });
  let ssim: SimHandle | null = null;
  let senv: NodeJS.ProcessEnv;
  let project: string;
  let listBefore: string[] = [];
  let siteUrlBefore: unknown;

  const sactx = (): AdapterContext => ({ ctx, provider: { project }, env: senv, log: () => {}, intend: async () => {}, redact: (t) => t });
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${senv.SUPABASE_API_URL ?? SUPABASE_DEFAULT_API_URL}${path}`, { ...init, headers: { authorization: `Bearer ${senv.SUPABASE_ACCESS_TOKEN}`, "content-type": "application/json" } });
  const authConfig = async () => (await (await api(`/projects/${project}/config/auth`)).json()) as { uri_allow_list: string | null; site_url?: unknown };
  const entries = (s: string | null) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  beforeAll(async () => {
    if (SUPABASE_LIVE) {
      senv = { ...process.env };
      project = process.env.SPONSON_LIVE_SUPABASE_PROJECT!;
    } else {
      ssim = await startSim();
      senv = { ...simEnv(ssim), SPONSON_HTTP_RETRY_BASE_MS: "5" };
      project = SUPABASE_DEMO_PROJECT;
    }
    const before = await authConfig();
    listBefore = entries(before.uri_allow_list);
    siteUrlBefore = before.site_url;
  }, 60_000);

  afterAll(async () => {
    // Always clean up, even when assertions failed half-way.
    const live = await branchOp.read(sactx(), params).catch(() => null);
    if (live) await branchOp.destroy(sactx(), live.resources).catch(() => {});
    await redirectOp.destroy(sactx(), [redirect()]).catch(() => {});
    await ssim?.close();
  }, 120_000);

  it("assumption S1, S3, S4: a created branch comes up ACTIVE_HEALTHY with its own ref and database credentials", async () => {
    const r = await branchOp.apply(sactx(), params, null);
    expect(r.created).toEqual([`branch:${String(params.name)}`]);
    expect(String(r.outputs.project_ref)).toMatch(/^[a-z]{20}$/);
    expect(r.outputs.api_url).toBe(`https://${String(r.outputs.project_ref)}.supabase.co`);
    expect(String(r.outputs.connection_string)).toMatch(/^postgresql:\/\/[^:]+:[^@]+@[^:/]+:\d+\/postgres$/);
  }, 900_000);

  it("assumption S2: the branch list names the new branch with its own project_ref; the project's own branch is the default", async () => {
    const res = await api(`/projects/${project}/branches`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string; project_ref: string; is_default: boolean }>;
    const mine = list.find((b) => b.name === params.name);
    expect(mine?.is_default).toBe(false);
    expect(mine?.project_ref).not.toBe(project);
    for (const b of list.filter((x) => x.is_default)) expect(b.project_ref).toBe(project);
  });

  it("assumption S5: creating a branch whose name exists is refused (400, 409 or 422), and apply claims the existing one", async () => {
    const res = await api(`/projects/${project}/branches`, { method: "POST", body: JSON.stringify({ branch_name: params.name }) });
    expect([400, 409, 422]).toContain(res.status);
    expect((await branchOp.apply(sactx(), params, null)).created).toEqual([]);
  }, 900_000);

  it("assumption S7, S8: PATCH with uri_allow_list alone appends one comma-separated entry and leaves the rest", async () => {
    const r = await redirectOp.apply(sactx(), { url: callbackUrl }, null);
    expect(r.created).toEqual([redirect().key]);
    const after = await authConfig();
    expect(entries(after.uri_allow_list)).toEqual([...listBefore, callbackUrl]);
    expect(after.site_url).toEqual(siteUrlBefore);
  });

  it("assumption S9: a branch's own Auth allow-list is read and written through /projects/{branch ref}/config/auth", async () => {
    const live = await branchOp.read(sactx(), params);
    const ref = String(live!.outputs.project_ref);
    const r = await redirectOp.apply(sactx(), { url: callbackUrl, project: ref }, null);
    expect(r.created).toEqual([`redirect:${ref}:${callbackUrl}`]);
    expect(await redirectOp.read(sactx(), { url: callbackUrl, project: ref })).not.toBeNull();
    await redirectOp.destroy(sactx(), r.resources);
    expect(await redirectOp.read(sactx(), { url: callbackUrl, project: ref })).toBeNull();
  });

  it("assumption S6: DELETE /branches/{ref} removes the branch from the list at once; the allow-list is restored", async () => {
    const live = await branchOp.read(sactx(), params);
    await branchOp.destroy(sactx(), live!.resources);
    expect(await branchOp.read(sactx(), params)).toBeNull();
    await redirectOp.destroy(sactx(), [redirect()]);
    expect(entries((await authConfig()).uri_allow_list)).toEqual(listBefore);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// PlanetScale (assumptions PS1… in packages/sim/src/routes/planetscale.ts)
// ---------------------------------------------------------------------------

const PS_MISSING = ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN", "SPONSON_LIVE_PLANETSCALE_ORG", "SPONSON_LIVE_PLANETSCALE_DATABASE"].filter((k) => !process.env[k]);
const PS_LIVE = LIVE && PS_MISSING.length === 0;

describe.skipIf(LIVE && !PS_LIVE)(`contract planetscale (${PS_LIVE ? "@live" : "sim"})`, () => {
  const psBranch = `sponson-contract-${tag}`;
  let psSim: SimHandle | null = null;
  let psEnv: NodeJS.ProcessEnv;
  let psProvider: { organization: string; database: string };
  let base: string;
  let auth: string;

  beforeAll(async () => {
    if (PS_LIVE) {
      psEnv = { ...process.env };
      psProvider = { organization: process.env.SPONSON_LIVE_PLANETSCALE_ORG!, database: process.env.SPONSON_LIVE_PLANETSCALE_DATABASE! };
    } else {
      psSim = await startSim();
      psEnv = { ...cliEnv(psSim), SPONSON_PLANETSCALE_POLL_MS: "10" };
      psProvider = { organization: "acme", database: "app" };
    }
    base = `${psEnv.PLANETSCALE_API_URL ?? PLANETSCALE_DEFAULT_API_URL}/organizations/${psProvider.organization}/databases/${psProvider.database}`;
    auth = `${psEnv.PLANETSCALE_SERVICE_TOKEN_ID}:${psEnv.PLANETSCALE_SERVICE_TOKEN}`;
  });

  afterAll(async () => {
    // Deleting the branch deletes its password too; already gone is fine.
    await fetch(`${base}/branches/${psBranch}`, { method: "DELETE", headers: { authorization: auth } }).catch(() => {});
    await psSim?.close();
  }, 120_000);

  function psActx(): AdapterContext {
    const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
    return { ctx, provider: psProvider, env: psEnv, log: () => {}, intend: async () => {}, redact: (t) => t };
  }

  async function getBranch(): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/branches/${psBranch}`, { headers: { authorization: auth } });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : {} };
  }

  it("assumption PS1: a service token is sent as `Authorization: <id>:<token>`; as a bearer token it is refused", async () => {
    const ok = await fetch(`${base}/branches`, { headers: { authorization: auth } });
    expect(ok.status).toBe(200);
    const bearer = await fetch(`${base}/branches`, { headers: { authorization: `Bearer ${psEnv.PLANETSCALE_SERVICE_TOKEN}` } });
    expect(bearer.status).toBe(401);
  });

  it("assumption PS4: a created branch answers 201 not ready, and becomes ready later", async () => {
    const res = await fetch(`${base}/branches`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ name: psBranch, parent_branch: "main" }) });
    expect(res.status).toBe(201);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ name: psBranch, ready: false });
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const b = await getBranch();
      expect(b.status).toBe(200);
      if (b.body.ready === true) break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, PS_LIVE ? 5000 : 10));
    }
  }, 11 * 60_000);

  it("assumption PS5: creating a branch whose name exists answers 422 (the adapter also accepts 409)", async () => {
    const res = await fetch(`${base}/branches`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ name: psBranch, parent_branch: "main" }) });
    expect(res.status).toBe(422);
  });

  it("assumption PS8: a password's plaintext is in the create answer and in no read", async () => {
    const op = planetscaleAdapter.ops.password!;
    const params = op.defaults!({ branch: psBranch }, psActx().ctx);
    const r = await op.apply(psActx(), params, null);
    expect(String(r.outputs.connection_string)).toMatch(/^mysql:\/\/[^:]+:[^@]+@[^/]+\//);
    expect(typeof r.outputs.password).toBe("string");
    const list = await fetch(`${base}/branches/${psBranch}/passwords`, { headers: { authorization: auth } });
    const data = ((await list.json()) as { data: Array<Record<string, unknown>> }).data;
    expect(data.length).toBeGreaterThan(0);
    for (const p of data) expect(p.plain_text ?? null).toBeNull();
    const live = await op.read(psActx(), params);
    expect(live?.outputs).not.toHaveProperty("connection_string");
    expect(live?.outputs).not.toHaveProperty("password");
  });

  it("assumption PS7: a deleted branch is gone when DELETE returns", async () => {
    const op = planetscaleAdapter.ops.branch!;
    const params = { name: psBranch, parent: "main" };
    const live = await op.read(psActx(), params);
    expect(live).not.toBeNull();
    await op.destroy(psActx(), live!.resources);
    expect(await op.read(psActx(), params)).toBeNull();
  }, 120_000);
});

/**
 * Netlify (`assumption NL…`, packages/sim/src/routes/netlify.ts). Live only with NETLIFY_AUTH_TOKEN and
 * SPONSON_LIVE_NETLIFY_SITE (a throwaway site's Project ID; SPONSON_LIVE_NETLIFY_ACCOUNT optional), and skipped
 * otherwise, so a live run of the other providers does not need a Netlify account. It writes one variable,
 * `SPONSON_CONTRACT_<tag>`, with values in the `branch` context (this run's unique branch) and `dev` only — never
 * production or Deploy Previews — and deletes it in `afterAll`.
 */
const NETLIFY_LIVE = Boolean(process.env.NETLIFY_AUTH_TOKEN && process.env.SPONSON_LIVE_NETLIFY_SITE);

describe.skipIf(LIVE && !NETLIFY_LIVE)(`contract netlify (${LIVE ? "@live" : "sim"})`, () => {
  const op = netlifyAdapter.ops.env!;
  const KEY = `SPONSON_CONTRACT_${tag.toUpperCase()}`;
  const provider = (): Record<string, string | undefined> =>
    LIVE ? { site: process.env.SPONSON_LIVE_NETLIFY_SITE, ...(process.env.SPONSON_LIVE_NETLIFY_ACCOUNT ? { account: process.env.SPONSON_LIVE_NETLIFY_ACCOUNT } : {}) } : { site: "site_demo" };
  const nctx = (): AdapterContext => ({ ...actx("clerk"), provider: provider() });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${env.NETLIFY_API_URL ?? NETLIFY_DEFAULT_API_URL}${path}`, { ...init, headers: { authorization: `Bearer ${env.NETLIFY_AUTH_TOKEN}`, "content-type": "application/json" } });
  let account = "";
  const site = () => String(provider().site);
  const varPath = (suffix = "") => `/accounts/${encodeURIComponent(account)}/env${suffix}?site_id=${encodeURIComponent(site())}`;
  const branchParams = (value: string) => op.defaults!({ context: "branch", values: { [KEY]: value } }, nctx().ctx);
  const devParams = (value: string) => op.defaults!({ context: "dev", values: { [KEY]: value } }, nctx().ctx);
  type Var = { values: Array<{ id: string; context: string; value?: string }>; updated_at?: string };
  const getVar = async (): Promise<Var | null> => {
    const res = await call(varPath(`/${KEY}`));
    return res.status === 404 ? null : ((await res.json()) as Var);
  };

  afterAll(async () => {
    if (account) await call(varPath(`/${KEY}`), { method: "DELETE" }).catch(() => {});
  }, 60_000);

  it("assumption NL2: GET /sites/{site_id} carries `name` and the site's account", async () => {
    const res = await call(`/sites/${encodeURIComponent(site())}`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { name?: unknown; account_id?: unknown; account_slug?: unknown; ssl_url?: unknown };
    expect(typeof s.name).toBe("string");
    expect(typeof s.account_id === "string" || typeof s.account_slug === "string").toBe(true);
    // `name` is the `<name>.netlify.app` subdomain the permalink and Deploy Preview URLs are built on.
    if (typeof s.ssl_url === "string" && s.ssl_url.endsWith(".netlify.app")) expect(s.ssl_url).toBe(`https://${String(s.name)}.netlify.app`);
    account = provider().account ?? String(s.account_id ?? s.account_slug);
  });

  it("assumption NL3: a branch value and a dev value are separate; PATCH replaces one in place and leaves the other", async () => {
    const created = await op.apply(nctx(), branchParams("one"), null);
    expect(created.created).toEqual([`env:branch:${branch}:${KEY}`]);
    await op.apply(nctx(), devParams("dev"), null);
    const dev = (await getVar())!.values.find((v) => v.context === "dev");
    await op.apply(nctx(), branchParams("two"), await op.read(nctx(), branchParams("two")));
    const after = (await getVar())!;
    expect(after.values.find((v) => v.context === "dev")).toEqual(dev);
    const mine = after.values.find((v) => v.context === "branch")!;
    expect(mine.value).toBe("two");
    // The value keeps its id (the ledger's resource id) when PATCH replaces it.
    expect(mine.id).toBe(created.resources[0]!.id);
    expect(op.diff(await op.read(nctx(), branchParams("two")), branchParams("two"))[0]!.kind).toBe("unchanged");
  });

  it("assumption NL10: PATCH bumps the variable's `updated_at`", async () => {
    const before = Date.parse(String((await getVar())!.updated_at));
    await new Promise((r) => setTimeout(r, 1100));
    await op.apply(nctx(), branchParams("three"), await op.read(nctx(), branchParams("three")));
    expect(Date.parse(String((await getVar())!.updated_at))).toBeGreaterThan(before);
  });

  it("assumption NL5: POST of a key that exists is refused with 400 or 409 and changes nothing", async () => {
    const before = await getVar();
    const res = await call(varPath(), { method: "POST", body: JSON.stringify([{ key: KEY, values: [{ context: "dev", value: "dup" }] }]) });
    expect([400, 409]).toContain(res.status);
    expect(await getVar()).toEqual(before);
  });

  it("assumption NL7: GET /sites/{site_id}/deploys is a list of { id, state, created_at, context }, newest first", async () => {
    const res = await call(`/sites/${encodeURIComponent(site())}/deploys?page=1&per_page=5`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    for (const d of list) {
      expect(typeof d.id).toBe("string");
      expect(typeof d.state).toBe("string");
      expect(Number.isFinite(Date.parse(String(d.created_at)))).toBe(true);
      if (d.context !== undefined && d.context !== null) expect(["production", "deploy-preview", "branch-deploy"]).toContain(d.context);
    }
    const times = list.map((d) => Date.parse(String(d.created_at)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("assumption NL6: destroying the last values leaves no variable behind", async () => {
    const branchLive = await op.read(nctx(), branchParams("x"));
    const devLive = await op.read(nctx(), devParams("x"));
    await op.destroy(nctx(), branchLive!.resources);
    expect((await getVar())!.values.map((v) => v.context)).toEqual(["dev"]);
    await op.destroy(nctx(), devLive!.resources);
    expect(await getVar()).toBeNull();
  });
});

/**
 * Algolia (`assumption AL…`, packages/sim/src/routes/algolia.ts). Live only with ALGOLIA_API_KEY (addObject,
 * deleteIndex and settings ACLs), SPONSON_LIVE_ALGOLIA_APP_ID and SPONSON_LIVE_ALGOLIA_TEMPLATE (an index to copy);
 * it copies the template into `sponson_contract_<tag>` and deletes the copy in `afterAll`.
 */
const AL_LIVE = ["ALGOLIA_API_KEY", "SPONSON_LIVE_ALGOLIA_APP_ID", "SPONSON_LIVE_ALGOLIA_TEMPLATE"].every((k) => process.env[k]);
describe.skipIf(LIVE && !AL_LIVE)(`contract: algolia (${LIVE ? "@live" : "sim"})`, () => {
  const op = algoliaAdapter.ops.index!;
  const appId = () => (LIVE ? process.env.SPONSON_LIVE_ALGOLIA_APP_ID! : "APP123");
  const params = () => ({ name: `sponson_contract_${tag}`, copy_from: LIVE ? process.env.SPONSON_LIVE_ALGOLIA_TEMPLATE! : "products" });
  const alctx = (): AdapterContext => {
    const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
    return { ctx, provider: { application_id: appId() }, env: { ...env, SPONSON_ALGOLIA_POLL_MS: LIVE ? "1000" : "1" }, log: () => {}, intend: async () => {}, redact: (t) => t };
  };
  const settings = async (name: string) => {
    const res = await fetch(`${env.ALGOLIA_API_URL ?? `https://${appId()}.algolia.net`}/1/indexes/${encodeURIComponent(name)}/settings`, { headers: { "x-algolia-api-key": env.ALGOLIA_API_KEY ?? "", "x-algolia-application-id": appId() } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  afterAll(async () => {
    await op.destroy(alctx(), [{ key: `index:${params().name}`, id: params().name, hash: "" }]).catch(() => {});
  });

  it("assumption AL3, AL4, AL5: a copy, once its task is published, has the template's settings; before, it does not exist", async () => {
    expect((await settings(params().name)).status).toBe(404);
    const r = await op.apply(alctx(), params(), null);
    expect(r.created).toEqual([`index:${params().name}`]);
    expect((await settings(params().name)).body).toEqual((await settings(params().copy_from)).body);
    expect(op.diff(await op.read(alctx(), params()), params())[0]!.kind).toBe("unchanged");
  });

  it("assumption AL6: deleting the copy removes it, and deleting it again succeeds", async () => {
    const live = await op.read(alctx(), params());
    await op.destroy(alctx(), live!.resources);
    expect(await op.read(alctx(), params())).toBeNull();
    await op.destroy(alctx(), live!.resources);
  });
});

/**
 * Xata (`assumption XA…`, packages/sim/src/routes/xata.ts). Live only with XATA_API_KEY, SPONSON_LIVE_XATA_ORG,
 * SPONSON_LIVE_XATA_PROJECT and SPONSON_LIVE_XATA_PARENT (a branch id to copy); it creates the branch
 * `sponson-contract-<tag>` (billed while it exists) and deletes it in `afterAll`.
 */
const XA_LIVE = ["XATA_API_KEY", "SPONSON_LIVE_XATA_ORG", "SPONSON_LIVE_XATA_PROJECT", "SPONSON_LIVE_XATA_PARENT"].every((k) => process.env[k]);
describe.skipIf(LIVE && !XA_LIVE)(`contract: xata (${LIVE ? "@live" : "sim"})`, () => {
  const op = xataAdapter.ops.branch!;
  const params = { name: `sponson-contract-${tag}`, parent_id: LIVE ? process.env.SPONSON_LIVE_XATA_PARENT! : "br_main" };
  const xactx = (): AdapterContext => {
    const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
    const provider = LIVE ? { organization: process.env.SPONSON_LIVE_XATA_ORG!, project: process.env.SPONSON_LIVE_XATA_PROJECT! } : { organization: "acme", project: "app" };
    return { ctx, provider, env: { ...env, SPONSON_XATA_POLL_MS: LIVE ? "2000" : "1" }, log: () => {}, intend: async () => {}, redact: (t) => t };
  };
  let made: { key: string; id: string; hash: string } | undefined;

  afterAll(async () => {
    if (made) await op.destroy(xactx(), [made]).catch(() => {});
  }, 120_000);

  it("assumption XA2, XA5, XA6: a child branch comes up healthy, and its connection string is readable again later", async () => {
    const r = await op.apply(xactx(), params, null);
    made = r.resources[0];
    expect(String(r.outputs.connection_string)).toMatch(/^postgres(ql)?:\/\//);
    const live = await op.read(xactx(), params);
    expect(live!.outputs.connection_string).toBe(r.outputs.connection_string);
    expect(op.diff(live, params)[0]!.kind).toBe("unchanged");
  }, 15 * 60_000);

  it("assumption XA4: a deleted branch is gone from the list when DELETE returns", async () => {
    await op.destroy(xactx(), [made!]);
    expect(await op.read(xactx(), params)).toBeNull();
    made = undefined;
  }, 120_000);
});

/**
 * DigitalOcean App Platform (`assumption DO…`, packages/sim/src/routes/digitalocean.ts). Live only with
 * DIGITALOCEAN_ACCESS_TOKEN and SPONSON_LIVE_DIGITALOCEAN=1 (it creates the static-site app `sponson-ct-<tag>` from
 * a public sample repository, billed while it exists, and deletes it in `afterAll`).
 */
const DO_LIVE = !!process.env.DIGITALOCEAN_ACCESS_TOKEN && process.env.SPONSON_LIVE_DIGITALOCEAN === "1";
describe.skipIf(LIVE && !DO_LIVE)(`contract: digitalocean (${LIVE ? "@live" : "sim"})`, () => {
  const op = digitaloceanAdapter.ops.app!;
  const params = {
    spec: {
      name: `sponson-ct-${tag}`,
      static_sites: [{ name: "site", git: { repo_clone_url: "https://github.com/digitalocean/sample-html.git", branch: "main" } }],
      envs: [{ key: "SPONSON_CONTRACT", value: tag, scope: "BUILD_TIME" }, { key: "SPONSON_SECRET", value: SECRET, type: "SECRET", scope: "BUILD_TIME" }],
    },
  };
  const dctx = (): AdapterContext => {
    const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
    return { ctx, provider: {}, env: { ...env, SPONSON_DIGITALOCEAN_POLL_MS: LIVE ? "10000" : "1" }, log: () => {}, intend: async () => {}, redact: (t) => t };
  };
  let made: { key: string; id: string; hash: string } | undefined;

  afterAll(async () => {
    if (made) await op.destroy(dctx(), [made]).catch(() => {});
  }, 120_000);

  it("assumption DO2, DO5, DO6, DO7: a created app deploys, and reads back unchanged (defaults ignored, secret encrypted)", async () => {
    const r = await op.apply(dctx(), params, null);
    made = r.resources[0];
    const live = await op.read(dctx(), params);
    expect(op.diff(live, params)[0]!.kind).toBe("unchanged");
    expect(typeof live!.outputs.live_url).toBe("string");
  }, 25 * 60_000);

  it("assumption DO8: a deleted app is gone from the list", async () => {
    await op.destroy(dctx(), [made!]);
    expect(await op.read(dctx(), params)).toBeNull();
    made = undefined;
  }, 120_000);
});

/**
 * Google Cloud Run (`assumption CR…`, packages/sim/src/routes/cloud_run.ts). Live only with gcloud on PATH, logged in
 * to an account that may update the service, SPONSON_LIVE_CLOUD_RUN=1, SPONSON_LIVE_GCP_PROJECT,
 * SPONSON_LIVE_CLOUD_RUN_REGION, SPONSON_LIVE_CLOUD_RUN_SERVICE (an existing, throwaway service) and
 * SPONSON_LIVE_CLOUD_RUN_IMAGE (an image it can run, e.g. us-docker.pkg.dev/cloudrun/container/hello). It makes one
 * revision tagged `sponson-ct-<tag>` with no traffic and removes the tag in `afterAll`; the revision is left for Cloud
 * Run's retention. The line sets `pin_latest: true`: a share of traffic on LATEST is pinned to the revision serving it (CR5).
 */
const CR_VARS = ["SPONSON_LIVE_GCP_PROJECT", "SPONSON_LIVE_CLOUD_RUN_REGION", "SPONSON_LIVE_CLOUD_RUN_SERVICE", "SPONSON_LIVE_CLOUD_RUN_IMAGE"];
const CR_LIVE = process.env.SPONSON_LIVE_CLOUD_RUN === "1" && CR_VARS.every((k) => process.env[k]);
describe.skipIf(LIVE && !CR_LIVE)(`contract: cloud_run (${LIVE ? "@live" : "sim"})`, () => {
  const SIM_TOKEN = "ya29.contract-sim-token";
  const op = (LIVE ? cloudRunAdapter : createCloudRunAdapter({ exec: async () => SIM_TOKEN })).ops.revision!;
  const place = LIVE ? { project: process.env.SPONSON_LIVE_GCP_PROJECT!, region: process.env.SPONSON_LIVE_CLOUD_RUN_REGION! } : { project: "demo-project", region: "us-central1" };
  const service = LIVE ? process.env.SPONSON_LIVE_CLOUD_RUN_SERVICE! : "web";
  const params = { service, tag: `sponson-ct-${tag}`, image: LIVE ? process.env.SPONSON_LIVE_CLOUD_RUN_IMAGE! : "us-docker.pkg.dev/cloudrun/container/hello", env: { SPONSON_CONTRACT: tag, SPONSON_SECRET: SECRET }, pin_latest: true };
  const rctx = (): AdapterContext => {
    const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
    return { ctx, provider: place, env: { ...env, SPONSON_CLOUD_RUN_POLL_MS: LIVE ? "3000" : "1" }, log: () => {}, intend: async () => {}, redact: (t) => t };
  };
  /** The service as the API answers it, read directly (CR2). */
  const token = () => (LIVE ? execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim() : SIM_TOKEN);
  const serviceUrl = () => `${env.CLOUD_RUN_API_URL ?? CLOUD_RUN_DEFAULT_API_URL}/v2/projects/${place.project}/locations/${place.region}/services/${service}`;
  const getService = async () => (await (await fetch(serviceUrl(), { headers: { authorization: `Bearer ${token()}` } })).json()) as { etag: string; traffic?: unknown[]; trafficStatuses?: Array<{ revision?: string; percent?: number; tag?: string; uri?: string }> };
  /** Who serves what share: what must never change. */
  const shares = (s: Awaited<ReturnType<typeof getService>>) => (s.trafficStatuses ?? []).filter((t) => (t.percent ?? 0) > 0).map((t) => `${t.revision}=${t.percent}`).sort();
  let made: { key: string; id: string; hash: string } | undefined;
  let before: string[] = [];

  beforeAll(async () => {
    before = shares(await getService());
  }, 60_000);
  afterAll(async () => {
    if (made) await op.destroy(rctx(), [made]).catch(() => {});
  }, 300_000);

  it("assumption CR3, CR4, CR5, CR6, CR9, CR10, CR11: a revision is made, tagged with its own URL, and no share of traffic moves", async () => {
    const r = await op.apply(rctx(), params, null);
    made = r.resources[0];
    expect(String(r.outputs.url)).toMatch(new RegExp(`^https://sponson-ct-${tag}---`));
    expect(shares(await getService())).toEqual(before);
    const live = await op.read(rctx(), params);
    expect(op.diff(live, params)[0]!.kind).toBe("unchanged");
  }, 15 * 60_000);

  it("assumption CR8: a patch with a stale etag is refused and changes nothing", async () => {
    const s = await getService();
    const res = await fetch(`${serviceUrl()}?updateMask=traffic`, { method: "PATCH", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify({ traffic: s.traffic ?? [], etag: '"sponson-stale-etag"' }) });
    expect([409, 412]).toContain(res.status);
    expect((await getService()).etag).toBe(s.etag);
  }, 120_000);

  it("assumption CR5, CR11: destroy removes the tag, and every share of traffic is where it was", async () => {
    await op.destroy(rctx(), [made!]);
    const s = await getService();
    expect((s.trafficStatuses ?? []).some((t) => t.tag === params.tag)).toBe(false);
    expect(shares(s)).toEqual(before);
    expect(await op.read(rctx(), params)).toBeNull();
    made = undefined;
  }, 15 * 60_000);
});
