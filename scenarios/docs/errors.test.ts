/**
 * Generated documentation must match its sources: docs/errors.md (ERROR_CODES) and the generated blocks of
 * docs/plan-format.md (built-in adapters and ops, secret schemes, outputs: all from `createRegistry()`). On failure,
 * run `pnpm docs:gen` and commit the result.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@sponson/core";
import { createRegistry } from "@sponson/adapters";
import { generate, markers, REPO } from "../../scripts/gen-docs.js";

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

  it("docs/plan-format.md lists every built-in adapter, op and secret scheme in its generated blocks", async () => {
    const doc = await readFile(join(REPO, "docs/plan-format.md"), "utf8");
    const block = (name: string) => {
      const { start, end } = markers(name);
      return doc.slice(doc.indexOf(start), doc.indexOf(end));
    };
    const registry = createRegistry();
    for (const name of registry.adapterNames()) {
      expect(block("adapters")).toContain(`| \`${name}\` |`);
      for (const op of Object.keys(registry.adapter(name).ops)) expect(block("adapters")).toContain(`\`${name}.${op}\``);
    }
    for (const scheme of registry.secretSchemes()) expect(block("secret-schemes")).toContain(`| \`${scheme}\` |`);
  });
});
