/**
 * `pnpm new:adapter` end to end: scaffold an adapter into a throwaway copy of the repository, then check that
 * the copy typechecks, lints, and that the generated unit tests and scenario pass. Also: re-running is a no-op,
 * and an existing hand-written adapter is refused.
 *
 * The copy holds the current working tree's sources (not a git checkout, so uncommitted work is tested too) and
 * symlinks node_modules; it lives under the OS temp dir and is removed afterwards. Nothing is written to the
 * real repository.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const NAME = "acmetool";
const TSX_LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const BIN = (pkg: string, rel: string) => join(REPO, "node_modules", pkg, rel);

/** Everything the scaffold, the typecheck, the linter and the two test runs need; nothing else. */
const COPY = ["package.json", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json", "tsconfig.test.json", "vitest.config.ts", "eslint.config.mjs", "packages", "scripts", "templates", "scenarios/support.ts", "scenarios/runner.test.ts"];
const SKIP = new Set(["dist", "coverage"]);

interface Run {
  code: number | null;
  out: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const node = (cwd: string, ...args: string[]) => run(process.execPath, args, cwd);
const scaffold = (cwd: string, name: string) => node(cwd, "--import", TSX_LOADER, join(cwd, "scripts/new-adapter.ts"), name);

const GENERATED = [`packages/adapters/src/${NAME}.ts`, `packages/adapters/src/${NAME}.test.ts`, `packages/sim/src/routes/${NAME}.ts`, `scenarios/adapters/${NAME}.yaml`];
const EDITED = ["packages/adapters/src/index.ts", "packages/sim/src/state.ts", "packages/sim/src/index.ts"];

describe("pnpm new:adapter", () => {
  let dir = "";
  let first: Run;

  beforeAll(async () => {
    // realpath: on macOS the temp dir is behind a symlink, and tools compare resolved paths.
    dir = await realpath(await mkdtemp(join(tmpdir(), "sponson-new-adapter-")));
    for (const entry of COPY) {
      // verbatimSymlinks: pnpm's per-package node_modules are relative links (to ../../../node_modules/.pnpm/…
      // and to sibling packages); copied as-is they resolve inside the copy.
      await cp(join(REPO, entry), join(dir, entry), { recursive: true, verbatimSymlinks: true, filter: (src) => !SKIP.has(basename(src)) && !src.endsWith(".tsbuildinfo") });
    }
    await symlink(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    first = await scaffold(dir, NAME);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("generates four files and the registrations, and prints them", async () => {
    expect(first.code, first.out).toBe(0);
    for (const f of GENERATED) {
      expect(existsSync(join(dir, f)), f).toBe(true);
      expect(first.out).toContain(`create  ${f}`);
      expect(await readFile(join(dir, f), "utf8")).not.toMatch(/__(name|Name|NAME)__/);
    }
    expect(await readFile(join(dir, "packages/adapters/src/index.ts"), "utf8")).toContain(`.addAdapter(${NAME}Adapter)`);
    expect(await readFile(join(dir, "packages/sim/src/state.ts"), "utf8")).toMatch(new RegExp(`export const PROVIDERS = \\{[^}]*${NAME}: ${NAME}Sim`));
    for (const f of EDITED) expect(first.out).toContain(`edit    ${f}`);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = await Promise.all([...GENERATED, ...EDITED].map((f) => readFile(join(dir, f), "utf8")));
    const again = await scaffold(dir, NAME);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("nothing to do");
    expect(await Promise.all([...GENERATED, ...EDITED].map((f) => readFile(join(dir, f), "utf8")))).toEqual(before);
  });

  it("refuses a name whose adapter it did not generate, and an invalid name", async () => {
    const before = await readFile(join(dir, "packages/adapters/src/index.ts"), "utf8");
    const clerk = await scaffold(dir, "clerk");
    expect(clerk.code).toBe(1);
    expect(clerk.out).toMatch(/clerk\.ts already exists and was not generated/);
    const bad = await scaffold(dir, "Bad-Name");
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/adapter name must match/);
    expect(await readFile(join(dir, "packages/adapters/src/index.ts"), "utf8")).toBe(before);
  });

  it("the generated code typechecks (sources and tests)", async () => {
    const tsc = BIN("typescript", "bin/tsc");
    const build = await node(dir, tsc, "-b");
    expect(build.code, build.out).toBe(0);
    const tests = await node(dir, tsc, "-p", "tsconfig.test.json");
    expect(tests.code, tests.out).toBe(0);
  }, 240_000);

  it("the generated code lints", async () => {
    const lint = await node(dir, BIN("eslint", "bin/eslint.js"), ...GENERATED.filter((f) => f.endsWith(".ts")));
    expect(lint.code, lint.out).toBe(0);
  }, 120_000);

  it("the generated unit tests and scenario pass", async () => {
    const vitest = BIN("vitest", "vitest.mjs");
    const unit = await node(dir, vitest, "run", "--project", "unit", `packages/adapters/src/${NAME}.test.ts`);
    expect(unit.code, unit.out).toBe(0);
    expect(unit.out).toMatch(/Tests\s+7 passed/);
    const scenario = await node(dir, vitest, "run", "--project", "scenarios", "--reporter=verbose", "scenarios/runner.test.ts");
    expect(scenario.code, scenario.out).toBe(0);
    expect(scenario.out).toContain(`adapters/${NAME}.yaml`);
  }, 240_000);

  it("leaves the real repository alone", () => {
    expect(dir.startsWith(REPO)).toBe(false);
    for (const f of GENERATED) expect(existsSync(join(REPO, f)), f).toBe(false);
  });
});
