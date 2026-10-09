/**
 * Harness for "providers misbehave like real clouds" journeys.
 *
 * A small HTTP proxy sits between Sponson and the sim. Each rule can observe a request and decide to:
 *   - pass it through (return undefined),
 *   - answer itself ({ status, headers?, body }),
 *   - forward it and then drop the response ("lost response": the write happened, the client never hears),
 *   - hang forever ("hang"),
 *   - forward it and rewrite the upstream answer.
 * The proxy keeps a log of every request it saw and the status it returned.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type CliRun, type Workspace } from "../../support.js";

export interface ProxyRequest {
  method: string;
  /** Path without query, e.g. `/vercel/v10/projects/prj_demo/env`. */
  path: string;
  query: URLSearchParams;
  body: string;
  /** Index of this request among all requests the proxy has seen (0-based). */
  seq: number;
}

export interface Upstream {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ProxyAction =
  | undefined
  | "drop" // forward to the sim, then destroy the socket without answering
  | "hang" // never answer
  | { status: number; headers?: Record<string, string>; body: unknown }
  | { forwardWith: { path?: string; body?: string; method?: string }; rewrite?: (u: Upstream) => Upstream | "drop" }
  | { rewrite: (u: Upstream) => Upstream | "drop" };

export type Rule = (req: ProxyRequest, forward: (o?: { path?: string; body?: string; method?: string; search?: string }) => Promise<Upstream>) => ProxyAction | Promise<ProxyAction>;

export interface LogEntry {
  method: string;
  path: string;
  search: string;
  status: number | "dropped" | "hung";
}

export class ChaosProxy {
  rules: Rule[] = [];
  log: LogEntry[] = [];
  private seq = 0;
  private sockets = new Set<Socket>();
  private constructor(
    private server: Server,
    readonly url: string,
    private upstream: string,
  ) {}

  static async start(upstream: string): Promise<ChaosProxy> {
    // eslint-disable-next-line prefer-const -- assigned after the server exists
    let self!: ChaosProxy;
    const server = createServer((req, res) => {
      self.handle(req, res).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `proxy: ${(e as Error).message}` }));
        }
      });
    });
    server.on("connection", (s) => {
      self.sockets.add(s);
      s.on("close", () => self.sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    self = new ChaosProxy(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, upstream);
    return self;
  }

  /** Add a rule that fires at most `times` times (default: forever) when `when` matches. */
  on(when: (r: ProxyRequest) => boolean, action: Rule, times = Infinity): this {
    let left = times;
    this.rules.push((r, f) => {
      if (left <= 0 || !when(r)) return undefined;
      left -= 1;
      return action(r, f);
    });
    return this;
  }

  count(method: string, pathRe: RegExp): number {
    return this.log.filter((l) => l.method === method && pathRe.test(l.path)).length;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async forward(req: { method: string; path: string; search: string; body: string; headers: Record<string, string> }): Promise<Upstream> {
    const res = await fetch(this.upstream + req.path + req.search, {
      method: req.method,
      headers: req.headers,
      ...(req.body && req.method !== "GET" ? { body: req.body } : {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== "content-length" && k !== "transfer-encoding" && k !== "connection" && k !== "keep-alive") headers[k] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    const u = new URL(req.url ?? "/", "http://proxy.local");
    const method = (req.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
    const preq: ProxyRequest = { method, path: u.pathname, query: u.searchParams, body, seq: this.seq++ };
    const entry: LogEntry = { method, path: u.pathname, search: u.search, status: 0 };
    this.log.push(entry);
    const fwd = (o: { path?: string; body?: string; method?: string; search?: string } = {}) =>
      this.forward({ method: o.method ?? method, path: o.path ?? u.pathname, search: o.search ?? u.search, body: o.body ?? body, headers });

    let action: ProxyAction = undefined;
    for (const rule of this.rules) {
      action = await rule(preq, fwd);
      if (action !== undefined) break;
    }

    if (action === "hang") {
      entry.status = "hung";
      return; // never answer
    }
    let up: Upstream | "drop";
    if (action === undefined) up = await fwd();
    else if (action === "drop") {
      await fwd();
      up = "drop";
    } else if ("status" in action) {
      up = { status: action.status, headers: { "content-type": "application/json", ...(action.headers ?? {}) }, body: typeof action.body === "string" ? action.body : JSON.stringify(action.body) };
    } else if ("forwardWith" in action) {
      const raw = await fwd(action.forwardWith);
      up = action.rewrite ? action.rewrite(raw) : raw;
    } else {
      up = action.rewrite(await fwd());
    }
    if (up === "drop") {
      entry.status = "dropped";
      req.socket.destroy();
      return;
    }
    entry.status = up.status;
    res.writeHead(up.status, { ...up.headers, "content-length": Buffer.byteLength(up.body) });
    res.end(up.body);
  }
}

export const CTX = { env: "preview", pr: 42, branch: "feat/x", sha: SHA };

export interface CliResult extends CliRun {
  /** Sim writes (non-failed and failed) performed during this invocation. */
  writes: number;
  ms: number;
}

export class World {
  private constructor(
    readonly sim: SimHandle,
    readonly proxy: ChaosProxy,
    private readonly ws: Workspace,
    readonly env: NodeJS.ProcessEnv,
  ) {}

  static async create(opts: { plan: string; seed?: Partial<SimSeed>; env?: Record<string, string>; direct?: boolean }): Promise<World> {
    const sim = await startSim({ seed: opts.seed });
    const proxy = await ChaosProxy.start(sim.url);
    const ws = await workspace("prov", { plan: opts.plan });
    const env = cliEnv(opts.direct ? sim : proxy.url, { SPONSON_RECEIPTS_DIR: join(ws.dir, ".sponson/receipts"), SPONSON_DEPLOY_TIMEOUT_MS: "2000", ...(opts.env ?? {}) });
    return new World(sim, proxy, ws, env);
  }

  get cwd(): string {
    return this.ws.dir;
  }

  async cli(args: string, extra: string[] = []): Promise<CliResult> {
    // Extras go last: commander keeps the last value of a repeated option (e.g. `--env production`).
    const argv = [
      ...args.split(/\s+/).filter(Boolean),
      "--env", CTX.env, "--branch", CTX.branch, "--sha", CTX.sha, "--pr", String(CTX.pr),
      "--receipts", "local", "--receipts-dir", join(this.cwd, ".sponson/receipts"),
      ...extra,
    ];
    const before = this.sim.state.writes.length;
    const t0 = Date.now();
    const r = await runCli(argv, { env: this.env, cwd: this.cwd });
    if (!argv.includes("--json")) r.json = null;
    else if (r.json === null) throw new Error(`stdout is not JSON:\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    return { ...r, writes: this.sim.state.writes.length - before, ms: Date.now() - t0 };
  }

  /** Every receipt/lock file's text, for leak checks. */
  async receiptTexts(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(await readFile(p, "utf8"));
      }
    };
    await walk(join(this.cwd, ".sponson/receipts"));
    return out;
  }

  // --- sim state helpers -------------------------------------------------
  envs(key?: string) {
    return Object.values(this.sim.state.vercel.projects).flatMap((p) => p.envs).filter((e) => !key || e.key === key);
  }
  branches(name?: string) {
    return Object.values(this.sim.state.neon.projects).flatMap((p) => p.branches).filter((b) => !name || b.name === name);
  }
  redirects(url?: string) {
    return this.sim.state.clerk.redirect_urls.filter((r) => !url || r.url === url);
  }
  deployments() {
    return Object.values(this.sim.state.vercel.projects).flatMap((p) => p.deployments);
  }

  async close() {
    await this.proxy.close();
    await this.sim.close();
    await this.ws.cleanup();
  }
}

export const PR_BRANCH = "sponson/preview/pr-42";

/** db → env → callback, the README plan. */
export const THREE_LINE_PLAN = `version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
      APP_NAME: shop
    environments: [preview]
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }
    environments: [preview]
`;

export const isPath = (method: string, re: RegExp) => (r: ProxyRequest) => r.method === method && re.test(r.path);
