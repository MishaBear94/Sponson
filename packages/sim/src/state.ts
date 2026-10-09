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
  /** Set by `delay:N` mode: BUILDING until this time. */
  readyAt?: number;
  meta: { githubCommitSha: string };
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
  created_at: string;
  endpoint: { id: string; host: string };
  createdAt: number;
  createdBy: CreatedBy;
}

export interface NeonProject {
  branches: NeonBranch[];
}

export interface ClerkRedirect {
  id: string;
  url: string;
  createdAt: number;
  createdBy: CreatedBy;
}

export interface ChaosConfig {
  latency_ms: number;
  /** Remaining writes (matching `fail_on`) that will fail with `status`. */
  fail_next: number;
  status: number;
  /** `"METHOD /path-glob"` or a list of them; absent means every write. */
  fail_on?: string | string[];
  deploy: string;
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
  failed?: true;
}

export interface SimSeed {
  vercel?: { projects: Record<string, { envs: Array<{ key: string; value: string; target: string; gitBranch?: string }> }> };
  neon?: { projects: Record<string, { branches: Array<{ name: string; parent?: string }> }> };
  clerk?: { redirect_urls: string[] };
}

export const DEFAULT_SEED: SimSeed = {
  vercel: { projects: { prj_demo: { envs: [] } } },
  neon: { projects: { proj_demo: { branches: [{ name: "main" }] } } },
  clerk: { redirect_urls: [] },
};

const DEFAULT_CHAOS: ChaosConfig = { latency_ms: 0, fail_next: 0, status: 503, deploy: "ok" };
const CHAOS_KEYS = new Set<string>(["latency_ms", "fail_next", "status", "fail_on", "deploy"]);

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
    this.chaos = { ...DEFAULT_CHAOS };
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
      const project: NeonProject = { branches: [] };
      this.neon.projects[id] = project;
      for (const b of p.branches) {
        const parent = b.parent ? project.branches.find((x) => x.name === b.parent) : undefined;
        this.createBranch(project, b.name, parent?.id ?? null, "sim");
      }
    }
    for (const url of s.clerk?.redirect_urls ?? []) {
      this.clerk.redirect_urls.push({ id: this.nextId("ru_"), url, createdAt: now, createdBy: "sim" });
    }
  }

  createBranch(project: NeonProject, name: string, parentId: string | null, createdBy: CreatedBy): NeonBranch {
    const id = this.nextId("br-");
    const branch: NeonBranch = {
      id,
      name,
      parent_id: parentId,
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

  createDeployment(projectId: string, project: VercelProject, sha: string, state: DeploymentState, createdAt: number, suffix = ""): VercelDeployment {
    const d: VercelDeployment = {
      uid: this.nextId("dpl_"),
      url: `${projectId}-${sha.slice(0, 8)}${suffix}.vercel.app`,
      state,
      createdAt,
      meta: { githubCommitSha: sha },
      createdBy: "api",
    };
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
   * Drift keys: `vercel.env.<target>.<NAME>` (value or "delete"), `neon.branch.<name>` ("delete"),
   * `clerk.redirect.<url>` ("delete"). Applied across every project, since the key does not name one.
   */
  applyDrift(key: string, value: string): void {
    if (key.startsWith("vercel.env.")) {
      const rest = key.slice("vercel.env.".length);
      const dot = rest.indexOf(".");
      if (dot < 0) throw new Error(`bad drift key: ${key}`);
      const target = rest.slice(0, dot);
      const name = rest.slice(dot + 1);
      for (const p of Object.values(this.vercel.projects)) {
        const hit = p.envs.filter((e) => e.key === name && e.target.includes(target));
        if (value === "delete") p.envs = p.envs.filter((e) => !hit.includes(e));
        else for (const e of hit) Object.assign(e, { value, updatedAt: Date.now() });
      }
      return;
    }
    if (key.startsWith("neon.branch.")) {
      const name = key.slice("neon.branch.".length);
      if (value !== "delete") throw new Error(`drift ${key}: only "delete" is supported`);
      for (const p of Object.values(this.neon.projects)) p.branches = p.branches.filter((b) => b.name !== name);
      return;
    }
    if (key.startsWith("clerk.redirect.")) {
      const url = key.slice("clerk.redirect.".length);
      if (value !== "delete") throw new Error(`drift ${key}: only "delete" is supported`);
      this.clerk.redirect_urls = this.clerk.redirect_urls.filter((r) => r.url !== url);
      return;
    }
    throw new Error(`unknown drift key: ${key}`);
  }

  /** Decide whether this write should fail under chaos, consuming one `fail_next` when it does. */
  shouldFail(method: string, path: string): boolean {
    if (this.chaos.fail_next <= 0) return false;
    const rules = this.chaos.fail_on === undefined ? [] : Array.isArray(this.chaos.fail_on) ? this.chaos.fail_on : [this.chaos.fail_on];
    if (rules.length > 0 && !rules.some((r) => matchesRule(r, method, path))) return false;
    this.chaos.fail_next -= 1;
    return true;
  }

  snapshot(): unknown {
    return { vercel: this.vercel, neon: this.neon, clerk: this.clerk, chaos: this.chaos };
  }
}

/** `"DELETE /neon/*"`: method must match exactly, `*` in the path matches anything. */
export function matchesRule(rule: string, method: string, path: string): boolean {
  const space = rule.indexOf(" ");
  const ruleMethod = space < 0 ? rule : rule.slice(0, space);
  const ruleGlob = space < 0 ? "*" : rule.slice(space + 1).trim();
  if (ruleMethod !== "*" && ruleMethod.toUpperCase() !== method.toUpperCase()) return false;
  const re = new RegExp("^" + ruleGlob.split("*").map(escapeRe).join(".*") + "$");
  return re.test(path);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
