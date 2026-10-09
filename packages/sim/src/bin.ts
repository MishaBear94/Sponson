#!/usr/bin/env node
import { simEnv, startSim } from "./index.js";

const args = process.argv.slice(2);
const flag = args.indexOf("--port");
const port = Number(flag >= 0 ? args[flag + 1] : (process.env.SPONSON_SIM_PORT ?? 4777));
if (!Number.isInteger(port) || port < 0) {
  console.error(`invalid port: ${flag >= 0 ? args[flag + 1] : process.env.SPONSON_SIM_PORT}`);
  process.exit(2);
}

const sim = await startSim({ port });
console.log(`sponson-sim listening on ${sim.url}`);
console.log(`  ${Object.entries(simEnv(sim, { tokens: false })).map(([k, v]) => `${k}=${v}`).join("  ")}`);

const stop = () => {
  sim.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
