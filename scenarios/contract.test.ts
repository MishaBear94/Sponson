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
 * Cloudflare is optional in a live run: its block runs when these are set too, and is skipped otherwise.
 *
 *   CLOUDFLARE_API_TOKEN=... SPONSON_LIVE_CLOUDFLARE_ACCOUNT=<account id> SPONSON_LIVE_CLOUDFLARE_PROJECT=<pages project>
 *
 * It writes three preview variables named `SPONSON_CONTRACT_<tag>_*` to that Pages project and removes them in
 * `afterAll`; use a throwaway project, since a preview deployment started meanwhile would see them.
 *
 * Each `assumption <id>:` test pins the API assumption with that id, listed at the top of the sim's provider
 * file (packages/sim/src/routes/{vercel,neon,clerk,cloudflare}.ts). If one fails live, fix the sim first, then the
 * adapter.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLERK_DEFAULT_API_URL, CLOUDFLARE_DEFAULT_API_URL, clerkAdapter, cloudflareAdapter, neonAdapter, vercelAdapter } from "@sponson/adapters";
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

const CF_LIVE = ["CLOUDFLARE_API_TOKEN", "SPONSON_LIVE_CLOUDFLARE_ACCOUNT", "SPONSON_LIVE_CLOUDFLARE_PROJECT"].every((k) => process.env[k]);

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
