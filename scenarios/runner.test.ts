/**
 * Scenario runner: the acceptance suite from brainstorm/design/验收策略.md.
 *
 * Every `scenarios/<category>/<name>.yaml` is one scenario:
 *
 *   name: human title
 *   plan: |                      release.plan.yaml contents (providers default to prj_demo / proj_demo)
 *   seed: { vercel, neon, clerk } SimSeed; default seed when absent
 *   chaos: { ... }               initial POST /_chaos body
 *   ctx: { env, pr, branch, sha } defaults: preview / 42 / feat/x / <fixed sha>
 *   env: { NAME: value }         extra process env (secrets, tokens)
 *   secrets: [value, ...]        values that must never appear in any output (invariant 1)
 *   steps:
 *     - run: "apply --json"      CLI args; ctx flags and a local receipts dir are appended
 *       expect:
 *         exit: 0                exit code
 *         status: failed         receipt.status (apply)
 *         lines: { id: status }  receipt.lines[id].status
 *         plan_lines: { id: st } plan line status (plan)
 *         errors: { id: regex }  receipt.lines[id].error or plan line error
 *         drift: [{ kind, line? }]
 *         error: CODE            top-level error code when the command failed before running
 *         stdout: [substr|/re/]  stderr: [...]   warnings: [regex]
 *         writes: 0              sim writes performed during this step
 *         notes: { id: { k: v } }
 *     - chaos: { ... }           POST /_chaos
 *     - plan: |                  replace the plan file
 *     - env: { ... }             set/unset process env
 *     - sim:                     assertions on sim state
 *         vercel_env: { <target>: { KEY: exists | absent | "<value>" } }
 *         neon_branches: { <name>: exists | absent }
 *         clerk_redirects: { <url>: exists | absent }
 *         deployments: <count>
 *         write_order: [substr]  these substrings appear in the sim write log in this order
 *     - crash_after: <line id>   run apply through the engine and kill it after that line
 *     - lock: held | expired     plant a lock for the scope, as another run (or a crashed one) would
 *     - ctx: { sha, branch, pr } change the context for later steps (force-push, rename)
 *     - receipt: corrupt | delete | version2
 *     - wait: <ms>
 *
 * After every `run` step the runner checks: no secret in stdout/stderr/receipts (I1),
 * `plan` performed zero writes (I4), every receipt file parses (I6).
 */
import { readdir, readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { createRegistry } from "@sponson/adapters";
import { run } from "sponson";
import { applyRun, detectCtx, loadPlan, LocalReceiptStore, parseReceipt, Redactor } from "@sponson/core";

interface Expect {
  exit?: number;
  status?: string;
  lines?: Record<string, string>;
  plan_lines?: Record<string, string>;
  errors?: Record<string, string>;
  drift?: Array<{ kind: string; line?: string; key?: string }>;
  error?: string;
  stdout?: string[];
  stderr?: string[];
  warnings?: string[];
  writes?: number;
  notes?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, Record<string, unknown>>;
}

interface SimExpect {
  write_order?: string[];
  vercel_env?: Record<string, Record<string, string>>;
  neon_branches?: Record<string, "exists" | "absent">;
  clerk_redirects?: Record<string, "exists" | "absent">;
  deployments?: number;
}

type Step =
  | { run: string; expect?: Expect }
  | { chaos: Record<string, unknown> }
  | { plan: string }
  | { env: Record<string, string | null> }
  | { sim: SimExpect }
  | { crash_after: string }
  | { lock: "held" | "expired" }
  | { ctx: Partial<typeof DEFAULT_CTX> }
  | { receipt: "corrupt" | "delete" | "version2" }
  | { wait: number };

interface Scenario {
  name: string;
  plan: string;
  seed?: Partial<SimSeed>;
  chaos?: Record<string, unknown>;
  ctx?: { env?: string; pr?: number | null; branch?: string; sha?: string };
  env?: Record<string, string>;
  secrets?: string[];
  steps: Step[];
}

const DEFAULT_CTX = { env: "preview", pr: 42 as number | null, branch: "feat/x", sha: "0123456789abcdef0123456789abcdef01234567" };

async function listScenarios(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listScenarios(p)));
    else if (entry.name.endsWith(".yaml")) out.push(p);
  }
  return out.sort();
}

const root = new URL(".", import.meta.url).pathname;
const files = await listScenarios(root);

describe.each(files.map((f) => [relative(root, f), f] as const))("%s", (_rel, file) => {
  it("passes", async () => {
    const scenario = parseYaml(await readFile(file, "utf8")) as Scenario;
    const h = await Harness.create(scenario);
    try {
      for (const [i, step] of scenario.steps.entries()) {
        await h.step(step, i);
      }
    } finally {
      await h.close();
    }
  });
});

class Harness {
  private constructor(
    private readonly scenario: Scenario,
    private readonly sim: SimHandle,
    readonly cwd: string,
    private env: NodeJS.ProcessEnv,
    private ctx: typeof DEFAULT_CTX,
  ) {}

  /** Contents this scenario deliberately wrote over a receipt; the parse invariant skips them. */
  private tampered = new Set<string>();

  static async create(s: Scenario): Promise<Harness> {
    const sim = await startSim({ seed: s.seed });
    const cwd = await mkdtemp(join(tmpdir(), "sponson-scn-"));
    await writeFile(join(cwd, "release.plan.yaml"), s.plan);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NO_COLOR: "1",
      VERCEL_TOKEN: "tok_vercel",
      NEON_API_KEY: "tok_neon",
      CLERK_SECRET_KEY: "tok_clerk",
      VERCEL_API_URL: `${sim.url}/vercel`,
      NEON_API_URL: `${sim.url}/neon`,
      CLERK_API_URL: `${sim.url}/clerk`,
      SPONSON_RECEIPTS_DIR: join(cwd, ".sponson/receipts"),
      ...(s.env ?? {}),
    };
    const ctx = { ...DEFAULT_CTX, ...(s.ctx ?? {}) };
    if (s.chaos) await sim.state.applyChaos(s.chaos as never);
    return new Harness(s, sim, cwd, env, ctx);
  }

  async close() {
    await this.sim.close();
    await rm(this.cwd, { recursive: true, force: true });
  }

  private ctxArgs(): string[] {
    const a = ["--env", this.ctx.env, "--branch", this.ctx.branch, "--sha", this.ctx.sha, "--receipts", "local", "--receipts-dir", join(this.cwd, ".sponson/receipts")];
    if (this.ctx.pr !== null) a.push("--pr", String(this.ctx.pr));
    return a;
  }

  async step(step: Step, index: number) {
    const where = `step ${index + 1} (${JSON.stringify(step).slice(0, 60)})`;
    if ("run" in step) return this.runStep(step.run, step.expect ?? {}, where);
    if ("chaos" in step) return void (await this.sim.state.applyChaos(step.chaos as never));
    if ("plan" in step) return void (await writeFile(join(this.cwd, "release.plan.yaml"), step.plan));
    if ("env" in step) {
      for (const [k, v] of Object.entries(step.env)) {
        if (v === null) delete this.env[k];
        else this.env[k] = v;
      }
      return;
    }
    if ("sim" in step) return this.assertSim(step.sim, where);
    if ("crash_after" in step) return this.crashAfter(step.crash_after);
    if ("lock" in step) return this.plantLock(step.lock);
    if ("ctx" in step) return void (this.ctx = { ...this.ctx, ...step.ctx });
    if ("receipt" in step) return this.tamperReceipt(step.receipt);
    if ("wait" in step) return new Promise<void>((r) => setTimeout(r, step.wait));
    throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }

  private async runStep(args: string, exp: Expect, where: string) {
    const argv = [...args.split(/\s+/).filter(Boolean), ...this.ctxArgs()];
    const isPlan = argv[0] === "plan" || argv[0] === "status";
    const writesBefore = this.sim.state.writes.length;
    let stdout = "";
    let stderr = "";
    const exit = await run(argv, {
      stdout: { write: (s) => (stdout += s) },
      stderr: { write: (s) => (stderr += s) },
      env: this.env,
      cwd: this.cwd,
      color: false,
    });
    const writes = this.sim.state.writes.length - writesBefore;
    const ctx = `${where}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

    let json: Record<string, unknown> | null = null;
    if (argv.includes("--json")) {
      try {
        json = JSON.parse(stdout);
      } catch {
        throw new Error(`${ctx}\nstdout is not JSON`);
      }
    }

    // invariants
    for (const s of this.scenario.secrets ?? []) {
      expect(stdout, `${ctx}\nsecret leaked to stdout`).not.toContain(s);
      expect(stderr, `${ctx}\nsecret leaked to stderr`).not.toContain(s);
    }
    await this.checkReceipts(ctx);
    if (isPlan) expect(writes, `${ctx}\nplan performed writes`).toBe(0);

    if (exp.exit !== undefined) expect(exit, `${ctx}\nexit code`).toBe(exp.exit);
    if (exp.writes !== undefined) expect(writes, `${ctx}\nwrites`).toBe(exp.writes);
    for (const s of exp.stdout ?? []) expectContains(stdout, s, `${ctx}\nstdout`);
    for (const s of exp.stderr ?? []) expectContains(stderr, s, `${ctx}\nstderr`);
    if (exp.error) {
      const err = (json?.error ?? {}) as { code?: string };
      expect(err.code ?? stderr, `${ctx}\nerror code`).toContain(exp.error);
    }
    const receipt = (json?.receipt ?? null) as null | { status: string; lines: Record<string, { status: string; error?: string; notes?: Record<string, unknown>; outputs?: Record<string, unknown> }> };
    if (exp.status) expect(receipt?.status, `${ctx}\nreceipt.status`).toBe(exp.status);
    for (const [id, st] of Object.entries(exp.lines ?? {})) expect(receipt?.lines[id]?.status, `${ctx}\nreceipt.lines.${id}.status`).toBe(st);
    for (const [id, n] of Object.entries(exp.notes ?? {})) expect(receipt?.lines[id]?.notes, `${ctx}\nreceipt.lines.${id}.notes`).toMatchObject(n);
    for (const [id, o] of Object.entries(exp.outputs ?? {})) expect(receipt?.lines[id]?.outputs, `${ctx}\nreceipt.lines.${id}.outputs`).toMatchObject(o);
    const planLines = (json?.lines ?? []) as Array<{ id: string; status: string; error?: string }>;
    for (const [id, st] of Object.entries(exp.plan_lines ?? {})) expect(planLines.find((l) => l.id === id)?.status, `${ctx}\nplan line ${id}`).toBe(st);
    for (const [id, re] of Object.entries(exp.errors ?? {})) {
      const msg = receipt?.lines[id]?.error ?? planLines.find((l) => l.id === id)?.error ?? "";
      expect(msg, `${ctx}\nerror of ${id}`).toMatch(new RegExp(re));
    }
    if (exp.drift) {
      const drift = (json?.drift ?? []) as Array<{ kind: string; line?: string; resource: { key: string } }>;
      for (const d of exp.drift) {
        const found = drift.find((x) => x.kind === d.kind && (!d.line || x.line === d.line) && (!d.key || x.resource.key === d.key));
        expect(found, `${ctx}\nexpected drift ${JSON.stringify(d)} in ${JSON.stringify(drift)}`).toBeTruthy();
      }
    }
    for (const w of exp.warnings ?? []) {
      const warnings = ((json?.warnings ?? []) as string[]).join("\n") + "\n" + stderr;
      expect(warnings, `${ctx}\nwarnings`).toMatch(new RegExp(w));
    }
  }

  private async checkReceipts(ctx: string) {
    const dir = join(this.cwd, ".sponson/receipts");
    const files = await listFiles(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith(".json") || f.endsWith("lock.json")) continue;
      const text = await readFile(f, "utf8");
      for (const s of this.scenario.secrets ?? []) expect(text, `${ctx}\nsecret in receipt ${f}`).not.toContain(s);
      if (f.endsWith("latest.json") && !this.tampered.has(text)) expect(() => parseReceipt(text, f), `${ctx}\nreceipt unparseable ${f}`).not.toThrow();
    }
  }

  private async assertSim(s: SimExpect, where: string) {
    const st = this.sim.state;
    for (const [target, keys] of Object.entries(s.vercel_env ?? {})) {
      const envs = Object.values(st.vercel.projects).flatMap((p) => p.envs).filter((e) => e.target.includes(target));
      for (const [key, want] of Object.entries(keys)) {
        const found = envs.find((e) => e.key === key);
        if (want === "exists") expect(found, `${where}: vercel env ${target}/${key} should exist`).toBeTruthy();
        else if (want === "absent") expect(found, `${where}: vercel env ${target}/${key} should be absent`).toBeFalsy();
        else expect(found?.value, `${where}: vercel env ${target}/${key}`).toBe(want);
      }
    }
    for (const [name, want] of Object.entries(s.neon_branches ?? {})) {
      const found = Object.values(st.neon.projects).flatMap((p) => p.branches).find((b) => b.name === name);
      expect(Boolean(found), `${where}: neon branch ${name} ${want}`).toBe(want === "exists");
    }
    for (const [url, want] of Object.entries(s.clerk_redirects ?? {})) {
      const found = st.clerk.redirect_urls.find((r) => r.url === url);
      expect(Boolean(found), `${where}: clerk redirect ${url} ${want}`).toBe(want === "exists");
    }
    if (s.write_order) {
      const log = st.writes.map((w) => `${w.method} ${w.path}`);
      let from = 0;
      for (const needle of s.write_order) {
        const i = log.findIndex((l, idx) => idx >= from && l.includes(needle));
        expect(i, `${where}: write ${needle} should appear after index ${from} in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
        from = i + 1;
      }
    }
    if (s.deployments !== undefined) {
      const n = Object.values(st.vercel.projects).reduce((a, p) => a + p.deployments.length, 0);
      expect(n, `${where}: deployments`).toBe(s.deployments);
    }
  }

  /** Run apply through the engine with the real adapters and throw after `lineId`, like a SIGKILL. */
  private async crashAfter(lineId: string) {
    const { plan } = await loadPlan(join(this.cwd, "release.plan.yaml"));
    const ctx = await detectCtx({ env: this.ctx.env, pr: this.ctx.pr, branch: this.ctx.branch, sha: this.ctx.sha }, this.env, this.cwd);
    const store = new LocalReceiptStore(join(this.cwd, ".sponson/receipts"));
    await expect(
      applyRun({
        plan,
        ctx,
        registry: createRegistry(),
        store,
        env: this.env,
        redactor: new Redactor(),
        onLineDone: (id) => {
          if (id === lineId) throw new Error("SIGKILL");
        },
      }),
    ).rejects.toThrow("SIGKILL");
    // A real crash would not release the lock; emulate that so the next step must cope with it.
    const dir = join(this.cwd, ".sponson/receipts", this.ctx.env, scopeOf(this.ctx));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lock.json"), JSON.stringify({ holder: "crashed-run", acquiredAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString() }));
  }

  private async plantLock(kind: "held" | "expired") {
    const dir = join(this.cwd, ".sponson/receipts", this.ctx.env, scopeOf(this.ctx));
    await mkdir(dir, { recursive: true });
    const expiresAt = kind === "held" ? new Date(Date.now() + 60_000) : new Date(0);
    await writeFile(join(dir, "lock.json"), JSON.stringify({ holder: `other-${kind}`, acquiredAt: new Date(0).toISOString(), expiresAt: expiresAt.toISOString() }));
  }

  private async tamperReceipt(kind: "corrupt" | "delete" | "version2") {
    const latest = join(this.cwd, ".sponson/receipts", this.ctx.env, scopeOf(this.ctx), "latest.json");
    if (kind === "delete") return rm(latest, { force: true });
    if (kind === "corrupt") {
      this.tampered.add("{ not json");
      return writeFile(latest, "{ not json");
    }
    const r = JSON.parse(await readFile(latest, "utf8"));
    r.version = 2;
    this.tampered.add(JSON.stringify(r));
    await writeFile(latest, JSON.stringify(r));
  }
}

function scopeOf(ctx: typeof DEFAULT_CTX): string {
  if (ctx.pr !== null) return `pr-${ctx.pr}`;
  return ctx.branch === "main" ? "main" : `branch-${ctx.branch.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

function expectContains(text: string, pattern: string, msg: string) {
  if (pattern.startsWith("/") && pattern.endsWith("/")) expect(text, msg).toMatch(new RegExp(pattern.slice(1, -1)));
  else expect(text, msg).toContain(pattern);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}
