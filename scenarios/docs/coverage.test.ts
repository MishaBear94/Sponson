/**
 * docs/coverage.yaml is the provider coverage matrix; docs/coverage.md shows it. This suite keeps the two, the
 * product and the tests in agreement:
 *
 *   - every `covered_by` names a registered op (`<adapter>.<op>`), a shipped recipe op (`recipe:<provider>.<op>`)
 *     or a built-in secret scheme (`secret:<scheme>`), and a recipe op covers exactly the rows that name it;
 *   - every op so named is exercised: an op by at least one scenario plan, a recipe op by scenarios/recipes.test.ts
 *     (which runs every recipe op), a secret scheme by at least one scenario;
 *   - every number docs/coverage.md states is the one the data gives (the tables and numbers are generated, so this
 *     also fails when `pnpm docs:gen` was not run).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createRegistry, loadRecipes } from "@sponson/adapters";
import { coverageNumbers, coverRefs, isCovered, isManualStep, loadCoverage, type CoverageRow } from "../../scripts/coverage-data.js";
import { REPO, scenarioPlans } from "./plans.js";

const data = await loadCoverage();
const registry = createRegistry();
const rows = data.categories.flatMap((c) => c.rows);
const recipes = loadRecipes();

/** `adapter.op` of every change of every scenario plan. */
async function scenarioOps(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of await scenarioPlans()) {
    const plan = parseYaml(p.source) as { changes?: Array<{ adapter?: string; op?: string }> } | null;
    for (const c of plan?.changes ?? []) if (c.adapter && c.op) out.add(`${c.adapter}.${c.op}`);
  }
  return out;
}

async function scenarioText(dir = join(REPO, "scenarios")): Promise<string> {
  let text = "";
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) text += await scenarioText(p);
    else if (/\.(ya?ml|ts)$/.test(e.name)) text += await readFile(p, "utf8");
  }
  return text;
}

function resolves(ref: string): boolean {
  if (ref.startsWith("recipe:")) {
    const [provider, op] = ref.slice("recipe:".length).split(".");
    return recipes.some((r) => r.provider === provider && op !== undefined && op in r.ops);
  }
  const [adapter, op] = ref.split(".");
  return registry.adapterNames().includes(adapter!) && op !== undefined && op in registry.adapter(adapter!).ops;
}

describe("docs/coverage.yaml", () => {
  it("has unique row ids, valid priorities, and a reason for every manual or uncounted row", () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) {
      if (r.counted !== false) expect(Object.keys(data.weights), r.id).toContain(r.priority);
      if (r.counted === false || r.covered_by === "manual") expect(r.why, `${r.id} needs a \`why\``).toBeTruthy();
      if (r.counted !== false) expect(r.covered_by === null || r.covered_by === "manual" || coverRefs(r).length > 0, `${r.id}: covered_by`).toBe(true);
    }
  });

  it.each(rows.flatMap((r) => coverRefs(r).map((ref) => [r.id, ref] as const)))("%s: `%s` is a registered op or a shipped recipe op", (_id, ref) => {
    expect(resolves(ref), `${ref} resolves`).toBe(true);
  });

  it("a recipe op's `covers` lists exactly the rows whose covered_by names it", () => {
    const named = new Map<string, string[]>();
    for (const r of rows) for (const ref of coverRefs(r)) if (ref.startsWith("recipe:")) named.set(ref, [...(named.get(ref) ?? []), r.id]);
    for (const recipe of recipes) {
      for (const [name, op] of Object.entries(recipe.ops)) {
        const ref = `recipe:${recipe.provider}.${name}`;
        expect([...op.covers].sort(), ref).toEqual((named.get(ref) ?? []).sort());
      }
    }
  });

  it("every op it names is exercised by a scenario, every recipe op by scenarios/recipes.test.ts", async () => {
    const ops = await scenarioOps();
    const harness = await readFile(join(REPO, "scenarios/recipes.test.ts"), "utf8");
    expect(harness, "the recipe harness runs every shipped recipe op").toContain("loadRecipes()");
    for (const ref of rows.flatMap(coverRefs)) {
      if (ref.startsWith("recipe:")) {
        const [provider, name] = ref.slice("recipe:".length).split(".") as [string, string];
        const op = recipes.find((r) => r.provider === provider)!.ops[name]!;
        // The harness runs the example line: every required param needs an example.
        for (const [p, spec] of Object.entries(op.params)) if (spec.required) expect(spec.example, `${ref}: param ${p} has an example`).toBeDefined();
      } else expect(ops.has(ref), `no scenario plan uses ${ref}`).toBe(true);
    }
  });

  it("every secret source it marks covered is a built-in scheme a scenario uses", async () => {
    const text = await scenarioText();
    for (const s of data.secret_sources) {
      if (s.covered_by === null) continue;
      const scheme = s.covered_by.replace(/^secret:/, "");
      expect(registry.secretSchemes(), s.id).toContain(scheme);
      expect(text.includes(`${scheme}://`), `no scenario uses ${scheme}://`).toBe(true);
    }
  });
});

describe("docs/coverage.md states the numbers the data gives", async () => {
  const doc = await readFile(join(REPO, "docs/coverage.md"), "utf8");
  const n = coverageNumbers(data);

  it("coverage of rows, weighted, P0 and reachable", () => {
    expect(doc).toContain(`| Rows | ${n.rows.covered} of ${n.rows.total} | **${n.rows.percent}%** |`);
    expect(doc).toContain(`| Weighted by priority | ${n.weighted.covered} of ${n.weighted.total} | **${n.weighted.percent}%** |`);
    expect(doc).toContain(`| P0 rows only | ${n.p0.covered} of ${n.p0.total} | ${n.p0.percent}% |`);
    expect(doc).toContain(`${n.reachableRows.covered} of ${n.reachableRows.total} | ${n.reachableRows.percent}% |`);
  });

  it("every row's coverage mark", () => {
    const covered = (r: CoverageRow) => isCovered(r) || isManualStep(r);
    for (const r of rows.filter((x) => x.counted !== false)) {
      const line = doc.split("\n").find((l) => l.startsWith(`| ${r.provider} | `) && l.includes(r.side_effect.slice(0, 20).replace(/\|/g, "\\|")));
      expect(line, `the table row of ${r.id}`).toBeDefined();
      expect(line!.endsWith("| no |") || line!.endsWith("| no (no API) |"), `${r.id}: ${line}`).toBe(!covered(r));
    }
  });
});
