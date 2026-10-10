import type { AddressInfo } from "node:net";
import { createSimServer } from "./server.js";
import { providerEntries, SimState, type SimSeed } from "./state.js";

export * from "./chaos.js";
export * from "./provider.js";
export * from "./state.js";
export * from "./routes/vercel.js";
export * from "./routes/neon.js";
export * from "./routes/clerk.js";
export * from "./routes/launchdarkly.js";
export { createSimServer } from "./server.js";

/**
 * A running sim: its base URL (`simEnv` turns it into adapter environment), its live state for seeding and
 * assertions, and `close`.
 */
export interface SimHandle {
  url: string;
  port: number;
  state: SimState;
  close(): Promise<void>;
}

/** Start the fake cloud on 127.0.0.1. Port 0 picks a free one, which is what tests want. */
export async function startSim(opts: { port?: number; seed?: Partial<SimSeed> } = {}): Promise<SimHandle> {
  const state = new SimState(opts.seed);
  const server = createSimServer(state);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

/** A placeholder credential per provider (`VERCEL_TOKEN: "tok_vercel"`, …). The sim accepts any non-empty token. */
export const SIM_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(providerEntries().map(([, p]) => [p.env.token, p.env.testToken]));

/**
 * The env that points every provider's adapter at a sim (or at a proxy in front of one): each `*_API_URL`
 * and, unless `tokens: false`, the placeholder credentials of SIM_TOKENS.
 */
export function simEnv(sim: { url: string } | string, opts: { tokens?: boolean } = {}): Record<string, string> {
  const base = typeof sim === "string" ? sim : sim.url;
  const env: Record<string, string> = opts.tokens === false ? {} : { ...SIM_TOKENS };
  for (const [name, p] of providerEntries()) env[p.env.url] = `${base}/${name}`;
  return env;
}
