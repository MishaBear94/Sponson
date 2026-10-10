#!/usr/bin/env node
import { runSimCli } from "./cli.js";

const { code, sim } = await runSimCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
});
if (!sim) process.exit(code);

const stop = () => {
  void sim.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
