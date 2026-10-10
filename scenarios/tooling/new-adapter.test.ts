/**
 * `pnpm new:adapter` end to end. The promise in CONTRIBUTING.md is that right after the scaffold,
 * `pnpm typecheck && pnpm lint && pnpm test` passes with no manual edit. This suite keeps that promise: it scaffolds
 * an adapter into a throwaway copy of the repository and runs, in the copy, every check of those commands that a
 * scaffold can affect:
 *
 *   typecheck   tsc -b and tsc -p tsconfig.test.json, as `pnpm typecheck`
 *   lint        eslint over the whole copy, as `pnpm lint` (generated files, edited files, the lint project limits)
 *   unit        the whole unit project: the generated tests, the public-API list and doc comments
 *               (packages/core/src/public-api.test.ts), the CLI's registry tests
 *   scenarios   scenarios/runner.test.ts, which runs the generated scenario
 *   docs        scenarios/docs/: generated docs up to date, schema in parity with the parser, links
 *
 * Not run in the copy: the journeys and the property suite (they use createRegistry() but not the set of adapters
 * in it) and this suite itself. Also checked: re-running is a no-op, a hand-written adapter is refused, --help,
 * and that the template only imports helpers that `@sponson/adapters` exports (the stable authoring API), so an
 * out-of-tree author copying it gets the same names from the package.
 *
 * The copy holds the current working tree (tracked and untracked, not ignored: what a contributor's clone would
 * hold, plus uncommitted work) and symlinks node_modules; it lives under the OS temp dir and is removed
 * afterwards. Nothing is written to the real repository.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const NAME = "acmetool";
const TSX_LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const BIN = (pkg: string, rel: string) => join(REPO, "node_modules", pkg, rel);

/** Never copied: the dependencies (symlinked instead), git, and build output anywhere in the tree. */
const SKIP_TOP = new Set(["node_modules", ".git", ".claude"]);
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
const newAdapter = (cwd: string, ...args: string[]) => node(cwd, "--import", TSX_LOADER, join(cwd, "scripts/new-adapter.ts"), ...args);
const vitest = (cwd: string, ...args: string[]) => node(cwd, BIN("vitest", "vitest.mjs"), "run", ...args);

/** Top-level entries of the working tree a contributor has: tracked and untracked files git does not ignore. */
async function topLevelEntries(): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(stdout.split("\n").filter(Boolean).map((f) => f.split("/")[0]!))];
  } catch {
    return (await readdir(REPO)).filter((e) => ![".sponson", "brainstorm", "coverage", ".claude"].includes(e));
  }
}

const GENERATED = [`packages/adapters/src/${NAME}.ts`, `packages/adapters/src/${NAME}.test.ts`, `packages/sim/src/routes/${NAME}.ts`, `scenarios/adapters/${NAME}.yaml`];
const EDITED = ["packages/adapters/src/index.ts", "packages/sim/src/state.ts", "packages/sim/src/index.ts", "packages/core/src/public-api.test.ts", "docs/plan-format.md"];

describe("pnpm new:adapter", () => {
  let dir = "";
  let first: Run;

  beforeAll(async () => {
    // realpath: on macOS the temp dir is behind a symlink, and tools compare resolved paths.
    dir = await realpath(await mkdtemp(join(tmpdir(), "sponson-new-adapter-")));
    for (const entry of await topLevelEntries()) {
      if (SKIP_TOP.has(entry)) continue;
      // verbatimSymlinks: pnpm's per-package node_modules are relative links (to ../../../node_modules/.pnpm/…
      // and to sibling packages); copied as-is they resolve inside the copy.
      await cp(join(REPO, entry), join(dir, entry), { recursive: true, verbatimSymlinks: true, filter: (src) => !SKIP.has(basename(src)) && !src.endsWith(".tsbuildinfo") });
    }
    await symlink(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    first = await newAdapter(dir, NAME);
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("generates four files, the registrations and the docs, and prints them", async () => {
    expect(first.code, first.out).toBe(0);
    for (const f of GENERATED) {
      expect(existsSync(join(dir, f)), f).toBe(true);
      expect(first.out).toContain(`create  ${f}`);
      expect(await readFile(join(dir, f), "utf8")).not.toMatch(/__(name|Name|NAME)__/);
    }
    expect(await readFile(join(dir, "packages/adapters/src/index.ts"), "utf8")).toContain(`.addAdapter(${NAME}Adapter)`);
    expect(await readFile(join(dir, "packages/sim/src/state.ts"), "utf8")).toMatch(new RegExp(`export const PROVIDERS = \\{[^}]*${NAME}: ${NAME}Sim`));
    for (const f of EDITED) expect(first.out).toContain(`edit    ${f}`);
    // The docs generator reads the adapter's `about` from the registry (ADR 0015); the scaffold never edits it.
    expect(first.out).not.toContain("scripts/gen-docs.ts");
    expect(await readFile(join(dir, "packages/adapters/src/acmetool.ts"), "utf8")).toContain("about: ABOUT");
    expect(first.out).toMatch(/ran {5}pnpm docs:gen: wrote docs\/plan-format\.md/);
    expect(await readFile(join(dir, "docs/plan-format.md"), "utf8")).toContain(`| \`${NAME}.item\` |`);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const files = [...GENERATED, ...EDITED, "docs/errors.md"];
    const before = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
    const again = await newAdapter(dir, NAME);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("nothing to do");
    expect(await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).toEqual(before);
  });

  it("refuses a name whose adapter it did not generate, an invalid name and an unknown option", async () => {
    const before = await readFile(join(dir, "packages/adapters/src/index.ts"), "utf8");
    const clerk = await newAdapter(dir, "clerk");
    expect(clerk.code).toBe(1);
    expect(clerk.out).toMatch(/clerk\.ts already exists and was not generated/);
    const bad = await newAdapter(dir, "Bad-Name");
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/adapter name must match/);
    const unknown = await newAdapter(dir, NAME, "--force");
    expect(unknown.code).toBe(2);
    expect(unknown.out).toMatch(/unknown option --force[\s\S]*usage: pnpm new:adapter/);
    expect(await readFile(join(dir, "packages/adapters/src/index.ts"), "utf8")).toBe(before);
  });

  it.each([["--help"], ["-h"]])("%s prints the usage and exits 0", async (flag) => {
    const help = await newAdapter(dir, flag);
    expect(help.code, help.out).toBe(0);
    expect(help.out).toMatch(/^usage: pnpm new:adapter <name> \[--dry-run\]/);
  });

  it("the template imports only the stable authoring API exported by @sponson/adapters", async () => {
    const template = await readFile(join(REPO, "templates/adapter/adapter.ts.tmpl"), "utf8");
    const source = ts.createSourceFile("adapter.ts", template, ts.ScriptTarget.ES2022);
    const imported: string[] = [];
    for (const s of source.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const from = s.moduleSpecifier.text;
      if (!from.startsWith(".")) continue;
      // Relative imports are the package's own modules; only these two hold the authoring API.
      expect(["./common.js", "./http.js"], `the template imports from ${from}`).toContain(from);
      const named = s.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) imported.push(...named.elements.map((e) => (e.propertyName ?? e.name).text));
    }
    expect(imported.length).toBeGreaterThan(0);

    const index = join(REPO, "packages/adapters/src/index.ts");
    const program = ts.createProgram([index], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true });
    const checker = program.getTypeChecker();
    const exported = new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(index)!)!).map((e) => e.name));
    // A helper missing here: export it from packages/adapters/src/index.ts, document it as stable, list it in
    // CONTRIBUTING.md ("stable authoring API") and in PUBLIC_API — or stop using it in the template.
    expect(imported.filter((n) => !exported.has(n))).toEqual([]);
  }, 60_000);

  it("pnpm typecheck passes (sources and tests)", async () => {
    const tsc = BIN("typescript", "bin/tsc");
    const build = await node(dir, tsc, "-b");
    expect(build.code, build.out).toBe(0);
    const tests = await node(dir, tsc, "-p", "tsconfig.test.json");
    expect(tests.code, tests.out).toBe(0);
  }, 240_000);

  it("pnpm lint passes", async () => {
    const lint = await node(dir, BIN("eslint", "bin/eslint.js"), ".");
    expect(lint.code, lint.out).toBe(0);
  }, 180_000);

  it("the unit project passes: the generated tests, the public-API list and doc comments, the registry tests", async () => {
    const unit = await vitest(dir, "--project", "unit", "--reporter=verbose");
    expect(unit.code, unit.out).toBe(0);
    expect(unit.out).toContain(`packages/adapters/src/${NAME}.test.ts`);
    expect(unit.out).toContain("packages/core/src/public-api.test.ts");
  }, 240_000);

  it("the generated scenario passes", async () => {
    const scenario = await vitest(dir, "--project", "scenarios", "--reporter=verbose", "scenarios/runner.test.ts");
    expect(scenario.code, scenario.out).toBe(0);
    expect(scenario.out).toContain(`adapters/${NAME}.yaml`);
  }, 240_000);

  it("the docs suites pass: generated docs up to date, schema, links", async () => {
    const docs = await vitest(dir, "--project", "tooling", "scenarios/docs/");
    expect(docs.code, docs.out).toBe(0);
    expect(docs.out).not.toContain("new-adapter.test.ts");
  }, 240_000);

  it("leaves the real repository alone", async () => {
    expect(dir.startsWith(REPO)).toBe(false);
    for (const f of GENERATED) expect(existsSync(join(REPO, f)), f).toBe(false);
    expect(await readFile(join(REPO, "packages/core/src/public-api.test.ts"), "utf8")).not.toContain(`${NAME}Adapter`);
  });
});
