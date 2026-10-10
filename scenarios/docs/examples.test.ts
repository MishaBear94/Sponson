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
  // The generic REST sim serves any path once it is known: the example's collections (empty) and parents.
  "http-flags-webhooks-allowlists.plan.yaml": () => ({
    rest: {
      collections: { "/gates": [], "/webhook_endpoints": [] },
      objects: { "/clients/aBcD1234eFgH5678": { web_origins: ["https://acme.dev"] }, "/projects/abcdefghijklmnopqrst/config/auth": { uri_allow_list: "https://acme.dev/**" } },
    },
  }),
};

/**
 * For every `providers.http` API: its base URL override pointed at the sim's generic REST provider, and a
 * placeholder for each credential variable it names.
 */
function httpEnv(plan: Plan, sim: SimHandle): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [api, raw] of Object.entries(plan.providers.http ?? {})) {
    const block = raw as { base_url_env?: string; auth?: Record<string, unknown> };
    if (!block.base_url_env) throw new Error(`examples: providers.http.${api} needs base_url_env, so this suite can point it at the sim`);
    env[block.base_url_env] = `${sim.url}/rest`;
    const auth = block.auth ?? {};
    const basic = (auth.basic ?? {}) as Record<string, unknown>;
    for (const name of [auth.bearer_env, auth.value_env, basic.user_env, basic.password_env]) if (typeof name === "string") env[name] = `example-credential-for-${name}`;
  }
  return env;
}

function project(plan: Plan, adapter: string): string {
  return String(plan.providers[adapter]?.project ?? "");
}

/** Empty projects for every provider block the plan names, then the example's own seed on top. */
function seedFor(file: string, plan: Plan): Partial<SimSeed> {
  const seed: Partial<SimSeed> = {};
  if (plan.providers.vercel) seed.vercel = { projects: { [project(plan, "vercel")]: { envs: [] } } };
  if (plan.providers.neon) seed.neon = { projects: { [project(plan, "neon")]: { branches: [{ name: "main" }] } } };
  if (plan.providers.launchdarkly) seed.launchdarkly = { projects: { [project(plan, "launchdarkly")]: launchdarklyProject(plan) } };
  return { ...seed, ...(SEEDS[file]?.(plan) ?? {}) };
}

/**
 * The LaunchDarkly project an example's lines target: its environment, and each flag a line names, with on/off
 * variations plus the names an example asks for (`variation: Treatment`).
 */
function launchdarklyProject(plan: Plan) {
  const lines = plan.changes.filter((c) => c.adapter === "launchdarkly");
  const flags = Object.fromEntries(
    lines.map((c) => {
      const named = typeof c.params.variation === "string" ? [{ value: c.params.variation.toLowerCase(), name: c.params.variation }] : [];
      return [String(c.params.flag), { variations: [{ value: true, name: "on" }, { value: false, name: "off" }, ...named] }];
    }),
  );
  return { environments: [String(plan.providers.launchdarkly?.environment)], flags };
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
        { env: cliEnv(sim, { ...secretEnv(plan), ...httpEnv(plan, sim) }), cwd: ws.dir },
      );
      const bad = (r.json?.lines ?? []).filter((l: { status: string }) => l.status === "error" || l.status === "blocked");
      expect({ env, code: r.code, ok: r.json?.ok, bad, error: r.json?.error }).toEqual({ env, code: 0, ok: true, bad: [], error: undefined });
      expect(sim.state.writes).toEqual([]);
    }
  });
});
