/** Test-only harness: an in-process sim plus an AdapterContext pointed at it. Excluded from the build. */
import type { AdapterContext, Ctx } from "@sponson/core";
import { startSim, type ChaosConfig, type ChaosRequest, type SimHandle, type SimSeed, type WriteLogEntry } from "@sponson/sim";

export interface Harness {
  sim: SimHandle;
  ctx: Ctx;
  env: NodeJS.ProcessEnv;
  actx(adapter: string, provider?: Record<string, unknown>): AdapterContext;
  chaos(req: ChaosRequest): Promise<ChaosConfig>;
  writes(since?: number): Promise<WriteLogEntry[]>;
  close(): Promise<void>;
}

export const SHA = "abcdef1234567890abcdef1234567890abcdef12";

export async function harness(seed?: Partial<SimSeed>): Promise<Harness> {
  const sim = await startSim({ seed });
  const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: SHA, short_sha: SHA.slice(0, 7) }, pr: { number: 42 }, scope: "pr-42" };
  const env: NodeJS.ProcessEnv = {
    VERCEL_TOKEN: "test-vercel-token",
    VERCEL_API_URL: `${sim.url}/vercel`,
    NEON_API_KEY: "test-neon-key",
    NEON_API_URL: `${sim.url}/neon`,
    CLERK_SECRET_KEY: "test-clerk-key",
    CLERK_API_URL: `${sim.url}/clerk`,
  };
  const providers: Record<string, Record<string, unknown>> = { vercel: { project: "prj_demo" }, neon: { project: "proj_demo" }, clerk: {} };
  return {
    sim,
    ctx,
    env,
    actx: (adapter, provider) => ({ ctx, provider: provider ?? providers[adapter] ?? {}, env, log: () => {} }),
    chaos: async (req) => {
      const r = await fetch(`${sim.url}/_chaos`, { method: "POST", body: JSON.stringify(req), headers: { "content-type": "application/json" } });
      return (await r.json()) as ChaosConfig;
    },
    writes: async (since = 0) => (await (await fetch(`${sim.url}/_writes?since=${since}`)).json()) as WriteLogEntry[],
    close: () => sim.close(),
  };
}
