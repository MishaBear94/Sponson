/**
 * README.md's sample output of `sponson init` and `sponson init --setup` is what the CLI prints, byte for byte: each
 * `$ sponson init…` block is compared with a real run on a fixture repository that has what the sample says it
 * detected. A sample that drifts from the CLI (an absolute path, a dropped line, a stale version) fails here.
 *
 * `--setup` runs against the fake cloud with a scripted person at the terminal (its prompts and answers echoed where
 * a terminal shows them), a fake `gh`, and a local repository standing in for the action's, whose release tag points
 * at a commit with fixed contents (so its sha is the same everywhere). The installed version is not written in the
 * README: the sample says `sponson@<version>`, which the run's output is compared with.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SIM_TOKENS, startSim } from "@sponson/sim";
import { run } from "sponson";
import { DEMO_COMMAND } from "../../packages/cli/src/setup.js";
import type { Terminal } from "../../packages/cli/src/terminal.js";
import { VERSION } from "../../packages/cli/src/version.js";
import { simEnv } from "../support.js";
import { REPO, tryItBlocks } from "./plans.js";

const readme = await readFile(join(REPO, "README.md"), "utf8");

/** The README's fenced block that starts with `$ <command>`, without the fences. */
function sample(command: string): string {
  const m = new RegExp(`^\`\`\`\\n(\\$ ${command.replace(/[-]/g, "\\$&")}\\n[\\s\\S]*?)^\`\`\`$`, "m").exec(readme);
  if (!m) throw new Error(`README.md has no sample block starting with "$ ${command}"`);
  return m[1]!;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sponson-readme-${prefix}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const FIXED_GIT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };

/** A repository with these files and a GitHub origin. */
async function appRepo(files: Record<string, string | object>): Promise<string> {
  const dir = await tempDir("app");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/web.git"], { cwd: dir });
  return dir;
}

const DEPS = { next: "15.1.0", "@neondatabase/serverless": "^1.0.0", "@clerk/nextjs": "^6.0.0" };

describe("README: sponson init", () => {
  it("prints the sample, on a repository with what the sample detects", async () => {
    const cwd = await appRepo({ "package.json": { dependencies: { ...DEPS, "@prisma/client": "^6.0.0" } }, ".vercel/project.json": { projectId: "prj_acme_web" } });
    let out = "";
    const code = await run(["init"], { cwd, env: {}, stdout: { write: (s: string) => void (out += s) }, stderr: { write: () => {} }, color: false });
    expect(code).toBe(0);
    expect(`$ sponson init\n${out}`).toBe(sample("sponson init"));
  });
});

describe("README: sponson init --setup", () => {
  it("prints the sample: a person types two tokens, one is rejected; secrets stored with gh; the workflow pinned", async () => {
    const sim = await startSim();
    cleanups.push(() => sim.close());
    sim.state.applyChaos({ fail_next: 1, status: 401, fail_on: "GET /clerk/*" });

    const bin = await tempDir("bin");
    await writeFile(join(bin, "gh"), `#!${process.execPath}\nprocess.stdin.resume().on('end', () => {});\n`);
    await chmod(join(bin, "gh"), 0o755);

    const action = await tempDir("action");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: action, encoding: "utf8", env: { ...process.env, ...FIXED_GIT } }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "--no-verify", "-m", "release");
    git("tag", "-a", `sponson@${VERSION}`, "-m", "release");
    const commit = git("rev-parse", "HEAD");

    const cwd = await appRepo({ "package.json": { dependencies: DEPS }, ".vercel/project.json": { projectId: "prj_demo" }, ".neon": { projectId: "proj_demo" } });
    let out = "";
    const typed: Record<string, string> = { NEON_API_KEY: SIM_TOKENS.NEON_API_KEY!, CLERK_SECRET_KEY: "sk_test_revoked" };
    // A terminal as a person sees it: the prompt, nothing of what is typed (hidden), and their y answers.
    const terminal: Terminal = {
      interactive: true,
      secret: (q) => {
        out += `${q.trimEnd()}\n`;
        return Promise.resolve(typed[/([A-Z][A-Z0-9_]+) \(input hidden/.exec(q)?.[1] ?? ""] ?? "");
      },
      confirm: (q) => {
        out += `${q} [y/N] y\n`;
        return Promise.resolve(true);
      },
    };
    const env = { ...simEnv(sim, { tokens: false }), VERCEL_TOKEN: SIM_TOKENS.VERCEL_TOKEN!, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME, SPONSON_ACTION_REPO: action };
    const code = await run(["init", "--setup"], { cwd, env, terminal, stdout: { write: (s: string) => void (out += s) }, stderr: { write: (s: string) => void (out += s) }, color: false });

    expect(code).toBe(0);
    const shown = `$ sponson init --setup\n${out}`.replaceAll(`sponson@${VERSION}`, "sponson@<version>").replaceAll(commit.slice(0, 12), "<commit>");
    expect(shown).toBe(sample("sponson init --setup").replace(/\b[0-9a-f]{12}\b/, "<commit>"));
  });

  it("ends, when not ready, with the command that starts the README's zero-account demo", () => {
    expect(tryItBlocks(readme).start).toEqual([DEMO_COMMAND]);
  });
});
