/**
 * Every plan in examples/ must parse with the real parser and plan cleanly against the fake cloud, in every
 * environment it declares: exit 0, no line in `error` or `blocked`. The sim is seeded with the projects each
 * example names, plus the live resources an adopting example expects to exist (SEEDS).
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePlan, secretRefs, type Plan } from "@sponson/core";
import { startSim, type SimHandle, type SimSeed } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type Workspace } from "../support.js";
import { EXAMPLES_DIR, examplePlans } from "./plans.js";

/** Live state an example needs beyond empty projects, by file name. */
const SEEDS: Record<string, (plan: Plan) => Partial<SimSeed>> = {
  "adopting-an-existing-project.plan.yaml": (plan) => ({
    vercel: {
      projects: {
        [project(plan, "vercel")]: {
          envs: [
            { key: "SENTRY_DSN", value: "https://abc@o1.ingest.sentry.io/1", target: "preview" },
            { key: "NEXT_PUBLIC_POSTHOG_KEY", value: "phc_example", target: "preview" },
            { key: "DATABASE_URL", value: "postgres://app:pw@db.acme.dev/app", target: "production" },
          ],
        },
      },
    },
    neon: { projects: { [project(plan, "neon")]: { branches: [{ name: "main" }, { name: "staging", parent: "main" }] } } },
  }),
};

function project(plan: Plan, adapter: string): string {
  return String(plan.providers[adapter]?.project ?? "");
}

/** Empty projects for every provider block the plan names, then the example's own seed on top. */
function seedFor(file: string, plan: Plan): Partial<SimSeed> {
  const seed: Partial<SimSeed> = {};
  if (plan.providers.vercel) seed.vercel = { projects: { [project(plan, "vercel")]: { envs: [] } } };
  if (plan.providers.neon) seed.neon = { projects: { [project(plan, "neon")]: { branches: [{ name: "main" }] } } };
  if (plan.providers.netlify) seed.netlify = { sites: { [String(plan.providers.netlify.site)]: { name: "acme-web", account: "acme" } } };
  return { ...seed, ...(SEEDS[file]?.(plan) ?? {}) };
}

/** A value for every `env://NAME` the plan references, so secrets resolve the way they would in CI. */
function secretEnv(plan: Plan): Record<string, string> {
  const env: Record<string, string> = {};
  for (const c of plan.changes) {
    for (const ref of secretRefs(c.params)) {
      const name = /^env:\/\/(.+)$/.exec(ref)?.[1];
      if (!name) throw new Error(`examples use env:// secrets only, so this suite can resolve them (got ${ref})`);
      env[name] = `example-value-for-${name}`;
    }
  }
  return env;
}

const examples = await examplePlans();

let sim: SimHandle;
let ws: Workspace;
beforeAll(async () => {
  sim = await startSim();
  ws = await workspace("examples");
});
afterAll(async () => {
  await sim?.close();
  await ws?.cleanup();
});

describe.each(examples.map((e) => [e.name.split("/").pop()!, e.source] as const))("examples/%s", (file, source) => {
  it("parses with the real parser, without warnings", () => {
    const { plan, warnings } = parsePlan(source, file);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  it("plans cleanly against the sim in every environment it declares", async () => {
    const { plan } = parsePlan(source, file);
    sim.state.reset(seedFor(file, plan));
    for (const env of plan.environments) {
      const r = await runCli(
        ["plan", "--json", "--plan", join(EXAMPLES_DIR, file), "--env", env, "--pr", "42", "--branch", "feat/checkout", "--sha", SHA, "--receipts", "local", "--receipts-dir", join(ws.dir, file)],
        { env: cliEnv(sim, secretEnv(plan)), cwd: ws.dir },
      );
      const bad = (r.json?.lines ?? []).filter((l: { status: string }) => l.status === "error" || l.status === "blocked");
      expect({ env, code: r.code, ok: r.json?.ok, bad, error: r.json?.error }).toEqual({ env, code: 0, ok: true, bad: [], error: undefined });
      expect(sim.state.writes).toEqual([]);
    }
  });
});
