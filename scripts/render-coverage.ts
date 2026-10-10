/**
 * The generated blocks of docs/coverage.md, from docs/coverage.yaml: the matrix tables (`coverage-matrix`), the
 * secret sources (`coverage-secrets`) and every number of "Current coverage" (`coverage-numbers`). Called by
 * scripts/gen-docs.ts.
 */
import { coverageNumbers, coverRefs, isCovered, isManualStep, type CoverageData, type CoverageRow, type Measure } from "./coverage-data.js";
import { cell } from "./md.js";
import { recipeLink } from "./render-recipes.js";

/** One `covered_by` reference as the docs show it: an op in code, a recipe op linked to docs/recipes.md. */
function refText(ref: string): string {
  if (!ref.startsWith("recipe:")) return `\`${ref}\``;
  const [provider, op] = ref.slice("recipe:".length).split(".") as [string, string];
  return `recipe ${recipeLink(provider, op)}`;
}

function nowCell(row: CoverageRow): string {
  if (row.counted === false) return "n/a";
  if (row.covered_by === "manual") return "no (no API)";
  if (isManualStep(row)) return "manual step (`manual.step`)";
  const refs = coverRefs(row);
  if (refs.length === 0) return "no";
  return `**yes** (${refs.map(refText).join(", ")}${row.note ? `: ${row.note}` : ""})`;
}

export function renderMatrix(d: CoverageData): string {
  const out: string[] = [];
  for (const c of d.categories) {
    out.push(`### ${c.title}`, "", "| Provider | Side effect | API shape | Generic? | Pri | Now |", "|---|---|---|---|---|---|");
    for (const r of c.rows) out.push(`| ${cell(r.provider)} | ${cell(r.side_effect)} | ${cell(r.api_shape)} | ${cell(r.generic)} | ${cell(r.priority)} | ${nowCell(r)} |`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export function renderSecretSources(d: CoverageData): string {
  const out = ["| Provider | Read API | Pri | Now |", "|---|---|---|---|"];
  for (const s of d.secret_sources) {
    const now = s.covered_by ? `**yes** (\`${s.covered_by.slice("secret:".length)}://\`)` : s.issue ? `no ([#${s.issue.split("/").pop()}](${s.issue}))` : "no";
    out.push(`| ${cell(s.provider)} | ${cell(s.read_api)} | ${s.priority} | ${now} |`);
  }
  return out.join("\n");
}

const pct = (m: Measure) => `**${m.percent}%**`;

export function renderNumbers(d: CoverageData): string {
  const n = coverageNumbers(d);
  const covered = d.categories.flatMap((c) => c.rows).filter((r) => r.counted !== false && isCovered(r));
  const manualWeight = n.weighted.total - n.reachableWeighted.total;
  return [
    `Counted over the ${n.rows.total} side-effect rows of the matrix (rows marked \`n/a\` have nothing to manage). Weights: P0 = ${d.weights.P0}, P1 = ${d.weights.P1}, P2 = ${d.weights.P2} (${n.byPriority.P0} P0, ${n.byPriority.P1} P1, ${n.byPriority.P2} P2; total weight ${n.weighted.total}).`,
    "",
    "| Measure | Covered | Coverage |",
    "|---|---|---|",
    `| Rows | ${n.rows.covered} of ${n.rows.total} | ${pct(n.rows)} |`,
    `| Weighted by priority | ${n.weighted.covered} of ${n.weighted.total} | ${pct(n.weighted)} |`,
    `| P0 rows only | ${n.p0.covered} of ${n.p0.total} | ${n.p0.percent}% |`,
    `| Rows an API reaches (all but \`manual\`) | ${n.reachableRows.covered} of ${n.reachableRows.total} | ${n.reachableRows.percent}% |`,
    `| Weighted, rows an API reaches | ${n.reachableWeighted.covered} of ${n.reachableWeighted.total} | ${n.reachableWeighted.percent}% |`,
    ...(n.manualSteps.length
      ? [
          `| Rows, including manual steps (\`manual.step\`) | ${n.withManualRows.covered} of ${n.withManualRows.total} | ${n.withManualRows.percent}% |`,
          `| Weighted, including manual steps | ${n.withManualWeighted.covered} of ${n.withManualWeighted.total} | ${n.withManualWeighted.percent}% |`,
        ]
      : []),
    `| Secret sources (separate) | ${n.secretVendors.covered} of ${n.secretVendors.total} vendors; weighted ${n.secretWeighted.covered} of ${n.secretWeighted.total} | ${n.secretVendors.percent}%; ${n.secretWeighted.percent}% |`,
    "",
    `Covered: ${covered.map((r) => `${r.provider} (${coverRefs(r).map(refText).join(", ")})`).join("; ")}.`,
    "",
    `Automated coverage counts only rows an op manages without a person. Rows no API reaches (\`manual\`, or a \`manual.step\` line that records the step a person does; weight ${manualWeight}): ${n.manual.map((r) => `${r.provider} (${r.why ?? "no API"})`).join("; ")}. They cap coverage at ${n.reachableRows.total} rows, ${n.reachableWeighted.total} of ${n.weighted.total} weighted (${((n.reachableWeighted.total / n.weighted.total) * 100).toFixed(1)}%).`,
    "",
    `Recipe candidates, rows the generic adapter can express fully (\`Y\`) that nothing covers yet: ${n.recipeCandidates.length} (${n.recipeCandidates.map((r) => r.provider).join(", ")}).`,
  ].join("\n");
}
