/**
 * README.md's "Try it in 60 seconds" runs as written. Its two `bash` blocks (the first starts the fake cloud with a
 * demo, the second is what to run next) are read from the README, not copied here, so the docs and this suite
 * cannot drift apart:
 *
 *   - the first block runs in one shell and stays up, like a user's first terminal;
 *   - what it prints as the next steps must be the second block, line for line;
 *   - the second block runs line by line in one bash, like a user's second terminal, and each step's output is
 *     checked for what the README promises.
 *
 * `npx` is replaced by a shim on PATH that runs this checkout's sources instead of the published packages, and any
 * `sponson` already installed is hidden, so the env file's npx fallback is exercised too. HOME is a fresh
 * directory, so a contributor's git config cannot change the demo commit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspace, type Workspace } from "../support.js";
import { REPO } from "./plans.js";

/** The `bash` blocks of README.md's "Try it in 60 seconds" section, as lists of non-empty lines. */
export function tryItBlocks(readme: string): { start: string[]; steps: string[] } {
  const at = readme.indexOf("\n### Try it in 60 seconds\n");
  if (at < 0) throw new Error('README.md has no "### Try it in 60 seconds" section');
  // From the heading to the next `##` or `###` heading.
  const body = readme.slice(readme.indexOf("\n", at + 1) + 1);
  const end = body.search(/^#{2,3} /m);
  const section = end < 0 ? body : body.slice(0, end);
  const blocks = [...section.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]!.split("\n").filter((l) => l.trim() !== ""));
  if (blocks.length !== 2) throw new Error(`expected two bash blocks in "Try it in 60 seconds", found ${String(blocks.length)}`);
  return { start: blocks[0]!, steps: blocks[1]! };
}

const TSX_LOADER = join(REPO, "node_modules/tsx/dist/loader.mjs");
const BINS: Record<string, string> = { "@sponson/sim": join(REPO, "packages/sim/src/bin.ts"), sponson: join(REPO, "packages/cli/src/bin.ts") };

/** Stands in for npx: drops `--yes`, then runs the named package's bin from this checkout. */
function npxShim(): string {
  const cases = Object.entries(BINS).map(([pkg, bin]) => `  ${pkg}) exec "${process.execPath}" --import "${TSX_LOADER}" "${bin}" "$@";;`);
  return ["#!/bin/sh", 'while [ "$#" -gt 0 ]; do case "$1" in -y|--yes) shift;; *) break;; esac; done', 'pkg=$1; shift', 'case "$pkg" in', ...cases, '  *) echo "npx shim: unexpected package $pkg" >&2; exit 127;;', "esac", ""].join("\n");
}

/** PATH without any directory that holds a `sponson`, so `command -v sponson` fails as on a fresh machine. */
function pathWithoutSponson(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter((dir) => {
    try {
      accessSync(join(dir, "sponson"), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** One bash fed a line at a time, like a terminal: `cd` and `source` carry over to the next line. */
class Terminal {
  private out = "";
  private waiter: (() => void) | null = null;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.out += chunk.toString();
      this.waiter?.();
    });
    child.stdin.write("exec 2>&1\n");
  }

  /** Run one line; resolves with everything it printed and its exit status. */
  async run(line: string): Promise<{ output: string; code: number }> {
    this.out = "";
    this.child.stdin.write(`${line}\necho "@@exit:$?"\n`);
    for (;;) {
      const m = /@@exit:(\d+)\n/.exec(this.out);
      if (m) return { output: this.out.slice(0, m.index), code: Number(m[1]) };
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}

const { start, steps } = tryItBlocks(await readFile(join(REPO, "README.md"), "utf8"));

let ws: Workspace;
let simUrl: string;
let first: ChildProcessWithoutNullStreams;
let firstOutput = "";
let second: ChildProcessWithoutNullStreams;
let terminal: Terminal;

beforeAll(async () => {
  ws = await workspace("try-it");
  const bin = join(ws.dir, "bin");
  await mkdir(bin);
  await mkdir(join(ws.dir, "home"));
  await writeFile(join(bin, "npx"), npxShim());
  await chmod(join(bin, "npx"), 0o755);
  const port = await freePort();
  simUrl = `http://127.0.0.1:${String(port)}`;
  // The README's default port may be taken on a contributor's machine; the sim honours SPONSON_SIM_PORT.
  const env = { PATH: [bin, ...pathWithoutSponson()].join(delimiter), HOME: join(ws.dir, "home"), NO_COLOR: "1", SPONSON_SIM_PORT: String(port) };
  // Its own process group, so closing it also stops the node process the shim exec'd.
  first = spawn("bash", ["-c", start.join("\n")], { cwd: ws.dir, env, detached: true });
  first.stdout.on("data", (c: Buffer) => void (firstOutput += c.toString()));
  first.stderr.on("data", (c: Buffer) => void (firstOutput += c.toString()));
  const deadline = Date.now() + 30_000;
  // The walkthrough ends with one numbered note per step; the last one complete means all of it arrived.
  const done = new RegExp(`\\n {2}${String(steps.length)}\\. .*\\n`);
  while (!done.test(firstOutput)) {
    if (first.exitCode !== null || Date.now() > deadline) throw new Error(`the first block did not start the demo:\n${firstOutput}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  second = spawn("bash", [], { cwd: ws.dir, env });
  terminal = new Terminal(second);
}, 60_000);

afterAll(async () => {
  second?.stdin.end();
  if (first?.pid !== undefined && first.exitCode === null) {
    const exited = new Promise((r) => first.once("exit", r));
    process.kill(-first.pid, "SIGTERM");
    await exited;
  }
  await ws?.cleanup();
});

async function writes(): Promise<number> {
  return ((await (await fetch(`${simUrl}/_writes`)).json()) as unknown[]).length;
}

/** Run the README's next step, checking it is the one this test expects there. */
async function step(i: number, expected: RegExp): Promise<{ output: string; code: number }> {
  const line = steps[i];
  expect(line, `README step ${String(i + 1)}`).toMatch(expected);
  return terminal.run(line!);
}

describe("README: Try it in 60 seconds", () => {
  it("the first block starts the fake cloud, writes the demo, and prints the second block as the next steps", () => {
    expect(firstOutput).toContain(`listening on ${simUrl}`);
    const printed = firstOutput.split("run these one at a time:")[1]!.split("What each one does:")[0]!;
    expect(printed.split("\n").map((l) => l.trim()).filter((l) => l !== "")).toEqual(steps);
  });

  it("1. loads the env file that points sponson at the sim", async () => {
    const r = await step(0, /^cd .* && source sim\.env$/);
    expect(r).toEqual({ output: "", code: 0 });
  });

  it("2. plan shows the diff: a branch to create, a variable and a callback waiting on it", async () => {
    const r = await step(1, /^sponson plan$/);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("sponson plan · preview · pr-42");
    expect(r.output).toMatch(/\+ db +neon\.branch +create +Neon branch sponson\/preview\/pr-42/);
    expect(r.output).toContain("+ DATABASE_URL (preview, feat/checkout)  (pending ← db.connection_string)");
    expect(r.output).toContain("waiting on `env` (deploy)");
    expect(r.output).toContain("1 to create, 2 pending");
    expect(await writes()).toBe(0);
  });

  it("3. apply creates the branch, injects DATABASE_URL by reference, finds the deploy and allows the redirect", async () => {
    const r = await step(2, /^sponson apply$/);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/\+ db +neon\.branch +applied +Neon branch sponson\/preview\/pr-42/);
    expect(r.output).toMatch(/\+ env +vercel\.env +applied +DATABASE_URL \(preview, feat\/checkout\)/);
    expect(r.output).toMatch(/\+ callback +clerk\.redirect_allow +applied +Clerk redirect https:\/\/prj_demo-[0-9a-f]{8}\.vercel\.app/);
    expect(r.output).toContain("apply complete");
    // The connection string's password never reaches the terminal.
    expect(r.output).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s*]+@/);
    const state = (await (await fetch(`${simUrl}/_state`)).json()) as { neon: { projects: Record<string, { branches: Array<{ name: string }> }> }; clerk: { redirect_urls: unknown[] } };
    expect(state.neon.projects.proj_demo!.branches.map((b) => b.name)).toContain("sponson/preview/pr-42");
    expect(state.clerk.redirect_urls).toHaveLength(1);
  });

  it("4. a second apply changes nothing and writes nothing", async () => {
    const before = await writes();
    const r = await step(3, /^sponson apply$/);
    expect(r.code, r.output).toBe(0);
    expect(r.output.match(/^= \w+ .* unchanged /gm)).toHaveLength(3);
    expect(r.output).toContain("apply complete");
    expect(await writes()).toBe(before);
  });

  it("5. the curl command edits DATABASE_URL behind Sponson's back, like a console would", async () => {
    const r = await step(4, /^curl .*\$SPONSON_SIM_URL\/_chaos/);
    expect(r).toEqual({ output: "", code: 0 });
  });

  it("6. plan catches the drift and blocks that line", async () => {
    const r = await step(5, /^sponson plan$/);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toMatch(/- env +vercel\.env +blocked +DRIFT_CHANGED/);
    expect(r.output).toMatch(/drift\n {2}changed +vercel +DATABASE_URL \(preview, feat\/checkout\) was changed outside Sponson/);
    expect(r.output).not.toContain("typed-in-the-console");
  });

  it("7. apply --destroy removes everything the demo created", async () => {
    const r = await step(6, /^sponson apply --destroy$/);
    expect(r.code, r.output).toBe(0);
    expect(r.output.match(/^- \w+ .* destroyed/gm)).toHaveLength(3);
    expect(r.output).toContain("destroy complete");
    const state = (await (await fetch(`${simUrl}/_state`)).json()) as {
      neon: { projects: Record<string, { branches: Array<{ name: string }> }> };
      vercel: { projects: Record<string, { envs: unknown[] }> };
      clerk: { redirect_urls: unknown[] };
    };
    expect(state.neon.projects.proj_demo!.branches.map((b) => b.name)).toEqual(["main"]);
    expect(state.vercel.projects.prj_demo!.envs).toEqual([]);
    expect(state.clerk.redirect_urls).toEqual([]);
  });

  it("covers every step of the block", () => {
    expect(steps).toHaveLength(7);
  });
});
