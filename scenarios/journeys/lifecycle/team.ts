/**
 * Test kit for the release-lifecycle journeys: one fake cloud, one checkout directory, a local receipt store,
 * the in-process CLI, and an emulation of the documented GitHub workflow (action/README.md) that evaluates the
 * action's own scope-resolution script from action/action.yml against a fake GitHub.
 *
 * Deploys are explicit: chaos `deploy: never` keeps the sim from inventing a deployment the first time a sha is
 * looked up, so a deployment exists only after `team.deploy(sha)` — i.e. when "Vercel" has finished building it.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { run } from "sponson";
import { sha256, type Receipt } from "@sponson/core";

export const repoRoot = new URL("../../../", import.meta.url).pathname;

/** Deterministic 40-hex sha for a label like "pr42-a". */
export function sha(label: string): string {
  return createHash("sha1").update(label).digest("hex");
}

export interface Ctx {
  env?: string;
  pr?: number | null;
  branch: string;
  sha: string;
}

export interface CliResult {
  exit: number;
  json: any;
  stdout: string;
  stderr: string;
  writes: Array<{ method: string; path: string }>;
}

export const TOKENS = { VERCEL_TOKEN: "tok_vercel", NEON_API_KEY: "tok_neon", CLERK_SECRET_KEY: "tok_clerk" };

export class Team {
  private constructor(
    readonly sim: SimHandle,
    readonly cwd: string,
    readonly receiptsDir: string,
    readonly baseEnv: NodeJS.ProcessEnv,
  ) {}

  static async create(opts: { seed?: Partial<SimSeed>; plan?: string; env?: Record<string, string> } = {}): Promise<Team> {
    const sim = await startSim({ seed: opts.seed });
    sim.state.applyChaos({ deploy: "never" });
    const cwd = await mkdtemp(join(tmpdir(), "sponson-life-"));
    const receiptsDir = join(cwd, ".sponson/receipts");
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NO_COLOR: "1",
      VERCEL_API_URL: `${sim.url}/vercel`,
      NEON_API_URL: `${sim.url}/neon`,
      CLERK_API_URL: `${sim.url}/clerk`,
      SPONSON_RECEIPTS_DIR: receiptsDir,
      ...(opts.env ?? {}),
    };
    const t = new Team(sim, cwd, receiptsDir, baseEnv);
    if (opts.plan) await t.writePlan(opts.plan);
    return t;
  }

  async close() {
    await this.sim.close();
    await rm(this.cwd, { recursive: true, force: true });
  }

  async writePlan(text: string) {
    await writeFile(join(this.cwd, "release.plan.yaml"), text);
  }

  async readPlan(): Promise<string> {
    return readFile(join(this.cwd, "release.plan.yaml"), "utf8");
  }

  /** Vercel finished building `sha`: a READY deployment now exists. */
  deploy(s: string, opts: { at?: number; suffix?: string } = {}) {
    const p = this.sim.state.vercel.projects.prj_demo!;
    return this.sim.state.createDeployment("prj_demo", p, s, "READY", opts.at ?? Date.now(), opts.suffix ?? "");
  }

  static previewUrl(s: string, suffix = ""): string {
    return `https://prj_demo-${s.slice(0, 8)}${suffix}.vercel.app`;
  }

  /** Run the CLI with explicit context flags (the way the action invokes it), tokens included unless overridden. */
  async cli(args: string[], ctx: Ctx, extraEnv: Record<string, string | undefined> = {}): Promise<CliResult> {
    const flags = ["--env", ctx.env ?? "preview", "--branch", ctx.branch, "--sha", ctx.sha];
    if (ctx.pr !== null && ctx.pr !== undefined) flags.push("--pr", String(ctx.pr));
    // No PR: say so explicitly, so context detection does not shell out to `gh`.
    const prEnv = ctx.pr === null || ctx.pr === undefined ? { SPONSON_CTX_PR: "" } : {};
    return this.raw([...args, "--json", ...flags], { ...TOKENS, ...prEnv, ...extraEnv });
  }

  /** Run the CLI with exactly these argv (plus local receipts) and env on top of the base env. */
  async raw(argv: string[], extraEnv: Record<string, string | undefined> = {}, cwd = this.cwd): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    let stdout = "";
    let stderr = "";
    const before = this.sim.state.writes.length;
    const exit = await run([...argv, "--receipts", "local", "--receipts-dir", this.receiptsDir], {
      stdout: { write: (s) => (stdout += s) },
      stderr: { write: (s) => (stderr += s) },
      env,
      cwd,
      color: false,
    });
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      /* not json */
    }
    const writes = this.sim.state.writes.slice(before).filter((w) => !w.failed).map((w) => ({ method: w.method, path: w.path }));
    return { exit, json, stdout, stderr, writes };
  }

  /** Latest receipt for env/scope, or null. */
  async receipt(env: string, scope: string): Promise<Receipt | null> {
    try {
      return JSON.parse(await readFile(join(this.receiptsDir, env, scope, "latest.json"), "utf8")) as Receipt;
    } catch {
      return null;
    }
  }

  async allLatestReceipts(): Promise<Receipt[]> {
    const out: Receipt[] = [];
    for (const env of await readdir(this.receiptsDir).catch(() => [] as string[])) {
      for (const scope of await readdir(join(this.receiptsDir, env)).catch(() => [] as string[])) {
        const r = await this.receipt(env, scope);
        if (r) out.push(r);
      }
    }
    return out;
  }

  /** Everything the API (i.e. Sponson) created that still exists, in a comparable shape. */
  apiResources() {
    const st = this.sim.state;
    const vercel = Object.values(st.vercel.projects)
      .flatMap((p) => p.envs)
      .filter((e) => e.createdBy === "api")
      .map((e) => ({ id: e.id, key: e.key, target: e.target.join(","), gitBranch: e.gitBranch ?? null, value: e.value }));
    const neon = Object.values(st.neon.projects)
      .flatMap((p) => p.branches)
      .filter((b) => b.createdBy === "api")
      .map((b) => ({ id: b.id, name: b.name }));
    const clerk = st.clerk.redirect_urls.filter((r) => r.createdBy === "api").map((r) => ({ id: r.id, url: r.url }));
    return { vercel, neon, clerk };
  }

  vercelEnv(target: string, key: string, gitBranch?: string | null) {
    return Object.values(this.sim.state.vercel.projects)
      .flatMap((p) => p.envs)
      .filter((e) => e.target.includes(target) && e.key === key && (gitBranch === undefined || (e.gitBranch ?? null) === gitBranch));
  }

  /**
   * Cross-check every non-destroy receipt against the cloud: each resource a receipt says is live must exist with
   * the recorded hash, and every API-created resource must be claimed by some live receipt.
   * Returns human-readable discrepancies (empty when receipts and reality agree).
   */
  async receiptsVsReality(opts: { ignoreScopes?: string[] } = {}): Promise<string[]> {
    const problems: string[] = [];
    const live = new Map<string, string>(); // provider id -> hash
    const st = this.sim.state;
    for (const p of Object.values(st.vercel.projects)) for (const e of p.envs) live.set(e.id, sha256(e.value));
    for (const p of Object.values(st.neon.projects)) for (const b of p.branches) live.set(b.id, "");
    for (const r of st.clerk.redirect_urls) live.set(r.id, sha256(r.url));
    const claimed = new Set<string>();
    // v0.2 (决策-v0.2 G1, types.ts Receipt.ledger): what Sponson manages lives in `receipt.ledger`, keyed by
    // identity and carried across runs; `lines` only describe what one run did. Ledger hashes are keyed (HMAC
    // with `receipt.hashKey`) over the adapter's raw sha256.
    const keyed = (rc: Receipt, raw: string) => (rc.hashKey ? createHmac("sha256", rc.hashKey).update(raw).digest("hex") : raw);
    for (const rc of await this.allLatestReceipts()) {
      if (rc.destroy) continue;
      for (const e of rc.ledger ?? []) {
        claimed.add(e.id);
        if (e.createdBy === "intent") continue;
        if (opts.ignoreScopes?.includes(rc.scope)) continue;
        // Same rule as before: only lines this run left in a settled state are compared with the cloud
        // (a refused or failed line legitimately sees drift). Orphans have no line in this run.
        const status = rc.lines[e.line]?.status;
        if (status !== undefined && !["applied", "unchanged", "waiting"].includes(status)) continue;
        if (!live.has(e.id)) problems.push(`${rc.environment}/${rc.scope} ledger (line ${e.line}) claims ${e.label ?? e.key} (${e.id}) but it does not exist`);
        else if (e.key.startsWith("env:") || e.key.startsWith("redirect:")) {
          if (keyed(rc, live.get(e.id)!) !== e.hash) problems.push(`${rc.environment}/${rc.scope} ledger (line ${e.line}) hash for ${e.label ?? e.key} disagrees with the cloud`);
        }
      }
    }
    const api = this.apiResources();
    for (const e of api.vercel) if (!claimed.has(e.id)) problems.push(`unclaimed vercel env ${e.key} (${e.target}${e.gitBranch ? `, ${e.gitBranch}` : ""}) ${e.id}`);
    for (const b of api.neon) if (!claimed.has(b.id)) problems.push(`unclaimed neon branch ${b.name} ${b.id}`);
    for (const r of api.clerk) if (!claimed.has(r.id)) problems.push(`unclaimed clerk redirect ${r.url} ${r.id}`);
    return problems;
  }
}

// ---------------------------------------------------------------------------
// GitHub + the documented workflow
// ---------------------------------------------------------------------------

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head: { ref: string; sha: string };
  /** Every sha that was ever the head, plus the merge commit. */
  commits: string[];
}

/** Just enough of GitHub: which plan file each commit has, and which PRs a commit belongs to. */
export class FakeGitHub {
  plans = new Map<string, string>();
  prs = new Map<number, PullRequest>();

  commit(label: string, plan: string): string {
    const s = sha(label);
    this.plans.set(s, plan);
    return s;
  }

  open(number: number, branch: string, head: string): PullRequest {
    const pr: PullRequest = { number, state: "open", merged: false, head: { ref: branch, sha: head }, commits: [head] };
    this.prs.set(number, pr);
    return pr;
  }

  push(number: number, head: string): PullRequest {
    const pr = this.prs.get(number)!;
    pr.head = { ...pr.head, sha: head };
    pr.commits.push(head);
    return pr;
  }

  close(number: number, merge?: { mergeSha: string }): PullRequest {
    const pr = this.prs.get(number)!;
    pr.state = "closed";
    if (merge) {
      pr.merged = true;
      pr.commits.push(merge.mergeSha);
    }
    return pr;
  }

  reopen(number: number): PullRequest {
    const pr = this.prs.get(number)!;
    pr.state = "open";
    return pr;
  }

  /** GET /repos/{o}/{r}/commits/{sha}/pulls */
  associated(s: string) {
    return [...this.prs.values()].filter((p) => p.commits.includes(s)).map((p) => ({ number: p.number, state: p.state, head: { ref: p.head.ref, sha: p.head.sha } }));
  }
}

type ScopeScript = (context: unknown, github: unknown, core: unknown) => Promise<void>;
let scopeScript: ScopeScript | null = null;

/** The `scope` step of action/action.yml, compiled as the github-script action would run it. */
export async function actionScopeScript(): Promise<ScopeScript> {
  if (scopeScript) return scopeScript;
  const action = parseYaml(await readFile(join(repoRoot, "action/action.yml"), "utf8")) as { runs: { steps: Array<{ id?: string; with?: { script?: string } }> } };
  const step = action.runs.steps.find((s) => s.id === "scope");
  if (!step?.with?.script) throw new Error("action.yml has no `scope` step script");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => ScopeScript;
  scopeScript = new AsyncFunction("context", "github", "core", step.with.script);
  return scopeScript;
}

/** The example workflow in action/README.md, parsed. */
export async function documentedWorkflow(): Promise<any> {
  const md = await readFile(join(repoRoot, "action/README.md"), "utf8");
  const block = [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => /^name: sponson/m.test(b) && /deployment_status/.test(b));
  if (!block) throw new Error("action/README.md has no example workflow");
  return parseYaml(block);
}

export type Event =
  | { name: "pull_request"; action: "opened" | "synchronize" | "closed" | "reopened"; pr: PullRequest }
  | { name: "deployment_status"; sha: string; ref: string; environment: "Preview" | "Production"; state: "success" | "pending" | "failure" };

/**
 * One CI run of the preview job from action/README.md: trigger filter, `if:` filter, checkout of the right commit,
 * the action's scope script, then `sponson apply` / `sponson apply --destroy` with the flags the action builds.
 * `tokens` controls which provider tokens the step sees (a careful team puts them on every step).
 */
export class PreviewWorkflow {
  runs: Array<{ event: string; command: string; scope: { pr: string; branch: string; sha: string }; result: CliResult }> = [];

  constructor(
    readonly team: Team,
    readonly gh: FakeGitHub,
    readonly tokens: Record<string, string> = TOKENS,
  ) {}

  async fire(ev: Event): Promise<CliResult | null> {
    // on: pull_request: types [opened, synchronize, closed]; deployment_status
    if (ev.name === "pull_request" && !["opened", "synchronize", "closed"].includes(ev.action)) return null;
    // if: github.event_name == 'pull_request' || github.event.deployment_status.state == 'success'
    if (ev.name === "deployment_status" && ev.state !== "success") return null;

    const payload =
      ev.name === "pull_request"
        ? { action: ev.action, number: ev.pr.number, pull_request: { number: ev.pr.number, head: { ...ev.pr.head }, state: ev.pr.state, merged: ev.pr.merged } }
        : { action: "created", deployment: { sha: ev.sha, ref: ev.ref, environment: ev.environment }, deployment_status: { state: ev.state } };

    // actions/checkout: ref = deployment.sha || github.sha (we use the PR head for pull_request events)
    const checkout = ev.name === "pull_request" ? ev.pr.head.sha : ev.sha;
    const plan = this.gh.plans.get(checkout);
    if (!plan) throw new Error(`no plan committed at ${checkout}`);
    await this.team.writePlan(plan);

    const outputs: Record<string, string> = {};
    const script = await actionScopeScript();
    await script(
      { payload, repo: { owner: "acme", repo: "app" } },
      { rest: { repos: { listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => ({ data: this.gh.associated(commit_sha) }) } } },
      { setOutput: (k: string, v: unknown) => (outputs[k] = String(v)) },
    );

    const command = ev.name === "pull_request" && ev.action === "closed" ? "destroy" : "apply";
    const argv = command === "destroy" ? ["apply", "--destroy"] : ["apply"];
    const args = ["--json", "--env", "preview"];
    if (outputs.pr) args.push("--pr", outputs.pr);
    if (outputs.branch) args.push("--branch", outputs.branch);
    if (outputs.sha) args.push("--sha", outputs.sha);
    const result = await this.team.raw([...argv, ...args], { ...this.tokens, GITHUB_ACTIONS: "true" });
    this.runs.push({ event: `${ev.name}${"action" in ev ? `:${ev.action}` : `:${ev.environment}`}`, command, scope: { pr: outputs.pr ?? "", branch: outputs.branch ?? "", sha: outputs.sha ?? "" }, result });
    return result;
  }

  /** The production job from action/README.md (environment approval), run on a main commit. */
  async production(mainSha: string, approvedBy: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
    const plan = this.gh.plans.get(mainSha);
    if (!plan) throw new Error(`no plan committed at ${mainSha}`);
    await this.team.writePlan(plan);
    return this.team.raw(["apply", "--json", "--env", "production", "--branch", "main", "--sha", mainSha], { ...this.tokens, ...extraEnv, SPONSON_APPROVED_BY: approvedBy, GITHUB_ACTIONS: "true" });
  }
}

/**
 * The team's plan: a preview stack (Neon branch, Vercel preview vars, Clerk callback on the preview URL) and a
 * production stack (Vercel production vars from a secret, a fixed production callback) in one file.
 */
export function teamPlan(o: {
  previewValues?: Record<string, string>;
  prodValues?: Record<string, string>;
  envId?: string;
  callback?: boolean;
  callbackEnvs?: string;
  extra?: string;
} = {}): string {
  const envId = o.envId ?? "env";
  const pv = Object.entries(o.previewValues ?? { FEATURE_SEARCH: "off" }).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}\n`).join("");
  const prodv = Object.entries(o.prodValues ?? { FEATURE_SEARCH: "off" }).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}\n`).join("");
  const callback =
    o.callback === false
      ? ""
      : `  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: ${envId}.preview_url }
    environments: ${o.callbackEnvs ?? "[preview]"}
`;
  return `version: 1
environments: [preview, production]
receipts: local
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]
  - id: ${envId}
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
${pv}    environments: [preview]
${callback}  - id: env-prod
    adapter: vercel
    op: env
    target: production
    values:
      DATABASE_URL: { secret: "env://PROD_DATABASE_URL" }
${prodv}    environments: [production]
  - id: callback-prod
    adapter: clerk
    op: redirect_allow
    url: "https://app.example.com/sso-callback"
    environments: [production]
${o.extra ?? ""}`;
}

export const PROD_DSN = "postgres://prod_owner:prod-pw-9f3a@prod.db.example.com/app";
export const PROD_ENV = { PROD_DATABASE_URL: PROD_DSN };

export async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}
