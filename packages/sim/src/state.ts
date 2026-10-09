/**
 * In-memory state for the fake cloud: the Vercel, Neon and Clerk subsets Sponson's
 * adapters touch, plus the chaos configuration and the write log the invariants read.
 */

export type CreatedBy = "sim" | "api";

export interface VercelEnv {
  id: string;
  key: string;
  value: string;
  target: string[];
  type: "encrypted" | "plain";
  gitBranch?: string;
  createdAt: number;
  updatedAt: number;
  createdBy: CreatedBy;
}

export type DeploymentState = "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED";

export interface VercelDeployment {
  uid: string;
  url: string;
  state: DeploymentState;
  createdAt: number;
  /** While in progress: QUEUED until `buildingAt`, BUILDING until `readyAt`, then `finalState`. */
  buildingAt?: number;
  readyAt?: number;
  finalState?: DeploymentState;
  meta: { githubCommitSha: string; githubCommitRef?: string };
  createdBy: CreatedBy;
}

export interface VercelProject {
  envs: VercelEnv[];
  deployments: VercelDeployment[];
}

export interface NeonBranch {
  id: string;
  name: string;
  parent_id: string | null;
  /** The project's root branch (Neon's `default`, formerly `primary`). */
  default: boolean;
  /** Async operations started by the create are running until this time: writes to the branch answer 423. */
  opUntil: number;
  created_at: string;
  endpoint: { id: string; host: string };
  createdAt: number;
  createdBy: CreatedBy;
}

export interface NeonProject {
  branches: NeonBranch[];
  /** A branch create's operations are running until this time: further creates answer 423. */
  opUntil: number;
}

export interface ClerkRedirect {
  id: string;
  url: string;
  createdAt: number;
  createdBy: CreatedBy;
}

export interface ChaosConfig {
  latency_ms: number;
  /** Remaining requests (matching `fail_on`) that will fail with `status`. */
  fail_next: number;
  status: number;
  /** Sent as `Retry-After` (seconds) with chaos 429s. */
  retry_after?: number;
  /** Remaining requests (matching `fail_on`) that are performed, then answered by destroying the socket. */
  drop_response_next: number;
  /** Remaining requests (matching `fail_on`) that are accepted and never answered. */
  hang_next: number;
  /**
   * Which requests the counters above apply to: `"METHOD /path-glob"` or a list of them.
   * Absent means every write. Reads are only affected by a rule whose method is GET.
   */
  fail_on?: string | string[];
  /** Deployment mode: ok | never | fail | stale | double | cancel | delay:<seconds>. */
  deploy: string;
  /** QUEUED → BUILDING → READY takes this long for deployments created through the API (and `ok` auto-deploys). */
  deploy_ms: number;
  /** After a Neon branch create, writes to that branch and further creates in the project answer 423 for this long. */
  neon_op_ms: number;
  /** When > 0, Neon branches, Vercel envs and Clerk redirect URLs are listed in pages of this size. */
  page_size: number;
  /** Keys a Vercel bulk upsert reports under `failed` (and does not write). */
  env_upsert_fail: string[];
}

export interface ChaosRequest extends Partial<ChaosConfig> {
  /** Applied immediately to state, not stored. */
  drift?: Record<string, string>;
}

export interface WriteLogEntry {
  at: string;
  method: string;
  path: string;
  bodyHash: string;
  /** The write changed nothing: failed by chaos, or refused by the provider (4xx/5xx). */
  failed?: true;
}

export interface SimSeed {
  /** Chaos applied right after the seed, e.g. `{ page_size: 2 }`. */
  chaos?: Partial<ChaosConfig>;
  vercel?: { projects: Record<string, { envs: Array<{ key: string; value: string; target: string; gitBranch?: string }> }> };
  neon?: { projects: Record<string, { branches: Array<{ name: string; parent?: string }> }> };
  clerk?: { redirect_urls: string[] };
}

export const DEFAULT_SEED: SimSeed = {
  vercel: { projects: { prj_demo: { envs: [] } } },
  neon: { projects: { proj_demo: { branches: [{ name: "main" }] } } },
  clerk: { redirect_urls: [] },
};

const DEFAULT_CHAOS: ChaosConfig = {
  latency_ms: 0,
  fail_next: 0,
  status: 503,
  drop_response_next: 0,
  hang_next: 0,
  deploy: "ok",
  deploy_ms: 0,
  neon_op_ms: 0,
  page_size: 0,
  env_upsert_fail: [],
};
const CHAOS_KEYS = new Set<string>([...Object.keys(DEFAULT_CHAOS), "fail_on", "retry_after"]);

/** What chaos does to one request. */
export type ChaosAction = { kind: "hang" } | { kind: "drop" } | { kind: "fail"; status: number; headers: Record<string, string> };

export class SimState {
  vercel: { projects: Record<string, VercelProject> } = { projects: {} };
  neon: { projects: Record<string, NeonProject> } = { projects: {} };
  clerk: { redirect_urls: ClerkRedirect[] } = { redirect_urls: [] };
  chaos: ChaosConfig = { ...DEFAULT_CHAOS };
  writes: WriteLogEntry[] = [];
  private seq = 0;

  constructor(seed?: Partial<SimSeed>) {
    this.reset(seed);
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  /**
   * Clear everything (state, chaos, writes) and apply a seed. A partial seed replaces only the providers it names;
   * the others keep their defaults, so `{ clerk: {...} }` still has the demo Vercel and Neon projects.
   */
  reset(seed?: Partial<SimSeed>): void {
    this.vercel = { projects: {} };
    this.neon = { projects: {} };
    this.clerk = { redirect_urls: [] };
    this.chaos = { ...DEFAULT_CHAOS, env_upsert_fail: [] };
    this.writes = [];
    this.seq = 0;
    const s: SimSeed = { ...DEFAULT_SEED, ...seed };
    const now = Date.now();
    for (const [id, p] of Object.entries(s.vercel?.projects ?? {})) {
      const project: VercelProject = { envs: [], deployments: [] };
      for (const e of p.envs) {
        project.envs.push({
          id: this.nextId("env_"),
          key: e.key,
          value: e.value,
          target: [e.target],
          type: "encrypted",
          ...(e.gitBranch ? { gitBranch: e.gitBranch } : {}),
          createdAt: now,
          updatedAt: now,
          createdBy: "sim",
        });
      }
      this.vercel.projects[id] = project;
    }
    for (const [id, p] of Object.entries(s.neon?.projects ?? {})) {
      const project: NeonProject = { branches: [], opUntil: 0 };
      this.neon.projects[id] = project;
      for (const b of p.branches) {
        const parent = b.parent ? project.branches.find((x) => x.name === b.parent) : undefined;
        const branch = this.createBranch(project, b.name, parent?.id ?? null, "sim");
        // The first root branch is the project's default, like the one Neon creates with the project.
        if (!branch.parent_id && !project.branches.some((x) => x.default)) branch.default = true;
      }
    }
    for (const url of s.clerk?.redirect_urls ?? []) {
      this.clerk.redirect_urls.push({ id: this.nextId("ru_"), url, createdAt: now, createdBy: "sim" });
    }
    if (s.chaos) this.applyChaos(s.chaos);
  }

  createBranch(project: NeonProject, name: string, parentId: string | null, createdBy: CreatedBy): NeonBranch {
    const id = this.nextId("br-");
    const branch: NeonBranch = {
      id,
      name,
      parent_id: parentId,
      default: false,
      opUntil: 0,
      created_at: new Date().toISOString(),
      endpoint: { id: this.nextId("ep-"), host: `${id}.sim.neon.tech` },
      createdAt: Date.now(),
      createdBy,
    };
    project.branches.push(branch);
    return branch;
  }

  connectionUri(branch: NeonBranch): string {
    return `postgres://neondb_owner:pw_${branch.id}@${branch.endpoint.host}/neondb`;
  }

  /**
   * Every deployment gets its own URL: the first one of a sha is `<project>-<sha8>.vercel.app`, later ones
   * (redeploys) `-2`, `-3`, … `buildMs` > 0 starts it QUEUED and makes it reach `state` over that time.
   */
  createDeployment(projectId: string, project: VercelProject, sha: string, state: DeploymentState, createdAt: number, opts: { ref?: string; buildMs?: number } = {}): VercelDeployment {
    const n = project.deployments.filter((d) => d.meta.githubCommitSha === sha).length + 1;
    const buildMs = opts.buildMs ?? 0;
    const d: VercelDeployment = {
      uid: this.nextId("dpl_"),
      url: `${projectId}-${sha.slice(0, 8)}${n > 1 ? `-${n}` : ""}.vercel.app`,
      state: buildMs > 0 ? "QUEUED" : state,
      createdAt,
      ...(buildMs > 0 ? { buildingAt: createdAt + buildMs / 3, readyAt: createdAt + buildMs, finalState: state } : {}),
      meta: { githubCommitSha: sha, ...(opts.ref ? { githubCommitRef: opts.ref } : {}) },
      createdBy: "api",
    };
    if (this.chaos.deploy === "cancel" && opts.ref) {
      // Vercel's auto-cancel: a new build on a branch cancels the builds of that branch still in progress.
      refreshDeployments(project.deployments, createdAt);
      for (const old of project.deployments) {
        if (old.meta.githubCommitRef === opts.ref && (old.state === "QUEUED" || old.state === "BUILDING")) {
          old.state = "CANCELED";
          delete old.finalState;
        }
      }
    }
    project.deployments.push(d);
    return d;
  }

  /** Merge a chaos request; drift is applied to state right away and not kept. */
  applyChaos(req: ChaosRequest): ChaosConfig {
    const { drift, ...rest } = req;
    for (const [k, v] of Object.entries(rest)) {
      // A misspelt key would silently leave the test running without its chaos.
      if (!CHAOS_KEYS.has(k)) throw new Error(`unknown chaos key: ${k} (known: ${[...CHAOS_KEYS].join(", ")}, drift)`);
      if (v !== undefined) (this.chaos as unknown as Record<string, unknown>)[k] = v;
    }
    if (drift) for (const [key, value] of Object.entries(drift)) this.applyDrift(key, value);
    return this.chaos;
  }

  /**
   * Drift keys (value: a new value, "delete", or "recreate" = delete and re-create with the same name and a new id):
   *   `vercel.env.<target>.<NAME>`           every record of NAME in target
   *   `vercel.env.<target>@<branch>.<NAME>`  only the record for that git branch (`@*`: the project-wide one)
   *   `neon.branch.<name>`                   "delete" | "recreate"
   *   `clerk.redirect.<url>`                 "delete" | "recreate"
   * A `vercel:<project>.` / `neon:<project>.` prefix (instead of `vercel.` / `neon.`) limits it to one project.
   */
  applyDrift(key: string, value: string): void {
    const scoped = key.match(/^(vercel|neon):([^.]+)\.(.*)$/);
    const only = scoped ? scoped[2]! : undefined;
    const k = scoped ? `${scoped[1]}.${scoped[3]}` : key;
    const pick = <T>(projects: Record<string, T>): T[] => Object.entries(projects).filter(([id]) => only === undefined || id === only).map(([, p]) => p);

    if (k.startsWith("vercel.env.")) {
      const rest = k.slice("vercel.env.".length);
      // Env names have no dots; git branches may.
      const dot = rest.lastIndexOf(".");
      if (dot < 0) throw new Error(`bad drift key: ${key}`);
      const [target, branch] = splitOnce(rest.slice(0, dot), "@");
      const name = rest.slice(dot + 1);
      for (const p of pick(this.vercel.projects)) {
        const hit = p.envs.filter((e) => e.key === name && e.target.includes(target) && (branch === undefined || (e.gitBranch ?? "*") === branch));
        if (value === "delete") p.envs = p.envs.filter((e) => !hit.includes(e));
        else if (value === "recreate") {
          p.envs = p.envs.filter((e) => !hit.includes(e));
          for (const e of hit) p.envs.push({ ...e, id: this.nextId("env_"), createdAt: Date.now(), updatedAt: Date.now(), createdBy: "sim" });
        } else for (const e of hit) Object.assign(e, { value, updatedAt: Date.now() });
      }
      return;
    }
    if (k.startsWith("neon.branch.")) {
      const name = k.slice("neon.branch.".length);
      if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported`);
      for (const p of pick(this.neon.projects)) {
        const hit = p.branches.filter((b) => b.name === name);
        p.branches = p.branches.filter((b) => !hit.includes(b));
        if (value === "recreate") for (const b of hit) this.createBranch(p, b.name, b.parent_id, "sim");
      }
      return;
    }
    if (k.startsWith("clerk.redirect.")) {
      const url = k.slice("clerk.redirect.".length);
      if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported`);
      const hit = this.clerk.redirect_urls.filter((r) => r.url === url);
      this.clerk.redirect_urls = this.clerk.redirect_urls.filter((r) => !hit.includes(r));
      if (value === "recreate") for (const r of hit) this.clerk.redirect_urls.push({ id: this.nextId("ru_"), url: r.url, createdAt: Date.now(), createdBy: "sim" });
      return;
    }
    throw new Error(`unknown drift key: ${key}`);
  }

  /**
   * Decide what chaos does to this request, consuming one count when it does something.
   * Writes are eligible when `fail_on` is absent or matches; reads only when a GET rule matches.
   */
  chaosFor(method: string, path: string): ChaosAction | null {
    const c = this.chaos;
    if (c.hang_next <= 0 && c.drop_response_next <= 0 && c.fail_next <= 0) return null;
    const rules = c.fail_on === undefined ? [] : Array.isArray(c.fail_on) ? c.fail_on : [c.fail_on];
    const isRead = method === "GET" || method === "HEAD";
    const eligible = isRead
      ? rules.some((r) => ruleMethod(r) === "GET" && matchesRule(r, "GET", path))
      : rules.length === 0 || rules.some((r) => matchesRule(r, method, path));
    if (!eligible) return null;
    if (c.hang_next > 0) {
      c.hang_next -= 1;
      return { kind: "hang" };
    }
    if (c.drop_response_next > 0) {
      c.drop_response_next -= 1;
      return { kind: "drop" };
    }
    if (c.fail_next > 0) {
      c.fail_next -= 1;
      const headers: Record<string, string> = c.status === 429 && c.retry_after !== undefined ? { "retry-after": String(c.retry_after) } : {};
      return { kind: "fail", status: c.status, headers };
    }
    return null;
  }

  snapshot(): unknown {
    return { vercel: this.vercel, neon: this.neon, clerk: this.clerk, chaos: this.chaos };
  }
}

/** `"DELETE /neon/*"`: method must match exactly (or be `*`), `*` in the path matches anything. */
export function matchesRule(rule: string, method: string, path: string): boolean {
  const space = rule.indexOf(" ");
  const m = ruleMethod(rule);
  const ruleGlob = space < 0 ? "*" : rule.slice(space + 1).trim();
  if (m !== "*" && m !== method.toUpperCase()) return false;
  const re = new RegExp("^" + ruleGlob.split("*").map(escapeRe).join(".*") + "$");
  return re.test(path);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleMethod(rule: string): string {
  const space = rule.indexOf(" ");
  return (space < 0 ? rule : rule.slice(0, space)).toUpperCase();
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** Advance in-progress deployments to the state their timings say they are in now. */
export function refreshDeployments(list: VercelDeployment[], now = Date.now()): void {
  for (const d of list) {
    if (d.state !== "QUEUED" && d.state !== "BUILDING") continue;
    if (d.readyAt !== undefined && now >= d.readyAt) {
      d.state = d.finalState ?? "READY";
      delete d.finalState;
    } else if (d.state === "QUEUED" && (d.buildingAt === undefined || now >= d.buildingAt)) d.state = "BUILDING";
  }
}
