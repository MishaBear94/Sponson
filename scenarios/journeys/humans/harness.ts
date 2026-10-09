/**
 * Shared harness for the "humans beside the tool" journeys: a sim, a temp repo dir, the in-process CLI,
 * and "console" helpers that mutate the fake cloud the way a person clicking in a provider UI would.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { run } from "sponson";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const BRANCH = "feat/x";

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

export class Journey {
  private constructor(
    readonly sim: SimHandle,
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}
  ctx = { env: "preview", pr: 42 as number | null, branch: BRANCH, sha: SHA };

  static async start(seed?: Partial<SimSeed>, plan?: string): Promise<Journey> {
    const sim = await startSim({ seed });
    const cwd = await mkdtemp(join(tmpdir(), "sponson-human-"));
    if (plan !== undefined) await writeFile(join(cwd, "release.plan.yaml"), plan);
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
      VERCEL_PROJECT_ID: "prj_demo",
      NEON_PROJECT_ID: "proj_demo",
      SPONSON_RECEIPTS_DIR: join(cwd, ".sponson/receipts"),
    };
    return new Journey(sim, cwd, env);
  }

  async close() {
    await this.sim.close();
    await rm(this.cwd, { recursive: true, force: true });
  }

  get state() {
    return this.sim.state;
  }

  async exec(...args: string[]): Promise<Exec> {
    const a = [...args, "--env", this.ctx.env, "--branch", this.ctx.branch, "--sha", this.ctx.sha, "--receipts", "local", "--receipts-dir", join(this.cwd, ".sponson/receipts")];
    if (this.ctx.pr !== null) a.push("--pr", String(this.ctx.pr));
    let stdout = "";
    let stderr = "";
    const code = await run(a, { stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) }, env: this.env, cwd: this.cwd, color: false });
    let json: any = null;
    if (args.includes("--json")) {
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
    }
    return { code, stdout, stderr, json };
  }

  plan = () => this.exec("plan", "--json");
  apply = (...extra: string[]) => this.exec("apply", ...extra, "--json");
  destroy = () => this.exec("apply", "--destroy", "--json");
  init = (...extra: string[]) => this.exec("init", ...extra);

  async readPlan(): Promise<string> {
    return readFile(join(this.cwd, "release.plan.yaml"), "utf8");
  }
  async writePlan(text: string) {
    await writeFile(join(this.cwd, "release.plan.yaml"), text);
  }

  // ---- what the fake cloud looks like ----------------------------------------------------------

  envs(project = "prj_demo") {
    return this.state.vercel.projects[project]?.envs ?? [];
  }
  /** Vars in `target` visible to this PR branch (branch-specific) — what Sponson writes. */
  branchEnv(key: string, target = "preview", project = "prj_demo") {
    return this.envs(project).filter((e) => e.key === key && e.target.includes(target) && (target !== "preview" || e.gitBranch === this.ctx.branch));
  }
  branches(project = "proj_demo") {
    return this.state.neon.projects[project]?.branches ?? [];
  }
  branchNamed(name: string) {
    return this.branches().filter((b) => b.name === name);
  }
  redirects() {
    return this.state.clerk.redirect_urls;
  }

  // ---- a human in a console --------------------------------------------------------------------

  consoleSetEnv(key: string, value: string, target = "preview", gitBranch: string | undefined = this.ctx.branch, project = "prj_demo") {
    const p = this.state.vercel.projects[project]!;
    const now = Date.now();
    p.envs.push({ id: this.state.nextId("env_h"), key, value, target: [target], type: "encrypted", ...(gitBranch && target === "preview" ? { gitBranch } : {}), createdAt: now, updatedAt: now, createdBy: "sim" });
  }
  consoleDeleteEnv(key: string, target = "preview", project = "prj_demo") {
    const p = this.state.vercel.projects[project]!;
    p.envs = p.envs.filter((e) => !(e.key === key && e.target.includes(target)));
  }
  consoleCreateBranch(name: string, parent = "main", project = "proj_demo") {
    const p = this.state.neon.projects[project]!;
    const par = p.branches.find((b) => b.name === parent);
    return this.state.createBranch(p, name, par?.id ?? null, "sim");
  }
  consoleDeleteBranch(name: string, project = "proj_demo") {
    const p = this.state.neon.projects[project]!;
    p.branches = p.branches.filter((b) => b.name !== name);
  }
}

export const driftKinds = (r: Exec) => ((r.json?.drift ?? []) as Array<{ kind: string; line?: string; resource: { key: string } }>).map((d) => `${d.kind}:${d.line ?? "-"}:${d.resource.key}`);
export const lineStatus = (r: Exec, id: string) => (r.json?.lines ?? []).find((l: { id: string }) => l.id === id)?.status;
export const receiptLine = (r: Exec, id: string) => r.json?.receipt?.lines?.[id];
