/**
 * Generated documentation must match its sources: docs/errors.md (ERROR_CODES) and the generated blocks of
 * docs/plan-format.md (built-in adapters and ops, secret schemes, outputs: all from `createRegistry()`), the recipe
 * docs, the coverage tables, docs/providers.md, the README's providers-summary block (the provider catalog) and its
 * init-unsupported block (UNSUPPORTED), its plan and apply samples (real runs against the sim), and action/README.md's example comments (the PR comment snapshots). On failure,
 * run `pnpm docs:gen` and commit the result.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, type ErrorCodeSpec } from "@sponson/core";
import { createRegistry, detectableProviders, loadRecipes } from "@sponson/adapters";
import { generate, markers, REPO } from "../../scripts/gen-docs.js";
import { internalNames } from "../support.js";

describe("generated docs", async () => {
  const files = await generate();

  it.each(files.map((f) => [f.path, f.content] as const))("%s is up to date (run pnpm docs:gen)", async (path, expected) => {
    const actual = await readFile(join(REPO, path), "utf8").catch(() => "(missing)");
    // A plain boolean first, so the failure says what to do before the diff.
    expect(actual === expected, `${path} is out of date: run \`pnpm docs:gen\` and commit the result`).toBe(true);
  });

  it("README's plan and apply samples are the CLI's output for README's own plan, not prose", async () => {
    const readme = await readFile(join(REPO, "README.md"), "utf8");
    const block = (name: string) => readme.slice(readme.indexOf(markers(name).start), readme.indexOf(markers(name).end));
    expect(block("readme-plan")).toContain("$ sponson plan\nsponson plan · preview · pr-42 · plan ");
    expect(block("readme-plan")).toMatch(/^\? env +vercel\.env +pending +waiting on `db`$/m);
    expect(block("readme-plan")).toContain("(secret ← env://STRIPE_KEY)");
    expect(block("readme-apply")).toContain("apply partial: waiting on deploy for lines callback");
  });

  it("action/README.md shows every destroy case: the plain one and an edited resource deleted anyway", async () => {
    const action = await readFile(join(REPO, "action/README.md"), "utf8");
    const { start, end } = markers("comment-destroy-changed");
    expect(action.slice(action.indexOf(start), action.indexOf(end))).toMatch(/was changed outside Sponson since the last apply; deleted anyway/);
  });

  it("no error code's meaning or CLI hint names an internal field: people read them in text and PR comments", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES as Record<string, ErrorCodeSpec>)) {
      expect(internalNames(`${spec.doc} ${spec.cliHint ?? ""}`), code).toEqual([]);
    }
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

  it("docs/providers.md lists every recipe op and every provider op, with each detectable provider's signals; README links it", async () => {
    const doc = await readFile(join(REPO, "docs/providers.md"), "utf8");
    for (const r of loadRecipes()) for (const op of Object.keys(r.ops)) expect(doc).toContain(`[\`${r.provider}.${op}\`](recipes.md#`);
    const registry = createRegistry();
    for (const name of registry.adapterNames()) {
      if (name === "http") continue; // the generic adapter: every recipe op above is one of its lines
      for (const op of Object.keys(registry.adapter(name).ops)) expect(doc).toContain(`[\`${name}.${op}\`](plan-format.md#`);
    }
    for (const p of detectableProviders(registry)) expect(doc, p.id).toContain(`\`${(p.detect.deps ?? p.detect.files ?? p.detect.env ?? [])[0]?.replace(/\/$/, "/*")}\``);
    const readme = await readFile(join(REPO, "README.md"), "utf8");
    const { start, end } = markers("providers-summary");
    expect(readme.slice(readme.indexOf(start), readme.indexOf(end))).toContain("[docs/providers.md](docs/providers.md)");
  });
});
