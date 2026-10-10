import { Command, CommanderError, Option } from "commander";
import { Redactor, type Registry } from "@sponson/core";
import { applyCommand } from "./commands/apply.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { planCommand } from "./commands/plan.js";
import type { GlobalOpts, IO } from "./context.js";
import { cliHint, errorEnvelope, exitCodeFor, serialize, toSponsonError } from "./output.js";
import { defaultRegistry, loadPlugins } from "./registry.js";
import { VERSION } from "./version.js";

/** Where an in-process `run` reads and writes. Every field defaults to the real process. */
export interface RunIO {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Override the base adapter registry (tests, the scenario runner). `$SPONSON_PLUGINS` are loaded into it. */
  createRegistry?: () => Registry | Promise<Registry>;
  /** Force colors on or off. Default: on only for a TTY without NO_COLOR. */
  color?: boolean;
}

/**
 * Run the CLI in-process, exactly as `sponson <argv>` would: for tests, wrappers and tools that want the CLI's
 * behaviour and output contract without spawning a process. `argv` excludes node and the script name.
 * Resolves to the exit code; never throws.
 *
 * @example
 * ```ts
 * let out = "";
 * const code = await run(["plan", "--json"], { cwd: repoDir, stdout: { write: (s: string) => (out += s) } });
 * const plan = JSON.parse(out); // the same envelope `sponson plan --json` prints
 * ```
 */
export async function run(argv: string[], init: RunIO = {}): Promise<number> {
  // One redactor for the whole command: the engine registers into it, every byte of output passes through it.
  const redactor = new Redactor();
  const env = init.env ?? process.env;
  const cwd = init.cwd ?? process.cwd();
  const baseRegistry = init.createRegistry ?? defaultRegistry;
  const rawOut = init.stdout ?? process.stdout;
  const rawErr = init.stderr ?? process.stderr;
  const io: IO = {
    stdout: { write: (s) => rawOut.write(redactor.redact(s)) },
    stderr: { write: (s) => rawErr.write(redactor.redact(s)) },
    json: (payload) => rawOut.write(serialize(payload, redactor) + "\n"),
    env,
    cwd,
    createRegistry: async () => loadPlugins(await baseRegistry(), env, cwd),
    color: init.color ?? (Boolean(process.stdout.isTTY) && env.NO_COLOR === undefined && init.stdout === undefined),
  };

  const json = argv.includes("--json");
  let code = 0;
  const program = buildProgram(io, redactor, (c) => (code = c));
  const command = commandOf(program, argv);
  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (e) {
    // --help / --version: commander already printed them.
    if (e instanceof CommanderError && e.exitCode === 0) return 0;
    return reportError(e, io, json, program, command, env);
  }
}

/**
 * The subcommand named on the command line (aliases resolved), the unknown word in its place, or null.
 * Which global options take a value is read from the program, so a new option cannot be mistaken for a command.
 */
function commandOf(program: Command, argv: string[]): string | null {
  const valued = new Set(program.options.filter((o) => o.required || o.optional).flatMap((o) => [o.long, o.short].filter((f): f is string => !!f)));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (valued.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    const cmd = program.commands.find((c) => c.name() === a || c.aliases().includes(a));
    return cmd ? cmd.name() : a;
  }
  return null;
}

/** Only a real command name goes into the error envelope; an unknown word stays out. */
function reportError(e: unknown, io: IO, json: boolean, program: Command, command: string | null, env: NodeJS.ProcessEnv): number {
  const err = toSponsonError(e);
  const known = command !== null && program.commands.some((c) => c.name() === command) ? command : null;
  if (json) io.json(errorEnvelope(known, err));
  else io.stderr.write(`error ${err.code}: ${err.message}${cliHint(err.code) ? ` ${cliHint(err.code)}` : ""}\n`);
  if (env.SPONSON_DEBUG === "1" && e instanceof Error && e.stack) io.stderr.write(e.stack + "\n");
  return exitCodeFor(err);
}

function buildProgram(io: IO, redactor: Redactor, setCode: (c: number) => void): Command {
  const program = new Command("sponson")
    .description("One release, one plan. Declares and applies everything that ships beside the code.")
    .version(VERSION)
    .option("--plan <path>", "plan file (default: release.plan.yaml in the working directory)")
    .option("--env <name>", "environment; production is never inferred from the branch", "preview")
    .option("--pr <n>", "pull request number (default: detected from CI or `gh`)")
    .option("--branch <name>", "git branch (default: checked-out branch)")
    .option("--sha <sha>", "git commit (default: HEAD)")
    .option("--json", "machine-readable output on stdout: one JSON document, also for errors")
    .addOption(new Option("--receipts <store>", "receipt store; overrides the plan's `receipts:`").choices(["git-branch", "local"]))
    .option("--receipts-dir <dir>", "local receipt store root (default: .sponson/receipts, or $SPONSON_RECEIPTS_DIR)")
    .option("--receipts-remote <url>", "git remote for the receipts branches (default: origin, or $SPONSON_RECEIPTS_REMOTE)")
    .exitOverride()
    // Usage errors are reported once, by reportError, in the same envelope as every other failure.
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s), outputError: () => {} })
    .showHelpAfterError(false);

  const globals = (cmd: Command): GlobalOpts => cmd.optsWithGlobals() as GlobalOpts;

  program
    .command("plan")
    .alias("status")
    .description("read live state and print the diff and drift; changes nothing")
    .action(async (_opts, cmd: Command) => setCode(await planCommand(globals(cmd), io, redactor)));

  program
    .command("apply")
    .description("apply the plan for this environment and scope, roll back on failure, write a receipt")
    .option("--destroy", "destroy everything this scope created, in reverse order")
    .option("--approved-by <who>", "who approved this run; required when a line writes to production (or $SPONSON_APPROVED_BY)")
    .option("--reconcile", "overwrite values changed outside Sponson since the last apply")
    .option("--wait", "poll for deploys and locks instead of stopping with status partial")
    .option("--wait-timeout <seconds>", "give up waiting after this long (default: 600)")
    .action(async (_opts, cmd: Command) => setCode(await applyCommand(cmd.optsWithGlobals(), io, redactor)));

  program
    .command("init")
    .description("write a starter plan, or adopt unmanaged resources into the existing one")
    .option("--adopt <key>", "adopt only the unmanaged resource with this key, id or label")
    .action(async (_opts, cmd: Command) => setCode(await initCommand(cmd.optsWithGlobals(), io, redactor)));

  program
    .command("mcp")
    .description("serve plan / apply / receipt as MCP tools over stdio")
    .action(async (_opts, cmd: Command) => setCode(await mcpCommand(globals(cmd), io)));

  return program;
}
