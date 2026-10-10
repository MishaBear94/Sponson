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
 *   pnpm test:live
 *
 * Use throwaway projects: the suite creates a Neon branch, preview env vars on a
 * unique git branch name, and a Clerk redirect URL, and destroys them in `afterAll`
 * even when an assertion fails. It never touches the production target.
 *
 * Supabase is optional in a live run, because branching needs a paid plan: with SUPABASE_ACCESS_TOKEN and
 * SPONSON_LIVE_SUPABASE_PROJECT (the parent project's ref, branching enabled) also set, the Supabase block runs
 * live; without them it is skipped under SPONSON_LIVE=1. It creates one preview branch (billed while it exists;
 * it may take minutes to come up) and one Auth redirect URL, and removes both in its `afterAll`.
 *
 * Each `assumption <id>:` test pins the API assumption with that id, listed at the top of the sim's provider
 * file (packages/sim/src/routes/{vercel,neon,clerk,supabase}.ts). If one fails live, fix the sim first, then the
 * adapter.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLERK_DEFAULT_API_URL, SUPABASE_DEFAULT_API_URL, clerkAdapter, neonAdapter, supabaseAdapter, vercelAdapter } from "@sponson/adapters";
import type { AdapterContext, Ctx } from "@sponson/core";
import { SUPABASE_DEMO_PROJECT, simEnv, startSim, type SimHandle } from "@sponson/sim";
import { cliEnv, runCli, workspace, type CliRun, type Workspace } from "./support.js";

const LIVE = process.env.SPONSON_LIVE === "1";
const MISSING = ["VERCEL_TOKEN", "SPONSON_LIVE_VERCEL_PROJECT", "NEON_API_KEY", "SPONSON_LIVE_NEON_PROJECT", "CLERK_SECRET_KEY"].filter((k) => !process.env[k]);
if (LIVE && MISSING.length) throw new Error(`SPONSON_LIVE=1 but missing: ${MISSING.join(", ")}`);

const tag = randomBytes(4).toString("hex");
const pr = 900000 + (parseInt(tag, 16) % 99999); // unique scope per run, never collides with a real PR
const branch = `sponson-contract-${tag}`;
const sha = randomBytes(20).toString("hex");
const callbackUrl = `https://sponson-contract-${tag}.example.com/callback`;
const SECRET = `contract-secret-${tag}`;

let sim: SimHandle | null = null;
let env: NodeJS.ProcessEnv;
let ws: Workspace;
let providers: { vercel: Record<string, unknown>; neon: Record<string, unknown> };

beforeAll(async () => {
  if (LIVE) {
    env = { ...process.env };
    providers = {
      vercel: { project: process.env.SPONSON_LIVE_VERCEL_PROJECT, ...(process.env.SPONSON_LIVE_VERCEL_TEAM ? { team: process.env.SPONSON_LIVE_VERCEL_TEAM } : {}) },
      neon: { project: process.env.SPONSON_LIVE_NEON_PROJECT },
    };
  } else {
    sim = await startSim();
    env = cliEnv(sim);
    providers = { vercel: { project: "prj_demo" }, neon: { project: "proj_demo" } };
  }
  env.SPONSON_CONTRACT_SECRET = SECRET;
  // No deploy-dependent line: a live run must not depend on a git push reaching Vercel.
  ws = await workspace("contract", {
    plan: `version: 1
providers:
  vercel: ${JSON.stringify(providers.vercel)}
  neon: ${JSON.stringify(providers.neon)}
changes:
  - id: db
    adapter: neon
    op: branch
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
      CONTRACT_TOKEN: { secret: "env://SPONSON_CONTRACT_SECRET" }
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: ${callbackUrl}
`,
  });
}, 60_000);

afterAll(async () => {
  // Always clean up, even when assertions failed half-way.
  if (ws) await cli(["apply", "--destroy"]).catch(() => {});
  await sim?.close();
  await ws?.cleanup();
}, 120_000);

function cli(args: string[]): Promise<CliRun> {
  return runCli([...args, "--json", "--receipts", "local", "--receipts-dir", join(ws.dir, "r"), "--pr", String(pr), "--branch", branch, "--sha", sha], { env, cwd: ws.dir });
}

function actx(adapter: "vercel" | "neon" | "clerk"): AdapterContext {
  const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
  return { ctx, provider: adapter === "clerk" ? {} : providers[adapter], env, log: () => {}, intend: async () => {}, redact: (t) => t };
}

describe(`contract (${LIVE ? "@live" : "sim"})`, () => {
  it("plan is read-only and sees every line", async () => {
    const r = await cli(["plan"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const lines = (r.json!.lines as Array<{ id: string; status: string }>).map((l) => [l.id, l.status]);
    expect(lines).toEqual([
      ["db", "create"],
      ["env", "pending"],
      ["callback", "create"],
    ]);
    if (sim) expect(sim.state.writes).toHaveLength(0);
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
    const params = op.defaults!({ target: "preview", values: { CONTRACT_TOKEN: SECRET } }, actx("vercel").ctx);
    const live = await op.read(actx("vercel"), params);
    // v0.2 key: env:<target>:<gitBranch|*>:<KEY> (the preview var is scoped to this run's git branch).
    const key = `env:preview:${branch}:CONTRACT_TOKEN`;
    expect(live?.resources.map((r) => r.key)).toContain(key);
    expect(op.diff(live, params).find((d) => d.key === key)?.kind).toBe("unchanged");
  });

  it("assumption N2: the Neon branch and its connection string are readable right after creation", async () => {
    const op = neonAdapter.ops.branch!;
    const params = op.defaults!({}, actx("neon").ctx);
    const live = await op.read(actx("neon"), params);
    expect(live?.resources).toHaveLength(1);
    expect(String(live?.outputs.connection_string)).toMatch(/^postgres(ql)?:\/\//);
  });

  it("assumption C2: GET /redirect_urls?paginated=true answers { data, total_count } (not in the spec; how Clerk's SDKs read it)", async () => {
    const res = await fetch(`${env.CLERK_API_URL ?? CLERK_DEFAULT_API_URL}/redirect_urls?paginated=true&limit=1`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown; total_count?: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total_count).toBe("number");
    expect(body.total_count).toBeGreaterThanOrEqual(1);
  });

  it("second apply writes nothing", async () => {
    const before = sim?.state.writes.length ?? 0;
    const r = await cli(["apply"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const receipt = r.json!.receipt as { lines: Record<string, { status: string }> };
    expect(Object.values(receipt.lines).map((l) => l.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    if (sim) expect(sim.state.writes.length).toBe(before);
  }, 120_000);

  it("assumption N1: destroy is visible immediately (Neon branch delete is synchronous enough to re-read)", async () => {
    const r = await cli(["apply", "--destroy"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const neon = neonAdapter.ops.branch!;
    expect(await neon.read(actx("neon"), neon.defaults!({}, actx("neon").ctx))).toBeNull();
    const clerk = clerkAdapter.ops.redirect_allow!;
    expect(await clerk.read(actx("clerk"), { url: callbackUrl })).toBeNull();
  }, 120_000);
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
