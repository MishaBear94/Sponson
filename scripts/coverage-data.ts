/**
 * docs/coverage.yaml, the provider coverage matrix, read and counted. scripts/gen-docs.ts renders its tables and
 * numbers into docs/coverage.md; scenarios/docs/coverage.test.ts checks that every `covered_by` resolves to a
 * registered op, a shipped recipe op or a secret scheme, and is exercised by a test.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const COVERAGE_DATA = "docs/coverage.yaml";

export type Priority = "P0" | "P1" | "P2";

export interface CoverageRow {
  id: string;
  provider: string;
  side_effect: string;
  api_shape: string;
  generic: string;
  priority: Priority;
  /** `<adapter>.<op>`, `recipe:<provider>.<op>`, a list of those, `manual`, or null. Absent when not counted. */
  covered_by?: string | string[] | null;
  counted?: boolean;
  why?: string;
  note?: string;
}

export interface CoverageCategory {
  id: string;
  title: string;
  rows: CoverageRow[];
}

export interface SecretSourceRow {
  id: string;
  provider: string;
  read_api: string;
  priority: Priority;
  covered_by: string | null;
  issue?: string;
}

export interface CoverageData {
  weights: Record<Priority, number>;
  categories: CoverageCategory[];
  secret_sources: SecretSourceRow[];
}

export async function loadCoverage(): Promise<CoverageData> {
  return parse(await readFile(join(REPO, COVERAGE_DATA), "utf8")) as CoverageData;
}

/** The references of a row's `covered_by`: op names, `recipe:` names; `manual` and null give none. */
export function coverRefs(row: { covered_by?: string | string[] | null }): string[] {
  const c = row.covered_by;
  if (c === undefined || c === null || c === "manual") return [];
  return Array.isArray(c) ? c : [c];
}

export function isCovered(row: CoverageRow): boolean {
  return coverRefs(row).length > 0;
}

/** One measure: covered of total, and the percentage with one decimal. */
export interface Measure {
  covered: number;
  total: number;
  percent: string;
}

function measure(covered: number, total: number): Measure {
  return { covered, total, percent: total === 0 ? "0.0" : ((covered / total) * 100).toFixed(1) };
}

export interface CoverageNumbers {
  rows: Measure;
  weighted: Measure;
  p0: Measure;
  /** Rows some API reaches (everything but `manual`): the ceiling of what Sponson can cover. */
  reachableRows: Measure;
  reachableWeighted: Measure;
  /** Counted rows by priority. */
  byPriority: Record<Priority, number>;
  manual: CoverageRow[];
  /** Rows the generic adapter can express fully (`generic: Y`) that nothing covers yet: recipe candidates. */
  recipeCandidates: CoverageRow[];
  secretVendors: Measure;
  secretWeighted: Measure;
}

export function coverageNumbers(d: CoverageData): CoverageNumbers {
  const rows = d.categories.flatMap((c) => c.rows).filter((r) => r.counted !== false);
  const w = (r: { priority: Priority }) => d.weights[r.priority];
  const sum = (list: CoverageRow[]) => list.reduce((a, r) => a + w(r), 0);
  const covered = rows.filter(isCovered);
  const manual = rows.filter((r) => r.covered_by === "manual");
  const reachable = rows.filter((r) => r.covered_by !== "manual");
  const p0 = rows.filter((r) => r.priority === "P0");
  const secrets = d.secret_sources;
  const secretsCovered = secrets.filter((s) => s.covered_by !== null);
  return {
    rows: measure(covered.length, rows.length),
    weighted: measure(sum(covered), sum(rows)),
    p0: measure(p0.filter(isCovered).length, p0.length),
    reachableRows: measure(covered.length, reachable.length),
    reachableWeighted: measure(sum(covered), sum(reachable)),
    byPriority: { P0: p0.length, P1: rows.filter((r) => r.priority === "P1").length, P2: rows.filter((r) => r.priority === "P2").length },
    manual,
    recipeCandidates: rows.filter((r) => !isCovered(r) && r.covered_by !== "manual" && /^Y\b/.test(r.generic)),
    secretVendors: measure(secretsCovered.length, secrets.length),
    secretWeighted: measure(secretsCovered.reduce((a, s) => a + w(s), 0), secrets.reduce((a, s) => a + w(s), 0)),
  };
}
