/**
 * Lists that restate the code drift: adding a secret source once meant hand-editing eleven places. The built-in
 * adapters, ops and secret schemes are therefore enumerated in exactly one place, the blocks scripts/gen-docs.ts
 * generates into docs/plan-format.md; every other doc links there and gives at most one example. Hand-maintained
 * counts of things in the repo ("54 YAML scenarios", "eight invariants") drift the same way and are not written at
 * all. This suite fails when either comes back.
 *
 * Architecture decision records (docs/adr/) are exempt: they record what was true when they were written.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createRegistry } from "@sponson/adapters";
import { REPO } from "./plans.js";

/** Every doc a contributor or user reads as current, plus the schema and package descriptions. */
async function docs(): Promise<Array<{ path: string; text: string }>> {
  const paths = ["README.md", "CONTRIBUTING.md", "SKILL.md", "ARCHITECTURE.md", "docs/plan-format.md", "docs/errors.md", "schema/release.plan.schema.json"];
  for (const pkg of await readdir(join(REPO, "packages"))) paths.push(`packages/${pkg}/README.md`);
  const out: Array<{ path: string; text: string }> = [];
  for (const path of paths) {
    const text = await readFile(join(REPO, path), "utf8").catch(() => null);
    if (text !== null) out.push({ path, text });
  }
  for (const pkg of await readdir(join(REPO, "packages"))) {
    const json = await readFile(join(REPO, "packages", pkg, "package.json"), "utf8").catch(() => null);
    if (json !== null) out.push({ path: `packages/${pkg}/package.json (description)`, text: String((JSON.parse(json) as { description?: string }).description ?? "") });
  }
  return out;
}

/** Remove the generated blocks: they are the one place allowed to enumerate. */
function withoutGenerated(text: string): string {
  return text.replace(/<!-- generated:([a-z-]+):start[\s\S]*?<!-- generated:\1:end -->/g, "");
}

/** The secret schemes mentioned as a reference (`aws-sm://`). Bare names are not counted: `op` is also a plan key. */
function schemesMentioned(text: string, schemes: string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return schemes.filter((s) => new RegExp(`(?<![\\w-])${esc(s)}://`).test(text));
}

const NUMBER = "\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const COUNTED = "(?:YAML )?scenarios|categories|adapters|secret sources|secret schemes|schemes|invariants|dimensions|journeys|ops|error codes|states|forms|places";
/** "eight invariants", "six independent dimensions", "54 YAML scenarios". */
const HAND_COUNT = new RegExp(`\\b(?:${NUMBER})\\s+(?:[a-z-]+\\s+)?(?:${COUNTED})\\b`, "gi");

const files = await docs();
const schemes = createRegistry().secretSchemes();

describe.each(files.map((f) => [f.path, f.text] as const))("%s", (_path, text) => {
  const prose = withoutGenerated(text);

  it("names at most one built-in secret scheme (link to docs/plan-format.md#secret-schemes instead)", () => {
    expect(schemesMentioned(prose, schemes).length, `mentions ${schemesMentioned(prose, schemes).join(", ")}`).toBeLessThanOrEqual(1);
  });

  it("has no hand-maintained count of repo contents", () => {
    expect(prose.match(HAND_COUNT) ?? []).toEqual([]);
  });
});

it("the guard sees every doc it is meant to", () => {
  expect(files.map((f) => relative(REPO, join(REPO, f.path)))).toEqual(expect.arrayContaining(["README.md", "SKILL.md", "ARCHITECTURE.md", "docs/plan-format.md"]));
});
