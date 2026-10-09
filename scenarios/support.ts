/**
 * What every scenario harness shares: the fixture commit, the env that points the CLI at a sim, throwaway
 * directories, and the in-process CLI. Harnesses add only what is specific to their dimension. Not a test file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { simEnv } from "@sponson/sim";
import { run } from "sponson";

export { simEnv };

/** The head commit every scenario's context uses unless it says otherwise. */
export const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * The env a CLI process gets in a scenario: PATH and HOME from the test process, no colour, the sim's URLs and
 * (unless `tokens: false`) placeholder tokens, then `extra`. `sim` may also be the URL of a proxy in front of it.
 */
export function cliEnv(sim: { url: string } | string, extra: NodeJS.ProcessEnv = {}, opts: { tokens?: boolean } = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", ...simEnv(sim, opts), ...extra };
}

export interface Workspace {
  dir: string;
  /** Remove the directory. Best effort: a killed child process may still be writing into it. */
  cleanup(): Promise<void>;
}

/** A fresh directory under the OS temp dir, optionally holding `release.plan.yaml`. */
export async function workspace(prefix: string, opts: { plan?: string } = {}): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `sponson-${prefix}-`));
  if (opts.plan !== undefined) await writeFile(join(dir, "release.plan.yaml"), opts.plan);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}) };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, or null when it is not JSON. */
  json: any;
}

/** Run the CLI in-process, the way every journey and the scenario runner drive it. */
export async function runCli(argv: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, { stdout: { write: (s) => void (stdout += s) }, stderr: { write: (s) => void (stderr += s) }, env: opts.env, cwd: opts.cwd, color: false });
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* not JSON */
  }
  return { code, stdout, stderr, json };
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX_LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const CLI_BIN = join(REPO, "packages/cli/src/bin.ts");

/** The command that runs the CLI from source: node itself with the tsx loader (no npx resolution per spawn). */
export const CLI_COMMAND = { command: process.execPath, args: ["--import", TSX_LOADER, CLI_BIN] };

/**
 * Start `sponson mcp` the way an agent host does. stderr (adapter logs) is drained into a capped
 * buffer: an unread pipe fills up and blocks the server mid-session.
 */
export function mcpTransport(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): { transport: StdioClientTransport; stderr: () => string } {
  const transport = new StdioClientTransport({
    command: CLI_COMMAND.command,
    args: [...CLI_COMMAND.args, "mcp", ...args],
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-64_000);
  });
  return { transport, stderr: () => log };
}
