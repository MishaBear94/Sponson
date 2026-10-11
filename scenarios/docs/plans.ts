/**
 * Where the docs suites find plans: the example plans under examples/ and every plan embedded in a scenario
 * (`plan:` and `- plan:` steps). Not a test file.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const EXAMPLES_DIR = join(REPO, "examples");
export const SCHEMA_PATH = join(REPO, "schema/release.plan.schema.json");

async function walk(dir: string, accept: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p, accept)));
    else if (accept(entry.name)) out.push(p);
  }
  return out.sort();
}

export interface PlanSource {
  /** Repo-relative file, plus `#plan` or `#steps[i].plan` for plans embedded in a scenario. */
  name: string;
  source: string;
}

export async function examplePlans(): Promise<PlanSource[]> {
  const files = await walk(EXAMPLES_DIR, (n) => n.endsWith(".plan.yaml"));
  return Promise.all(files.map(async (f) => ({ name: relative(REPO, f), source: await readFile(f, "utf8") })));
}

export async function scenarioPlans(): Promise<PlanSource[]> {
  const out: PlanSource[] = [];
  for (const f of await walk(join(REPO, "scenarios"), (n) => n.endsWith(".yaml"))) {
    const doc = parseYaml(await readFile(f, "utf8")) as { plan?: unknown; steps?: Array<Record<string, unknown>> };
    const rel = relative(REPO, f);
    if (typeof doc.plan === "string") out.push({ name: `${rel}#plan`, source: doc.plan });
    (doc.steps ?? []).forEach((s, i) => {
      if (typeof s.plan === "string") out.push({ name: `${rel}#steps[${i}].plan`, source: s.plan });
    });
  }
  return out;
}

/** The `bash` blocks of README.md's "Try it in 60 seconds" section, as lists of non-empty lines. */
export function tryItBlocks(readme: string): { start: string[]; steps: string[] } {
  const at = readme.search(/\n#{2,3} Try it in 60 seconds\n/);
  if (at < 0) throw new Error('README.md has no "Try it in 60 seconds" section');
  // From the heading to the next `##` or `###` heading.
  const body = readme.slice(readme.indexOf("\n", at + 1) + 1);
  const end = body.search(/^#{2,3} /m);
  const section = end < 0 ? body : body.slice(0, end);
  const blocks = [...section.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]!.split("\n").filter((l) => l.trim() !== ""));
  if (blocks.length !== 2) throw new Error(`expected two bash blocks in "Try it in 60 seconds", found ${String(blocks.length)}`);
  return { start: blocks[0]!, steps: blocks[1]! };
}
