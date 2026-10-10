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
 * Each `assumption <id>:` test pins the API assumption with that id, listed at the top of the sim's provider
 * file (packages/sim/src/routes/{vercel,neon,clerk,planetscale}.ts). If one fails live, fix the sim first, then the
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
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLERK_DEFAULT_API_URL, PLANETSCALE_DEFAULT_API_URL, clerkAdapter, neonAdapter, planetscaleAdapter, vercelAdapter } from "@sponson/adapters";
import type { AdapterContext, Ctx } from "@sponson/core";
import { startSim, type SimHandle } from "@sponson/sim";
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
