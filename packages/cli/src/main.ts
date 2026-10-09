import { Command, CommanderError, Option } from "commander";
import { Redactor, isSponsonError, type Registry } from "@sponson/core";
import { applyCommand } from "./commands/apply.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { planCommand } from "./commands/plan.js";
import { UsageError, exitCodeFor, type GlobalOpts, type IO } from "./context.js";
import { defaultRegistry } from "./registry.js";
import { errorJson } from "./render.js";

export interface RunIO {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Override the adapter registry (tests, the scenario runner). */
  createRegistry?: () => Registry | Promise<Registry>;
  /** Force colors on or off. Default: on only for a TTY without NO_COLOR. */
  color?: boolean;
}

/**
 * Run the CLI in-process. `argv` excludes node and the script name.
 * Resolves to the exit code; never throws for user-facing errors.
 */
export async function run(argv: string[], init: RunIO = {}): Promise<number> {
  const redactor = new Redactor();
  const env = init.env ?? process.env;
  const rawOut = init.stdout ?? process.stdout;
  const rawErr = init.stderr ?? process.stderr;
  // Every byte of output passes through the redactor.
  const io: IO = {
    stdout: { write: (s) => rawOut.write(redactor.redact(s)) },
    stderr: { write: (s) => rawErr.write(redactor.redact(s)) },
    env,
    cwd: init.cwd ?? process.cwd(),
    createRegistry: init.createRegistry ?? defaultRegistry,
    color: init.color ?? (Boolean(process.stdout.isTTY) && env.NO_COLOR === undefined && init.stdout === undefined),
  };

  let code = 0;
  const program = buildProgram(io, redactor, (c) => (code = c));
  const json = argv.includes("--json");
  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2; // help/version vs usage
    return reportError(e, io, json, env);
  }
}

function reportError(e: unknown, io: IO, json: boolean, env: NodeJS.ProcessEnv): number {
  const debug = env.SPONSON_DEBUG === "1";
  let code: number;
  let payload: { code: string; message: string; details?: Record<string, unknown> };
  if (isSponsonError(e)) {
    code = exitCodeFor(e);
    payload = { code: e.code, message: e.message, details: e.details };
  } else if (e instanceof UsageError) {
    code = 2;
    payload = { code: "USAGE", message: e.message };
  } else {
    code = 1;
    payload = { code: "INTERNAL", message: (e as Error)?.message ?? String(e) };
  }
  if (json) io.stdout.write(JSON.stringify(errorJson(payload)) + "\n");
  else io.stderr.write(`error ${payload.code}: ${payload.message}\n`);
  if (debug && e instanceof Error && e.stack) io.stderr.write(e.stack + "\n");
  return code;
}

function buildProgram(io: IO, redactor: Redactor, setCode: (c: number) => void): Command {
  const program = new Command("sponson")
    .description("One release, one plan. Declares and applies everything that ships beside the code.")
    .version("0.1.0")
    .option("--plan <path>", "plan file (default: release.plan.yaml in the working directory)")
    .option("--env <name>", "environment; production is never inferred from the branch", "preview")
    .option("--pr <n>", "pull request number (default: detected from CI or `gh`)")
    .option("--branch <name>", "git branch (default: checked-out branch)")
    .option("--sha <sha>", "git commit (default: HEAD)")
    .option("--json", "machine-readable output on stdout")
    .addOption(new Option("--receipts <store>", "receipt store; overrides the plan's `receipts:`").choices(["git-branch", "local"]))
    .option("--receipts-dir <dir>", "local receipt store root (default: .sponson/receipts, or $SPONSON_RECEIPTS_DIR)")
    .option("--receipts-remote <url>", "git remote for the receipts branch (default: origin, or $SPONSON_RECEIPTS_REMOTE)")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError(false);

  const globals = (cmd: Command): GlobalOpts => cmd.optsWithGlobals() as GlobalOpts;

  const plan = (name: string, description: string) =>
    program
      .command(name)
      .description(description)
      .action(async (_opts, cmd: Command) => setCode(await planCommand(globals(cmd), io, redactor)));
  plan("plan", "read live state and print the diff and drift; changes nothing");
  plan("status", "alias of plan");

  program
    .command("apply")
    .description("apply the plan for this environment and scope, roll back on failure, write a receipt")
    .option("--destroy", "destroy everything this scope created, in reverse order")
    .option("--approved-by <who>", "who approved this run; required for --env production")
    .option("--reconcile", "overwrite values changed outside Sponson since the last apply")
    .option("--wait", "poll for deploys and locks instead of stopping with status partial")
    .option("--wait-timeout <seconds>", "give up waiting after this long (default: 600)")
    .action(async (_opts, cmd: Command) => setCode(await applyCommand(cmd.optsWithGlobals(), io, redactor)));

  program
    .command("init")
    .description("write a starter plan, or adopt unmanaged resources into the existing one")
    .option("--adopt <id>", "adopt only the unmanaged resource with this key, id or label")
    .action(async (_opts, cmd: Command) => setCode(await initCommand(cmd.optsWithGlobals(), io, redactor)));

  program
    .command("mcp")
    .description("serve plan / apply / receipt as MCP tools over stdio")
    .action(async (_opts, cmd: Command) => setCode(await mcpCommand(globals(cmd), io)));

  return program;
}
