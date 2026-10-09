/** Shared harness for the secrets / CI-surface journeys. Not a test file. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startSim, type SimHandle } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type CliRun } from "../../support.js";

export { SHA };
export const exec = promisify(execFile);
export type CliResult = CliRun;

/** Distinctive provider tokens, so a leak test can find any fragment of one in output or receipts. */
const TOKENS = { VERCEL_TOKEN: "tok_vercel_9f8e7d6c5b4a", NEON_API_KEY: "tok_neon_1a2b3c4d5e6f", CLERK_SECRET_KEY: "tok_clerk_0f0e0d0c0b0a" };

export interface Rule {
  method: string;
  path: RegExp;
  /** Return a response to short-circuit the sim; return undefined to forward. */
  respond: (req: { method: string; path: string; body: string; headers: IncomingMessage["headers"] }) => { status: number; body: string; type?: string } | undefined;
}

/** A proxy in front of the sim that can override chosen routes, e.g. to echo request data in an error body. */
export async function startEchoProxy(simUrl: string, rules: Rule[]): Promise<{ url: string; close(): Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0]!;
    seen.push(`${method} ${url}`);
    for (const r of rules) {
      if (r.method === method && r.path.test(path)) {
        const out = r.respond({ method, path: url, body, headers: req.headers });
        if (out) {
          res.writeHead(out.status, { "content-type": out.type ?? "application/json" });
          res.end(out.body);
          return;
        }
      }
    }
    const fwd = await fetch(simUrl + url, { method, headers: { ...(req.headers as Record<string, string>), host: new URL(simUrl).host }, body: body || undefined });
    const text = await fwd.text();
    res.writeHead(fwd.status, { "content-type": fwd.headers.get("content-type") ?? "application/json" });
    res.end(text);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export class World {
  private constructor(
    readonly sim: SimHandle,
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv,
    private readonly closers: Array<() => Promise<void>>,
  ) {}

  static async create(plan: string, opts: { env?: Record<string, string>; rules?: Rule[] } = {}): Promise<World> {
    const sim = await startSim();
    const ws = await workspace("sec", { plan });
    const closers: Array<() => Promise<void>> = [() => sim.close(), ws.cleanup];
    let base = sim.url;
    if (opts.rules?.length) {
      const proxy = await startEchoProxy(sim.url, opts.rules);
      closers.unshift(() => proxy.close());
      base = proxy.url;
    }
    return new World(sim, ws.dir, cliEnv(base, { ...TOKENS, ...(opts.env ?? {}) }), closers);
  }

  get receiptsDir(): string {
    return join(this.cwd, ".sponson/receipts");
  }

  async writePlan(plan: string) {
    await writeFile(join(this.cwd, "release.plan.yaml"), plan);
  }

  ctxArgs(extra: { receipts?: "local" | "git-branch"; remote?: string; pr?: number; envName?: string } = {}): string[] {
    const a = ["--env", extra.envName ?? "preview", "--branch", "feat/x", "--sha", SHA, "--pr", String(extra.pr ?? 42)];
    if (extra.receipts === "git-branch") a.push("--receipts", "git-branch", "--receipts-remote", extra.remote!);
    else a.push("--receipts", "local", "--receipts-dir", this.receiptsDir);
    return a;
  }

  async cli(args: string, extra: Parameters<World["ctxArgs"]>[0] & { env?: Record<string, string> } = {}): Promise<CliResult> {
    const argv = [...args.split(/\s+/).filter(Boolean), ...this.ctxArgs(extra)];
    const r = await runCli(argv, { env: { ...this.env, ...(extra.env ?? {}) }, cwd: this.cwd });
    return argv.includes("--json") ? r : { ...r, json: null };
  }

  /** Install fake executables on a private PATH dir that is prepended to PATH. */
  async fakeBin(name: string, script: string): Promise<string> {
    const dir = join(this.cwd, ".bin");
    await mkdir(dir, { recursive: true });
    const p = join(dir, name);
    await writeFile(p, script);
    await chmod(p, 0o755);
    if (!this.env.PATH!.startsWith(dir)) this.env.PATH = `${dir}:${this.env.PATH}`;
    return p;
  }

  async receiptsText(): Promise<string> {
    return readTree(this.receiptsDir);
  }

  async close() {
    for (const c of this.closers) await c().catch(() => {});
  }
}

export async function readTree(dir: string): Promise<string> {
  let out = "";
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out += await readTree(p);
    else out += `\n=== ${p}\n` + (await readFile(p, "utf8"));
  }
  return out;
}

/** Every substring of `secret` of length >= `min` that appears in `text`, longest first. Catches partial leaks. */
export function partialLeaks(text: string, secret: string, min = 8): string[] {
  const found: string[] = [];
  for (let len = secret.length; len >= min; len--) {
    for (let i = 0; i + len <= secret.length; i++) {
      const s = secret.slice(i, i + len);
      if (text.includes(s)) {
        found.push(s);
        return found;
      }
    }
  }
  return found;
}

export const PLAN_ENV = (values: string) => `version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
${values}
`;

export const PLAN_DB_ENV = (extraValues = "") => `version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    environments: [preview]
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
${extraValues}    environments: [preview]
`;
