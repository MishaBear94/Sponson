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
 *   pnpm test:live
 *
 * Use throwaway projects: the suite creates a Neon branch, preview env vars on a
 * unique git branch name, and a Clerk redirect URL, and destroys them in `afterAll`
 * even when an assertion fails. It never touches the production target.
 *
 * Each `assumption <id>:` test pins the API assumption with that id, listed at the top of the sim's provider
 * file (packages/sim/src/routes/{vercel,neon,clerk,netlify}.ts). If one fails live, fix the sim first, then the adapter.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLERK_DEFAULT_API_URL, NETLIFY_DEFAULT_API_URL, clerkAdapter, neonAdapter, netlifyAdapter, vercelAdapter } from "@sponson/adapters";
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
