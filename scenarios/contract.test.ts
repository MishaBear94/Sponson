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
 *   [LAUNCHDARKLY_ACCESS_TOKEN=api-... SPONSON_LIVE_LAUNCHDARKLY_PROJECT=... \
 *    SPONSON_LIVE_LAUNCHDARKLY_ENVIRONMENT=... SPONSON_LIVE_LAUNCHDARKLY_FLAG=<a boolean flag>] \
 *   pnpm test:live
 *
 * The LaunchDarkly assumptions run live only when its four variables are set (it is optional, so a live run of
 * the original three providers needs no LaunchDarkly account); they add and remove one individual target,
 * `sponson-contract-<random>`, on the given flag and environment. Use a test environment without required approvals.
 *
 * Use throwaway projects: the suite creates a Neon branch, preview env vars on a
 * unique git branch name, and a Clerk redirect URL, and destroys them in `afterAll`
 * even when an assertion fails. It never touches the production target.
 *
 * Each `assumption <id>:` test pins the API assumption with that id, listed at the top of the sim's provider
 * file (packages/sim/src/routes/{vercel,neon,clerk}.ts). If one fails live, fix the sim first, then the adapter.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLERK_DEFAULT_API_URL, LAUNCHDARKLY_DEFAULT_API_URL, clerkAdapter, launchdarklyAdapter, neonAdapter, vercelAdapter } from "@sponson/adapters";
import type { AdapterContext, Ctx } from "@sponson/core";
import { startSim, type SimHandle } from "@sponson/sim";
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

function actx(adapter: "vercel" | "neon" | "clerk" | "launchdarkly"): AdapterContext {
  const ctx: Ctx = { env: "preview", git: { branch, sha, short_sha: sha.slice(0, 7) }, pr: { number: pr }, scope: `pr-${pr}` };
  const provider = adapter === "clerk" ? {} : adapter === "launchdarkly" ? { project: ld.project, environment: ld.environment } : providers[adapter];
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

  it.skipIf(!LD_RUNS)("assumption LD5: adding a target its variation already serves succeeds and changes nothing; LD7: visible at once", async () => {
    const key = `sponson-contract-${tag}`;
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
    const params = op.defaults!({ flag: ld.flag, key: `sponson-contract-${tag}-adapter` }, actx("launchdarkly").ctx);
    const applied = await op.apply(actx("launchdarkly"), params, null);
    try {
      const live = await op.read(actx("launchdarkly"), params);
      expect(live?.resources).toEqual(applied.resources);
      expect(op.diff(live, params)[0]!.kind).toBe("unchanged");
    } finally {
      await op.destroy(actx("launchdarkly"), applied.resources);
    }
    expect(await op.read(actx("launchdarkly"), params)).toBeNull();
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
