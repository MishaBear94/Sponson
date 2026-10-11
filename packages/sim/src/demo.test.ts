import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BRANCH, DEMO_DRIFT, DEMO_PLAN, SIM_VERSION, demoEnvFile, demoInstructions, demoSteps, envExports, shellQuote, writeDemo } from "./demo.js";
import { SimState } from "./state.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sponson-sim-demo-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeDemo", () => {
  it("writes the plan, the env file and one commit on the demo branch, leaving the env file out of git", async () => {
    const dir = join(root, "demo");
    await writeDemo(dir, "http://127.0.0.1:4777");
    expect(await readFile(join(dir, "release.plan.yaml"), "utf8")).toBe(DEMO_PLAN);
    expect(await readFile(join(dir, "sim.env"), "utf8")).toBe(demoEnvFile("http://127.0.0.1:4777"));
    expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(DEMO_BRANCH);
    expect((await git(dir, "ls-files")).split("\n").sort()).toEqual([".gitignore", "release.plan.yaml"]);
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });

  it("makes the same commit everywhere, whatever the port, so the preview URL is the same for every reader", async () => {
    await writeDemo(join(root, "a"), "http://127.0.0.1:4777");
    await writeDemo(join(root, "b"), "http://127.0.0.1:5999");
    expect(await git(join(root, "a"), "rev-parse", "HEAD")).toBe(await git(join(root, "b"), "rev-parse", "HEAD"));
  });

  it("uses an existing empty directory", async () => {
    await writeDemo(root, "http://127.0.0.1:4777");
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(DEMO_BRANCH);
  });

  it("refuses a directory that already holds files, and touches none of them", async () => {
    await writeFile(join(root, "mine.txt"), "keep me");
    await expect(writeDemo(root, "http://127.0.0.1:4777")).rejects.toThrow(/is not empty/);
    expect(await readFile(join(root, "mine.txt"), "utf8")).toBe("keep me");
    await expect(readFile(join(root, "release.plan.yaml"))).rejects.toThrow();
  });

  it("explains a path it cannot use", async () => {
    const file = join(root, "file");
    await writeFile(file, "");
    await expect(writeDemo(file, "http://127.0.0.1:4777")).rejects.toThrow(/ENOTDIR/);
  });

  it("names the failing git command, and says when there is no git at all", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\necho 'fatal: boom' >&2\nexit 128\n", { mode: 0o755 });
    const prev = process.env.PATH;
    try {
      process.env.PATH = bin;
      await expect(writeDemo(join(root, "a"), "http://127.0.0.1:4777")).rejects.toThrow("git init -q failed: fatal: boom");
      process.env.PATH = join(root, "nowhere");
      await expect(writeDemo(join(root, "b"), "http://127.0.0.1:4777")).rejects.toThrow(/needs git on PATH/);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("the demo's text", () => {
  it("env file: every adapter variable from simEnv, the sim URL, the pull request, and the CLI of the sim's own version", () => {
    const text = demoEnvFile("http://127.0.0.1:4777");
    for (const line of envExports("http://127.0.0.1:4777")) expect(text).toContain(`${line}\n`);
    expect(text).toContain("export SPONSON_SIM_URL=http://127.0.0.1:4777\n");
    expect(text).toContain("export VERCEL_API_URL=http://127.0.0.1:4777/vercel\n");
    expect(text).toContain("export SPONSON_CTX_PR=42\n");
    // Always the pinned CLI, never "whatever sponson is on PATH": a function shadows a global install.
    expect(text).toContain(`\nsponson() { npx --yes sponson@${SIM_VERSION} "$@"; }\n`);
    expect(text).not.toContain("command -v");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const cli = JSON.parse(readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")) as { version: string };
    expect(SIM_VERSION).toBe(pkg.version);
    // Released together at one version (.changeset/config.json `fixed`): the pinned CLI is the one this sim was built with.
    expect(cli.version).toBe(SIM_VERSION);
  });

  it("steps: no inline comments (interactive zsh would pass them as arguments), and a drift the sim accepts", () => {
    const steps = demoSteps("sponson-demo");
    expect(steps[0]).toBe("cd sponson-demo && source sim.env");
    for (const s of steps) expect(s).not.toMatch(/(^|\s)#/);
    const state = new SimState();
    expect(() => state.applyChaos({ drift: DEMO_DRIFT })).not.toThrow();
  });

  it("instructions list every step, then one note per step", () => {
    const text = demoInstructions("my demo", "http://127.0.0.1:4777");
    expect(text).toContain("listening on http://127.0.0.1:4777");
    for (const s of demoSteps("my demo")) expect(text).toContain(`\n  ${s}\n`);
    expect(text).toContain("cd 'my demo' && source sim.env");
    expect(text).toMatch(new RegExp(`\\n  ${String(demoSteps("x").length)}\\. .+\\n$`));
  });

  it("shellQuote leaves plain paths alone and quotes the rest, quotes included", () => {
    expect(shellQuote("../a/b-c_d.e")).toBe("../a/b-c_d.e");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
