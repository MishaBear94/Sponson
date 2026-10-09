import type { AddressInfo } from "node:net";
import { createSimServer } from "./server.js";
import { SimState, type SimSeed } from "./state.js";

export * from "./state.js";
export { createSimServer } from "./server.js";

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
