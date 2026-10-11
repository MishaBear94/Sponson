/**
 * README.md's terminal samples, from real runs: the plan README shows (its `# release.plan.yaml` block) is planned and
 * applied by the CLI against the fake cloud (`@sponson/sim`), and what the CLI prints is the sample. So a change to
 * the plan output (a status, a label, a column) changes the README with it, and a sample cannot show output the CLI
 * no longer prints. scenarios/docs/errors.test.ts fails when README.md is not what this produces.
 *
 * What changes from run to run is pinned: the context (branch, commit, pull request), and the run id, which is random.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSim, simEnv } from "../packages/sim/src/index.js";
import { run } from "../packages/cli/src/main.js";

/** The context every sample runs in: the README's pull request 42 on a feature branch. */
const CTX = ["--branch", "feat/checkout", "--sha", "0123456789abcdef0123456789abcdef01234567", "--pr", "42", "--receipts", "local"];

/** The placeholder project ids of the README's plan, as the sim seeds them. */
const SIM_IDS: Array<[RegExp, string]> = [
  [/\bprj_xxx\b/g, "prj_demo"],
  [/\bproj_xxx\b/g, "proj_demo"],
];

/** The README's plan: its first `yaml` block that starts with `# release.plan.yaml`. */
export function readmePlan(readme: string): string {
  const m = /^```yaml\n# release\.plan\.yaml\n([\s\S]*?)^```$/m.exec(readme);
  if (!m) throw new Error("README.md has no ```yaml block starting with `# release.plan.yaml`");
  return m[1]!;
}

export interface Samples {
  /** `sponson plan` on the README's plan, nothing applied yet. */
  plan: string;
  /** The first `sponson apply`, while the preview deploy has not finished: partial. */
  apply: string;
}

/** Run the README's plan against a fresh sim and return what `plan` and the first `apply` print. */
export async function readmeSamples(readme: string): Promise<Samples> {
  const plan = SIM_IDS.reduce((text, [from, to]) => text.replace(from, to), readmePlan(readme));
  const sim = await startSim();
  const dir = await mkdtemp(join(tmpdir(), "sponson-readme-"));
  try {
    await writeFile(join(dir, "release.plan.yaml"), plan);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", ...simEnv(sim), STRIPE_KEY: "sk_test_readme_sample_0000" };
    const cli = async (...args: string[]): Promise<string> => {
      let out = "";
      await run([...args, ...CTX], { stdout: { write: (s: string) => void (out += s) }, stderr: { write: () => {} }, env, cwd: dir, color: false });
      return [`$ sponson ${args.join(" ")}`, out.trimEnd().replace(/\brun-[0-9a-f]{8}\b/g, "run-1a2b3c4d")].join("\n");
    };
    await sim.state.applyChaos({ deploy: "never" } as never);
    return { plan: await cli("plan"), apply: await cli("apply") };
  } finally {
    await sim.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A sample as the README shows it: a plain fenced block. */
export function sampleBlock(text: string): string {
  return ["```", text, "```"].join("\n");
}
