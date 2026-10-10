/**
 * README's "run it from source" alias, executed as written (with ~/sponson standing for this checkout): it once
 * pointed at packages/cli/dist/bin.js, which cannot run inside the workspace (the packages resolve to src/*.ts).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const readme = readFileSync(join(REPO, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")) as { version: string };

describe("README: run from source", () => {
  it("the documented alias runs the CLI from this checkout", () => {
    const line = /^alias sponson="([^"]+)"$/m.exec(readme)?.[1];
    expect(line, "README.md has an `alias sponson=\"…\"` line").toBeDefined();
    const [cmd, ...args] = line!.replaceAll("~/sponson", REPO.replace(/\/$/, "")).split(" ");
    const out = execFileSync(cmd!, [...args, "--version"], { encoding: "utf8", cwd: REPO });
    expect(out.trim()).toBe(pkg.version);
  });
});
