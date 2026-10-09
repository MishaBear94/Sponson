/**
 * The GitHub Action's two github-script steps, extracted verbatim from action/action.yml and executed in node with
 * a mocked `github` / `context` / `core`, fed with real `--json` output from the CLI against the sim.
 *
 * Promises: action/README.md "The PR comment" (one comment per environment, marked `<!-- sponson:<env> -->`, a
 * table with one row per line), README "The action comments the plan and the receipt on the pull request",
 * secrets never appear (README "redacted from every byte of output"), and the example workflow in action/README.md.
 */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { World } from "./helpers.js";

const root = new URL("../../../", import.meta.url).pathname;
const requireFn = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
async function actionSteps(): Promise<Step[]> {
  const doc = parseYaml(await readFile(join(root, "action/action.yml"), "utf8")) as { runs: { steps: Step[] } };
  return doc.runs.steps;
}
async function script(id: string): Promise<string> {
  const s = (await actionSteps()).find((x) => x.id === id);
  if (!s?.with?.script) throw new Error(`no github-script step ${id}`);
  return s.with.script;
}

interface Comment {
  id: number;
  body: string;
}
function mockGithub(existing: Comment[], prsForCommit: Array<{ number: number; state: string; head: { ref: string } }> = []) {
  const calls: Array<{ op: string; args: any }> = [];
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: async (args: any) => (calls.push({ op: "listPRs", args }), { data: prsForCommit }) },
      issues: {
        listComments: async (args: any) => (calls.push({ op: "list", args }), { data: existing }),
        updateComment: async (args: any) => (calls.push({ op: "update", args }), { data: {} }),
        createComment: async (args: any) => (calls.push({ op: "create", args }), { data: {} }),
      },
    },
    paginate: async (fn: (a: any) => Promise<{ data: unknown[] }>, args: any) => (await fn(args)).data,
  };
  return { github, calls };
}

async function runScript(code: string, opts: { payload: any; env?: Record<string, string>; github: unknown }) {
  const outputs: Record<string, unknown> = {};
  const core = { setOutput: (k: string, v: unknown) => (outputs[k] = v), info() {}, warning() {}, setFailed(m: string) { throw new Error(m); } };
  const context = { payload: opts.payload, repo: { owner: "acme", repo: "app" }, eventName: opts.payload.pull_request ? "pull_request" : "deployment_status" };
  const keys = { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/app", GITHUB_RUN_ID: "1001", ...(opts.env ?? {}) };
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(keys)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await new AsyncFunction("github", "context", "core", "require", code)(opts.github, context, core, requireFn);
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return outputs;
}

/** Render the PR comment for a CLI JSON result exactly as the action would. */
async function renderComment(w: World, stdout: string, command: string, exit: number, existing: Comment[] = []) {
  const path = join(w.cwd, `result-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, stdout);
  const { github, calls } = mockGithub(existing);
  await runScript(await script("comment"), {
    payload: { pull_request: { number: 42 } },
    github,
    env: { RESULT_PATH: path, SPONSON_ENV: "preview", SPONSON_COMMAND: command, SPONSON_EXIT: String(exit), SPONSON_PR: "42" },
  });
  const write = calls.find((c) => c.op === "create" || c.op === "update")!;
  return { body: write.args.body as string, calls };
}

/** A GFM table survives only if each row is one physical line with exactly 6 unescaped pipes. */
function tableProblems(body: string): string[] {
  const problems: string[] = [];
  if (/\r/.test(body)) problems.push("body contains a bare CR (a line break in markdown)");
  const lines = body.split(/\r\n|\r|\n/);
  const start = lines.findIndex((l) => l.startsWith("| | line |"));
  if (start < 0) return problems;
  for (let i = start; i < lines.length && lines[i] !== ""; i++) {
    const l = lines[i]!;
    const pipes = (l.match(/(?<!\\)\|/g) ?? []).length;
    if (!l.startsWith("|") || pipes !== 6) problems.push(`row ${i - start}: ${JSON.stringify(l.slice(0, 120))}`);
  }
  // A table row is followed by a blank line or the end; a stray continuation means a row was split.
  return problems;
}

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

describe("PR comment rendering from real --json output", () => {
  it("control: plan / partial / failed+rollback / resumed / destroy / refused comments carry no secret, keep one marker, and form a valid table", async () => {
    const stripe = "fake_lv_prCommentCheck_4242";
    const w = await World.create(PLAN, { env: { STRIPE_KEY: stripe } });
    worlds.push(w);
    await w.sim.state.applyChaos({ deploy: "never" } as never);
    const bodies: Array<[string, string]> = [];
    const step = async (args: string, command: string) => {
      const r = await w.cli(args);
      const { body } = await renderComment(w, r.stdout, command, r.code);
      bodies.push([args, body]);
      return { r, body };
    };
    await step("plan --json", "plan");
    await w.sim.state.applyChaos({ fail_on: "POST /vercel/*", fail_next: 1, status: 500 } as never);
    const failed = await step("apply --json", "apply");
    expect(failed.r.json.receipt.status).toBe("failed");
    const partial = await step("apply --json", "apply");
    expect(partial.r.json.receipt.status).toBe("partial");
    expect(partial.body).toContain("waiting on deploy");
    await w.sim.state.applyChaos({ deploy: "ok" } as never);
    await step("plan --json", "plan");
    await step("apply --json", "apply");
    await step("apply --destroy --json", "destroy");
    const refused = await w.cli("apply --json", { envName: "production" });
    bodies.push(["refused", (await renderComment(w, refused.stdout, "apply", refused.code)).body]);
    expect(bodies.at(-1)![1]).toContain("`ENV_NOT_APPROVED`");

    const conns = w.sim.state.vercel.projects.prj_demo!.envs.map((e) => e.value);
    for (const [what, body] of bodies) {
      expect(body.startsWith("<!-- sponson:preview -->\n### Sponson "), what).toBe(true);
      expect(body.split("<!-- sponson:").length - 1, `${what}: one marker`).toBe(1);
      expect(body, what).not.toContain(stripe);
      expect(body, what).not.toMatch(/postgres(ql)?:\/\/[^\s|]*:[^\s|@]+@/);
      for (const c of conns) expect(body, what).not.toContain(c);
      expect(tableProblems(body), `${what}:\n${body}`).toEqual([]);
    }
  });

  it("control: upsert finds only this environment's marker at the start of a comment; creates one otherwise", async () => {
    const w = await World.create(PLAN, { env: { STRIPE_KEY: "fake_lv_x_upsert_000" } });
    worlds.push(w);
    const r = await w.cli("plan --json");
    const existing: Comment[] = [
      { id: 1, body: "Reviewer: the bot comment starts with `<!-- sponson:preview -->` and I quote it here" },
      { id: 2, body: "<!-- sponson:production -->\n### Sponson plan · production" },
      { id: 3, body: "<!-- sponson:preview -->\n### Sponson plan · preview (old)" },
    ];
    const up = await renderComment(w, r.stdout, "plan", r.code, existing);
    const upd = up.calls.filter((c) => c.op === "update");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.args.comment_id).toBe(3);
    expect(up.calls.some((c) => c.op === "create")).toBe(false);
    const fresh = await renderComment(w, r.stdout, "plan", r.code, existing.slice(0, 2));
    const cr = fresh.calls.find((c) => c.op === "create");
    expect(cr?.args.issue_number).toBe(42);
    // A crash (no JSON at all) still renders a titled comment.
    const crash = await renderComment(w, "", "apply", 1);
    expect(crash.body).toContain("apply crashed (exit 1)");
  });

  it("D15: a CRLF error message (multi-line stderr from a secret-source CLI) splits the comment's table row", async () => {
    const w = await World.create(`version: 1
providers:
  vercel: { project: prj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      SIGNING_KEY: { secret: "op://vault/item/field" }
  - id: other
    adapter: vercel
    op: env
    target: preview
    depends_on: [env]
    values: { MODE: "x" }
`);
    worlds.push(w);
    await w.fakeBin("op", `#!/bin/sh\nprintf '[ERROR] 2026/10/10 could not read secret\\r\\n[ERROR] "vault" isn'"'"'t a vault | check OP_SERVICE_ACCOUNT_TOKEN\\r\\n' >&2\nexit 1\n`);
    const r = await w.cli("apply --json");
    // v0.2: an unresolvable secret is a refusal (SECRET_UNRESOLVED), so the line is `blocked`, not `failed`.
    expect(r.json.receipt.lines.env.status).toBe("blocked");
    expect(r.json.receipt.lines.env.errorCode).toBe("SECRET_UNRESOLVED");
    const { body } = await renderComment(w, r.stdout, "apply", r.code);
    expect(tableProblems(body), body).toEqual([]);
  });

  it("D16: an HTML error page from a provider (truncated mid `<!--`) opens an HTML comment that swallows the rest of the PR comment", async () => {
    const page =
      `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad gateway</h1>` +
      `<p>${"The web server reported a bad gateway error. ".repeat(8)}</p>` +
      `<!-- cf-ray ${"8c2f1a9b7d3e4f50-".repeat(10)} --></body></html>`;
    const w = await World.create(PLAN, {
      env: { STRIPE_KEY: "fake_lv_html_case_0001" },
      rules: [{ method: "POST", path: /\/vercel\/v10\/projects\/[^/]+\/env$/, respond: () => ({ status: 502, body: page, type: "text/html" }) }],
    });
    worlds.push(w);
    const r = await w.cli("apply --json");
    expect(r.json.receipt.lines.env.status).toBe("failed");
    const { body } = await renderComment(w, r.stdout, "apply", r.code);
    const withoutMarker = body.replace(/^<!-- sponson:preview -->/, "");
    // Rendered as HTML, an unescaped `<!--` hides everything after it (later rows, the run link).
    expect(withoutMarker.includes("<!--") && !withoutMarker.slice(withoutMarker.indexOf("<!--")).includes("-->"), body).toBe(false);
    expect(withoutMarker, "raw HTML from a provider is injected into the PR comment").not.toMatch(/<(html|head|body|h1)\b/);
  });
});

describe("scope derivation (action.yml step `scope`)", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("control: pull_request uses the PR; deployment_status with a sha ref finds the open PR and its branch; without an open PR it skips", async () => {
    const code = await script("scope");
    const a = await runScript(code, { payload: { pull_request: { number: 7, head: { ref: "feat/a", sha } } }, github: mockGithub([]).github });
    expect(a).toEqual({ pr: 7, branch: "feat/a", sha });
    const prs = [
      { number: 5, state: "closed", head: { ref: "old" } },
      { number: 9, state: "open", head: { ref: "feat/b" } },
    ];
    const b = await runScript(code, { payload: { deployment: { sha, ref: sha }, deployment_status: { state: "success" } }, github: mockGithub([], prs).github });
    expect(b).toEqual({ pr: 9, branch: "feat/b", sha });
    const c = await runScript(code, { payload: { deployment: { sha, ref: "main" }, deployment_status: { state: "success" } }, github: mockGithub([], []).github });
    // v0.2: a deployment_status event with no OPEN PR for its commit is skipped (nothing to finish), with empty scope outputs.
    expect(c).toMatchObject({ skip: "true", pr: "", branch: "", sha: "" });
    expect(String(c.reason)).toMatch(/no open pull request/);
  });

  it("D17: a deployment whose commit belongs only to a merged/closed PR is attributed to that PR, so `apply` re-creates the scope `destroy` just removed", async () => {
    const code = await script("scope");
    // Squash-merge of PR 42 lands on main; Vercel deploys main; deployment_status fires for the merge commit.
    const prs = [{ number: 42, state: "closed", head: { ref: "feat/x" } }];
    const out = await runScript(code, { payload: { deployment: { sha, ref: "main", environment: "Production" }, deployment_status: { state: "success" } }, github: mockGithub([], prs).github });
    expect(out.pr, "closed PR picked as the scope of a deployment_status apply").toBe("");
  });

  it("D18: the documented workflow runs `destroy` without provider credentials, so closing a PR leaves every resource behind", async () => {
    const readme = await readFile(join(root, "action/README.md"), "utf8");
    const block = readme.match(/## Example workflow[\s\S]*?```yaml\n([\s\S]*?)```/)![1]!;
    const wf = parseYaml(block) as { jobs: Record<string, { steps: Step[]; env?: Record<string, string> }> };
    const job = Object.values(wf.jobs)[0]!;
    const destroy = job.steps.find((s) => s.uses?.includes("/action@") && s.with?.command === "destroy")!;
    expect(destroy).toBeTruthy();
    const env = { ...(job.env ?? {}), ...(destroy.env ?? {}) };

    // What that step actually does: the CLI with no provider tokens.
    const w = await World.create(PLAN, { env: { STRIPE_KEY: "fake_lv_d18_000000" } });
    worlds.push(w);
    await w.cli("apply --json");
    const stripped = Object.fromEntries(Object.entries(w.env).filter(([k]) => !["VERCEL_TOKEN", "NEON_API_KEY", "CLERK_SECRET_KEY", "STRIPE_KEY"].includes(k)));
    for (const k of ["VERCEL_TOKEN", "NEON_API_KEY", "CLERK_SECRET_KEY"]) if (env[k]) stripped[k] = w.env[k];
    const saved = { ...w.env };
    for (const k of Object.keys(w.env)) delete w.env[k];
    Object.assign(w.env, stripped);
    const d = await w.cli("apply --destroy --json");
    Object.assign(w.env, saved);
    expect(d.json?.receipt?.status, `destroy step env: ${JSON.stringify(Object.keys(env))}\n${d.stdout.slice(0, 600)}`).toBe("complete");
  });
});
