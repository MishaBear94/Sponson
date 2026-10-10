/** Test-only harness: an in-process sim plus an AdapterContext pointed at it. Excluded from the build. */
import type { AdapterContext, Ctx } from "@sponson/core";
import { simEnv, startSim, type ChaosConfig, type ChaosRequest, type SimHandle, type SimSeed, type WriteLogEntry } from "@sponson/sim";

/** What an adapter told the engine, in order, with how many sim writes had happened at that moment. */
export interface IntentEvent {
  keys: string[];
  /** `sim.state.writes.length` when `intend` was called: the create it announces must come after. */
  writesBefore: number;
}

export interface Harness {
  sim: SimHandle;
  ctx: Ctx;
  env: NodeJS.ProcessEnv;
  intents: IntentEvent[];
  actx(adapter: string, provider?: Record<string, unknown>, overrides?: Partial<AdapterContext>): AdapterContext;
  chaos(req: ChaosRequest): Promise<ChaosConfig>;
  writes(since?: number): Promise<WriteLogEntry[]>;
  close(): Promise<void>;
}

export const SHA = "abcdef1234567890abcdef1234567890abcdef12";

export async function harness(seed?: Partial<SimSeed>): Promise<Harness> {
  const sim = await startSim({ seed });
  const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: SHA, short_sha: SHA.slice(0, 7) }, pr: { number: 42 }, scope: "pr-42" };
  const env: NodeJS.ProcessEnv = {
    ...simEnv(sim),
    // Keep retries fast in unit tests.
    SPONSON_HTTP_RETRY_BASE_MS: "5",
    SPONSON_HTTP_TIMEOUT_MS: "2000",
  };
  const providers: Record<string, Record<string, unknown>> = { vercel: { project: "prj_demo" }, neon: { project: "proj_demo" }, clerk: {} };
  const intents: IntentEvent[] = [];
  return {
    sim,
    ctx,
    env,
    intents,
    actx: (adapter, provider, overrides) => ({
      ctx,
      provider: provider ?? providers[adapter] ?? {},
      env,
      log: () => {},
      intend: async (keys) => {
        intents.push({ keys: [...keys], writesBefore: sim.state.writes.length });
      },
      redact: (t) => t,
      ...overrides,
    }),
    chaos: async (req) => {
      const r = await fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify(req), headers: { "content-type": "application/json" } });
      return (await r.json()) as ChaosConfig;
    },
    writes: async (since = 0) => (await (await fetch(`${sim.url}/_writes?since=${since}`)).json()) as WriteLogEntry[],
    close: () => sim.close(),
  };
}

/** Index in the sim's write log of the first write matching method+path at or after `from`. */
export function writeIndex(h: Harness, method: string, path: RegExp, from = 0): number {
  return h.sim.state.writes.findIndex((w, i) => i >= from && w.method === method && path.test(w.path));
}

export interface Recorded {
  method: string;
  path: string;
}

/**
 * A pass-through proxy in front of the sim that records every request (reads included, which the sim's write log
 * does not) and can rewrite JSON responses, e.g. to model a list that lags a write.
 */
export async function recordingProxy(upstream: string, rewrite?: (req: Recorded, body: unknown) => unknown): Promise<{ url: string; log: Recorded[]; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const log: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    const forward = async () => {
      const u = new URL(req.url ?? "/", "http://proxy.local");
      const rec = { method: req.method ?? "GET", path: u.pathname };
      log.push(rec);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
      const body = Buffer.concat(chunks).toString("utf8");
      const up = await fetch(upstream + u.pathname + u.search, { method: rec.method, headers, ...(body ? { body } : {}) });
      let text = await up.text();
      if (rewrite && up.ok && text) text = JSON.stringify(rewrite(rec, JSON.parse(text)));
      res.writeHead(up.status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    // A failed forward drops the connection, which the client under test sees as a transport error.
    req.on("end", () => void forward().catch((e: unknown) => res.destroy(e instanceof Error ? e : new Error(String(e)))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
