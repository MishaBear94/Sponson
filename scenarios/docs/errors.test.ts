/**
 * Generated documentation must match its sources: docs/errors.md (ERROR_CODES) and the outputs table in
 * docs/plan-format.md (the outputs the built-in ops declare). On failure, run `pnpm docs:gen` and commit the result.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@sponson/core";
import { generate, REPO } from "../../scripts/gen-docs.js";

describe("generated docs", async () => {
  const files = await generate();

  it.each(files.map((f) => [f.path, f.content] as const))("%s is up to date (run pnpm docs:gen)", async (path, expected) => {
    const actual = await readFile(join(REPO, path), "utf8").catch(() => "(missing)");
    // A plain boolean first, so the failure says what to do before the diff.
    expect(actual === expected, `${path} is out of date: run \`pnpm docs:gen\` and commit the result`).toBe(true);
  });

  it("docs/errors.md lists every error code", async () => {
    const doc = await readFile(join(REPO, "docs/errors.md"), "utf8");
    for (const code of Object.keys(ERROR_CODES)) expect(doc).toContain(`| \`${code}\` |`);
  });
});
