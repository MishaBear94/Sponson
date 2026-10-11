/**
 * The pull request comment, from real `--json` output against the sim: one snapshot per moment of a preview's life
 * (plan, partial apply, complete apply, a failure rolled back, drift refused, a manual step, a refused production
 * run, destroy with an adopted resource kept), rendered by `renderMarkdown` (packages/cli/src/markdown.ts), the
 * function `--format markdown` and the GitHub Action share.
 *
 * Promises: action/README.md "The PR comment" (headline, one human line per resource with console links, what waits
 * on what, refusals and drift in one sentence with the fix, cleaned up / kept / left for you on destroy), README
 * "redacted from every byte of output" (no secret, no connection string in any comment), and the size limit.
 * Snapshots live in __snapshots__/pr-comment/ as markdown: review them as a reviewer would read the comment.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_COMMENT_LIMIT, renderMarkdown } from "../../../packages/cli/src/markdown.js";
import type { SimSeed } from "@sponson/sim";
import { World } from "./helpers.js";

const STRIPE = "fake_lv_prComment_5150";

const PLAN = `version: 1
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    environments: [preview]
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
      STRIPE_KEY: { secret: "env://STRIPE_KEY" }
    environments: [preview]
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }
    environments: [preview]
`;

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});

async function world(plan = PLAN, seed?: Partial<SimSeed>): Promise<World> {
  const w = await World.create(plan, { env: { STRIPE_KEY: STRIPE }, ...(seed ? { seed } : {}) });
  worlds.push(w);
  return w;
}

/** Run ids and plan hashes change every run; nothing else in a comment from a fresh sim does. */
function stable(md: string): string {
  return md
    .replace(/\b(run|destroy)-[0-9a-f]{8}\b/g, "$1-RUNID")
    .replace(/\bplan [0-9a-f]{8}\b/g, "plan PLANHASH");
}

const comments: Array<[string, string]> = [];

async function snapshot(name: string, w: World, args: string, opts: { command?: string; envName?: string } = {}): Promise<{ md: string; json: any }> {
  const r = await w.cli(args, opts.envName ? { envName: opts.envName } : {});
  const md = renderMarkdown(r.json, { command: opts.command, runUrl: "https://github.com/acme/app/actions/runs/1001", ...(opts.envName ? { environment: opts.envName } : {}) });
  comments.push([name, md]);
  await expect(stable(md)).toMatchFileSnapshot(`__snapshots__/pr-comment/${name}.md`);
  // No secret, connection string or live variable value reaches a comment.
  expect(md, name).not.toContain(STRIPE);
  expect(md, name).not.toMatch(/postgres(ql)?:\/\/[^\s|]*:[^\s|@]+@/);
  for (const e of w.sim.state.vercel.projects.prj_demo?.envs ?? []) if (e.value.length >= 8) expect(md, `${name}: ${e.key}`).not.toContain(e.value);
  expect(md.startsWith("<!-- sponson:")).toBe(true);
  expect(md.split("<!-- sponson:").length - 1, `${name}: one marker`).toBe(1);
  return { md, json: r.json };
}

describe("the PR comment, from real --json output", () => {
  it("control: a preview's life: plan, partial, complete, destroy", async () => {
    const w = await world();
    await w.sim.state.applyChaos({ deploy: "never" } as never);
    const plan = await snapshot("plan", w, "plan --json", { command: "plan" });
    expect(plan.md).toContain("Applying this plan gives this preview its own database branch, 2 variables and 1 auth callback.");
    expect(plan.md).toContain("`DATABASE_URL` ← `db.connection_string`");

    const partial = await snapshot("apply-partial", w, "apply --json");
    expect(partial.json.receipt.status).toBe("partial");
    expect(partial.md).toContain("This preview has its own database branch and 2 variables.");
    expect(partial.md).toContain("Still to come: 1 auth callback, once the preview deploy finishes");
    expect(partial.md).toContain("waits for the preview deploy");
    expect(partial.md).toContain("[console](https://console.neon.tech/app/projects/proj_demo/branches/");

    await w.sim.state.applyChaos({ deploy: "ok" } as never);
    const done = await snapshot("apply-complete", w, "apply --json");
    expect(done.json.receipt.status).toBe("complete");
    expect(done.md).toContain("### Sponson: the preview for pr-42 is ready");
    expect(done.md).toContain("This preview has its own database branch, 2 variables and 1 auth callback.");
    expect(done.md).toMatch(/\*\*Preview:\*\* \[https:\/\/prj\\_demo-[0-9a-f]+\.vercel\.app\]\(https:\/\/prj_demo-[0-9a-f]+\.vercel\.app\)/);
    expect(done.md).toContain("values not shown");

    const destroy = await snapshot("destroy", w, "apply --destroy --json", { command: "destroy" });
    expect(destroy.md).toContain("### Sponson cleaned up the preview for pr-42");
    expect(destroy.md).toMatch(/\*\*Cleaned up:\*\* .*Neon branch sponson\/preview\/pr-42/);
    expect(destroy.md).toContain("**Kept (adopted, never destroyed):** nothing.");
    expect(destroy.md).toContain("**Left for you:** nothing.");
  });

  it("control: a failure is rolled back, and the comment says which line failed, why, and that nothing is left", async () => {
    const w = await world();
    await w.sim.state.applyChaos({ fail_on: "POST /vercel/*", fail_next: 1, status: 500 } as never);
    const failed = await snapshot("apply-failed-rollback", w, "apply --json");
    expect(failed.json.receipt.status).toBe("failed");
    expect(failed.json.receipt.lines.db.status).toBe("rolled_back");
    expect(failed.md).toContain("### Sponson could not apply the preview for pr-42");
    expect(failed.md).toContain("What this run created was rolled back.");
    expect(failed.md).toMatch(/`env` .* failed: .*\(`PROVIDER_[A-Z]+`\) \*\*Fix:\*\*/);
    expect(failed.md).toContain("`db` database branch — rolled back");
  });

  it("control: drift is explained in one sentence with the fix (`--reconcile`)", async () => {
    const w = await world();
    await w.cli("apply --json");
    await w.sim.state.applyChaos({ drift: { "vercel.env.preview.DATABASE_URL": "postgresql://console:edited@host/db" } } as never);
    await w.writePlan(PLAN.replace("STRIPE_KEY: { secret: \"env://STRIPE_KEY\" }", "STRIPE_KEY: { secret: \"env://STRIPE_KEY\" }\n      MODE: preview"));
    const drift = await snapshot("apply-drift", w, "apply --json");
    expect(drift.json.receipt.lines.env.errorCode).toBe("DRIFT_CHANGED");
    expect(drift.md).toContain("refused:");
    expect(drift.md).toContain("`sponson apply --reconcile`");
    expect(drift.md).not.toContain("console:edited");
  });

  it("control: a manual step shows its instructions whole and how a person confirms it", async () => {
    const plan = `version: 1
providers:
  vercel: { project: prj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    target: preview
    values: { MODE: preview }
  - id: google-redirect
    adapter: manual
    op: step
    title: "Allow the callback on the Google OAuth client"
    vars: { url: { from: env.preview_url } }
    instructions: |
      1. Open the client "acme-web".
      2. Add {url}/cb to its authorized redirect URIs and save.
`;
    const w = await world(plan);
    const manual = await snapshot("apply-manual-step", w, "apply --json");
    expect(manual.json.error.code).toBe("MANUAL_STEP_PENDING");
    expect(manual.md).toContain("### Sponson: the preview for pr-42 waits for a person");
    expect(manual.md).toContain('<pre>1. Open the client "acme-web".');
    expect(manual.md).toContain("`sponson apply --confirm google-redirect`");
  });

  it("control: a refused production run says why and how to approve it, and that nothing was written", async () => {
    const w = await world();
    const refused = await snapshot("apply-refused-production", w, "apply --json", { envName: "production" });
    expect(refused.json.error.code).toBe("ENV_NOT_APPROVED");
    expect(refused.md).toContain("### Sponson apply refused: `ENV_NOT_APPROVED`");
    expect(refused.md).toContain("`--approved-by <who>`");
    expect(refused.md).toContain("Nothing was written.");
    expect(refused.md.startsWith("<!-- sponson:production -->")).toBe(true);
  });

  it("control: destroy lists what it cleaned up and what it kept because it was adopted", async () => {
    const w = await world(PLAN, {
      vercel: { projects: { prj_demo: { envs: [{ key: "DATABASE_URL", value: "old-value-adopted", target: "preview", gitBranch: "feat/x" }] } } },
      neon: { projects: { proj_demo: { branches: [{ name: "main" }, { name: "sponson/preview/pr-42", parent: "main" }] } } },
    } as never);
    await w.sim.state.applyChaos({ deploy: "ok" } as never);
    await w.cli("apply --json");
    const destroy = await snapshot("destroy-adopted-kept", w, "apply --destroy --json", { command: "destroy" });
    expect(destroy.md).toMatch(/\*\*Kept \(adopted, never destroyed\):\*\* .*Neon branch sponson\/preview\/pr-42/);
    expect(destroy.md).toMatch(/\*\*Cleaned up:\*\* .*STRIPE\\_KEY \(preview, feat\/x\)/);
  });

  it("control: `--format markdown` on plan and apply prints the same comment, also for a refusal; it is a flag, not a command", async () => {
    const w = await world();
    await w.sim.state.applyChaos({ deploy: "ok" } as never);
    const json = await w.cli("plan --json");
    const md = await w.cli("plan --format markdown");
    expect(md.code).toBe(0);
    expect(md.stdout).toBe(renderMarkdown(json.json, { environment: "preview", command: "plan", runUrl: undefined }));
    const applied = await w.cli("apply --format markdown");
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("### Sponson: the preview for pr-42 is ready");
    expect(applied.stdout).not.toContain(STRIPE);
    const destroy = await w.cli("apply --destroy --format=markdown");
    expect(destroy.stdout).toContain("### Sponson cleaned up the preview for pr-42");

    const refused = await w.cli("apply --format markdown", { envName: "production" });
    expect(refused.code).toBe(2);
    expect(refused.stdout.startsWith("<!-- sponson:production -->\n### Sponson apply refused: `ENV_NOT_APPROVED`")).toBe(true);
    expect(refused.stderr).toContain("ENV_NOT_APPROVED");

    const both = await w.cli("plan --json --format markdown");
    expect(both.code).toBe(2);
    expect(both.json.error.code).toBe("USAGE");
    expect(JSON.parse((await w.cli("plan --format json")).stdout).command).toBe("plan");
    const init = await w.cli("init --format markdown");
    expect(init.code).toBe(2);
    expect(init.stderr).toContain("--format markdown is for plan and apply");
  });

  it("control: a comment longer than GitHub allows keeps its title and headline and says what it left out", async () => {
    const w = await world();
    await w.sim.state.applyChaos({ deploy: "ok" } as never);
    const r = await w.cli("apply --json");
    const big = structuredClone(r.json);
    const env = big.receipt.lines.env;
    for (let i = 0; i < 4000; i++) big.receipt.lines[`env${i}`] = { ...env, id: `env${i}`, resources: env.resources.map((x: any) => ({ ...x, label: `${x.label} ${"x".repeat(20)}` })) };
    big.warnings = Array.from({ length: 50 }, (_, i) => `warning ${i}`);
    const md = renderMarkdown(big, {});
    expect(md.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(md.startsWith("<!-- sponson:preview -->\n### Sponson: the preview for pr-42 is ready")).toBe(true);
    expect(md).toMatch(/This preview has its own database branch, \d+ variables and 1 auth callback\./);
    expect(md).toMatch(/more sections? left out: the comment would exceed GitHub's size limit/);
    const small = renderMarkdown(big, { maxLength: 2000 });
    expect(small.length).toBeLessThanOrEqual(2000);
    expect(small).toContain("### Sponson: the preview for pr-42 is ready");
  });
});
