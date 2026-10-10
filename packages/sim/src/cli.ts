/**
 * The `sponson-sim` command line, kept out of bin.ts so it can be tested in-process:
 *   sponson-sim [--port N]               start the fake cloud and print the env that points sponson at it
 *   sponson-sim --demo <dir> [--port N]  the same, plus a ready demo repository in <dir> and what to run next
 *   sponson-sim env [--port N]           print only the `export` lines, for `eval "$(sponson-sim env)"`
 * The demo lives here rather than in the `sponson` CLI, whose command set is fixed (docs/adr/0002-three-commands.md),
 * and because it is about the fake cloud: it only makes sense with a sim running.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { demoInstructions, envExports, writeDemo } from "./demo.js";
import { startSim, type SimHandle } from "./index.js";

/** Where the command line writes and what it reads; the bin passes the process's. */
export interface SimCliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** What the arguments ask for. */
export type SimCommand = { kind: "serve"; port: number; demo?: string } | { kind: "env"; port: number } | { kind: "help" };

/** How the command ended: an exit code, or a running sim the caller keeps alive until a signal. */
export type SimCliResult = { code: number; sim?: SimHandle };

export const USAGE = `usage: sponson-sim [--port N] [--demo <dir>]
       sponson-sim env [--port N]

  --port N      listen on 127.0.0.1:N (default: $SPONSON_SIM_PORT, else 4777)
  --demo <dir>  also write a ready demo repository into <dir> (new or empty) and print what to run next
  env           print the \`export\` lines that point sponson at a sim on that port, for eval "$(sponson-sim env)"
`;

/** Parse argv (without node and the script). Throws with a message for the user on anything it does not know. */
export function parseSimArgs(argv: string[], env: NodeJS.ProcessEnv): SimCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, demo: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { kind: "help" };
  const port = portFrom(values.port, env);
  const [command, ...rest] = positionals;
  if (rest.length > 0 || (command !== undefined && command !== "env")) throw new Error(`unexpected argument: ${[command, ...rest].join(" ")}`);
  if (command === "env") {
    if (values.demo !== undefined) throw new Error("--demo starts a sim; it cannot be combined with `env`");
    return { kind: "env", port };
  }
  if (values.demo !== undefined && values.demo.trim() === "") throw new Error("--demo needs a directory");
  return { kind: "serve", port, ...(values.demo !== undefined ? { demo: values.demo } : {}) };
}

/** `--port`, else SPONSON_SIM_PORT, else 4777. */
function portFrom(flag: string | undefined, env: NodeJS.ProcessEnv): number {
  // A blank SPONSON_SIM_PORT is "not set", as CI systems export variables that do not apply.
  const fromEnv = env.SPONSON_SIM_PORT?.trim();
  const raw = flag ?? (fromEnv === undefined || fromEnv === "" ? "4777" : fromEnv);
  const port = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${raw}`);
  return port;
}

/** Run the command line. A started sim is returned running; the caller decides when to close it. */
export async function runSimCli(argv: string[], io: SimCliIO): Promise<SimCliResult> {
  let cmd: SimCommand;
  try {
    cmd = parseSimArgs(argv, io.env);
  } catch (e) {
    io.stderr(`sponson-sim: ${(e as Error).message}\n${USAGE}`);
    return { code: 2 };
  }
  if (cmd.kind === "help") {
    io.stdout(USAGE);
    return { code: 0 };
  }
  if (cmd.kind === "env") {
    io.stdout(`${envExports(`http://127.0.0.1:${String(cmd.port)}`).join("\n")}\n`);
    return { code: 0 };
  }
  return serve(cmd, io);
}

async function serve(cmd: { port: number; demo?: string }, io: SimCliIO): Promise<SimCliResult> {
  let sim: SimHandle;
  try {
    sim = await startSim({ port: cmd.port });
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
    io.stderr(`sponson-sim: ${busy ? `port ${String(cmd.port)} is in use (another sponson-sim?); pass --port N or set SPONSON_SIM_PORT` : (e as Error).message}\n`);
    return { code: 1 };
  }
  if (cmd.demo === undefined) {
    io.stdout(`sponson-sim listening on ${sim.url}\n# paste into another shell to point sponson at the sim:\n${envExports(sim.url).join("\n")}\n`);
    return { code: 0, sim };
  }
  try {
    // Written after the port is ours: a busy port must not leave a demo behind that points at someone else's sim.
    await writeDemo(resolve(io.cwd, cmd.demo), sim.url);
  } catch (e) {
    await sim.close();
    io.stderr(`sponson-sim: ${(e as Error).message}\n`);
    return { code: 1 };
  }
  io.stdout(demoInstructions(cmd.demo, sim.url));
  return { code: 0, sim };
}
