 
/**
 * action/action.yml's github-script steps, extracted verbatim and run in node with mocked github / context / core
 * (the approach of scenarios/journeys/secrets/action-comment.test.ts), plus the documented workflow in action/README.md.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url).pathname;
const requireFn = createRequire(import.meta.url);
const execFileP = promisify(execFile);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
}

async function action(): Promise<{ steps: Step[]; outputs: Record<string, { value: string }> }> {
  const doc = parseYaml(await readFile(join(root, "action/action.yml"), "utf8")) as { runs: { steps: Step[] }; outputs: Record<string, { value: string }> };
  return { steps: doc.runs.steps, outputs: doc.outputs };
}

async function script(id: string): Promise<string> {
  const s = (await action()).steps.find((x) => x.id === id);
  if (!s?.with?.script) throw new Error(`no github-script step ${id}`);
  return s.with.script;
}

interface PR {
  number: number;
  state: string;
  head: { ref: string };
}

function mockGithub(prsForCommit: PR[] = [], existing: Array<{ id: number; body: string }> = []) {
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
  const notices: string[] = [];
  const core = { setOutput: (k: string, v: unknown) => (outputs[k] = v), info() {}, notice: (m: string) => notices.push(m), warning() {}, setFailed(m: string) { throw new Error(m); } };
  const context = { payload: opts.payload, repo: { owner: "acme", repo: "app" } };
  const keys = { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/app", GITHUB_RUN_ID: "1001", SPONSON_ENV: "preview", ...(opts.env ?? {}) };
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
  return { outputs, notices };
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

describe("scope step", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const deployment = (over: Record<string, unknown> = {}) => ({ deployment: { sha, ref: sha, environment: "Preview", ...over }, deployment_status: { state: "success" } });

  it("pull_request: the PR, its head branch and sha", async () => {
    const { outputs } = await runScript(await script("scope"), { payload: { pull_request: { number: 7, head: { ref: "feat/a", sha } } }, github: mockGithub().github });
    expect(outputs).toEqual({ pr: 7, branch: "feat/a", sha });
  });

  it("deployment_status: the open PR associated with the commit", async () => {
    const prs = [
      { number: 5, state: "closed", head: { ref: "old" } },
      { number: 9, state: "open", head: { ref: "feat/b" } },
    ];
    const { outputs } = await runScript(await script("scope"), { payload: deployment(), github: mockGithub(prs).github });
    expect(outputs).toEqual({ pr: 9, branch: "feat/b", sha });
    const byRef = await runScript(await script("scope"), { payload: deployment({ ref: "feat/b" }), github: mockGithub(prs).github });
    expect(byRef.outputs).toEqual({ pr: 9, branch: "feat/b", sha });
  });

  it.each([
    ["only a closed (merged) PR", [{ number: 42, state: "closed", head: { ref: "feat/x" } }]],
    ["no PR at all", []],
  ])("deployment_status with %s: skip, with empty scope outputs (never the closed PR)", async (_n, prs) => {
    const { outputs, notices } = await runScript(await script("scope"), { payload: deployment({ ref: "feat/x" }), github: mockGithub(prs).github });
    expect(outputs).toMatchObject({ skip: "true", pr: "", branch: "", sha: "" });
    expect(String(outputs.reason)).toMatch(/no open pull request/);
    expect(notices.join("\n")).toMatch(/skipped/);
  });

  it("a production deployment never drives a preview run, even with an open PR", async () => {
    const prs = [{ number: 9, state: "open", head: { ref: "feat/b" } }];
    for (const environment of ["Production", "production"]) {
      const { outputs } = await runScript(await script("scope"), { payload: deployment({ environment, ref: "main" }), github: mockGithub(prs).github });
      expect(outputs).toMatchObject({ skip: "true", pr: "" });
    }
  });

  it("push: no flags, so the CLI derives scope `main` from the GitHub context", async () => {
    const { outputs } = await runScript(await script("scope"), { payload: { ref: "refs/heads/main", after: sha }, github: mockGithub().github });
    expect(outputs).toEqual({ pr: "", branch: "", sha: "" });
  });

  it("every step after scope is a no-op when it skips", async () => {
    const { steps, outputs } = await action();
    const after = steps.slice(steps.findIndex((s) => s.id === "scope") + 1);
    const notice = after.find((s) => s.if === "steps.scope.outputs.skip == 'true'");
    expect(notice?.run).toContain("::notice");
    for (const s of after.filter((x) => x !== notice)) expect(s.if, `step ${s.id ?? s.run?.slice(0, 30)}`).toContain("steps.scope.outputs.skip != 'true'");
    expect(outputs.skipped?.value).toContain("steps.scope.outputs.skip");
  });
});

// ---------------------------------------------------------------------------
// comment
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * What the run step does after the CLI (render-comment.mjs, from source: node with the tsx loader and the renderer
 * in packages/cli/src), then the comment step on the file it wrote. Returns the body the action posts.
 */
async function comment(result: unknown, command = "apply", exit = 0, opts: { existing?: Array<{ id: number; body: string }>; module?: string; env?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sponson-action-"));
  const resultPath = join(dir, "result.json");
  const commentPath = join(dir, "comment.md");
  await writeFile(resultPath, result === null ? "" : JSON.stringify(result));
  const rendered = await execFileP(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "action/render-comment.mjs")], {
    env: {
      PATH: process.env.PATH,
      RESULT_PATH: resultPath,
      COMMENT_PATH: commentPath,
      SPONSON_MARKDOWN_MODULE: opts.module ?? join(root, "packages/cli/src/markdown.ts"),
      SPONSON_ENV: opts.env ?? "preview",
      SPONSON_COMMAND: command,
      SPONSON_EXIT: String(exit),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_RUN_ID: "1001",
    },
  }).then(
    () => true,
    () => false,
  );
  const { github, calls } = mockGithub([], opts.existing ?? []);
  await runScript(await script("comment"), { payload: { pull_request: { number: 42 } }, github, env: { COMMENT_PATH: commentPath, SPONSON_ENV: opts.env ?? "preview", SPONSON_COMMAND: command, SPONSON_EXIT: String(exit), SPONSON_PR: "42" } });
  const write = calls.find((c) => c.op === "create" || c.op === "update")!;
  return { body: write.args.body as string, calls, rendered };
}

const receipt = (lines: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  ok: true,
  command: "apply",
  receipt: { runId: "run-1", environment: "preview", scope: "pr-42", status: "failed", lines, ...over },
  drift: [],
  warnings: [],
});

describe("comment step", () => {
  const hostile = [
    "<!DOCTYPE html><html><body><h1>502</h1><!-- cf-ray 8c2f",
    "line one\r\nline two | with a pipe\rand `backticks` <script>alert(1)</script> & more",
    "a span that would hide a tag: `<script>alert(1)</script>` and `a|b`",
  ];

  it.each(hostile)("posts Sponson's markdown; provider text %# stays on its line, with no tag, HTML comment or unsafe code span", async (error) => {
    const { body, rendered } = await comment(receipt({ env: { id: "env", adapter: "vercel", op: "env", status: "failed", errorCode: "PROVIDER_TRANSIENT", error, resources: [], outputs: {} } }), "apply", 1);
    expect(rendered).toBe(true);
    expect(body.startsWith("<!-- sponson:preview -->\n### Sponson could not apply the preview for pr-42")).toBe(true);
    const rest = body.replace(/^<!-- sponson:preview -->/, "");
    expect(rest).not.toContain("<!--");
    expect(rest).not.toMatch(/<(html|body|h1|script)\b/i);
    // An identifier in backticks is a code span, as Sponson's own; one holding a tag, a pipe or an entity is not.
    const spans = rest.split("`").filter((_, i) => i % 2 === 1);
    expect(spans.filter((x) => /[<>|&]/.test(x))).toEqual([]);
    expect(rest).not.toContain("&#96;backticks&#96;");
    expect(rest).not.toMatch(/\r/);
    expect(body.split("\n").find((l) => l.startsWith("- `env`"))).toContain("`PROVIDER_TRANSIENT`");
    expect(body).toContain("[run log](https://github.com/acme/app/actions/runs/1001)");
  });

  it("an error envelope and a crash still post a titled comment", async () => {
    const err = await comment({ ok: false, command: "apply", error: { code: "INTERNAL", message: "<b>x</b>\n| y" } }, "apply", 1);
    expect(err.body).toContain("### Sponson apply failed: `INTERNAL`");
    expect(err.body).toContain("&lt;b&gt;x&lt;/b&gt; &#124; y");
    const crash = await comment(null, "destroy", 1);
    expect(crash.body).toContain("### Sponson destroy crashed (exit 1)");
  });

  it("shows approvedBy and stale runs", async () => {
    const { body } = await comment(
      receipt({ a: { id: "a", adapter: "vercel", op: "env", status: "skipped", errorCode: "STALE", error: "stale", resources: [], outputs: {} } }, { status: "complete", stale: true, approvedBy: "alice", environment: "production" }),
      "apply",
      0,
      { env: "production" },
    );
    expect(body.startsWith("<!-- sponson:production -->")).toBe(true);
    expect(body).toContain("a newer commit was already applied");
  });

  it("without a renderer (a Sponson version older than the markdown renderer), posts a short fallback with the marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sponson-nomod-"));
    const mod = join(dir, "old.mjs");
    await writeFile(mod, "export const run = () => 0;\n");
    const { body, rendered } = await comment(receipt({}), "apply", 1, { module: mod });
    expect(rendered).toBe(false);
    expect(body).toMatch(/^<!-- sponson:preview -->\n### Sponson apply exited with 1\n/);
    expect(body).toContain("[run log](https://github.com/acme/app/actions/runs/1001)");
  });

  it("updates this environment's comment in place, by the marker at its start", async () => {
    const existing = [
      { id: 1, body: "quoting `<!-- sponson:preview -->` in a review" },
      { id: 2, body: "<!-- sponson:production -->\nold" },
      { id: 3, body: "<!-- sponson:preview -->\nold" },
    ];
    const { calls } = await comment(receipt({}, { status: "complete" }), "apply", 0, { existing });
    expect(calls.filter((c) => c.op === "update").map((c) => c.args.comment_id)).toEqual([3]);
    expect(calls.some((c) => c.op === "create")).toBe(false);
  });

  it("never posts more than GitHub accepts, whatever the file holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sponson-big-"));
    const path = join(dir, "comment.md");
    await writeFile(path, "x".repeat(80_000));
    const { github, calls } = mockGithub();
    await runScript(await script("comment"), { payload: { pull_request: { number: 42 } }, github, env: { COMMENT_PATH: path, SPONSON_COMMAND: "apply", SPONSON_EXIT: "0", SPONSON_PR: "42" } });
    const body = calls.find((c) => c.op === "create")!.args.body as string;
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.startsWith("<!-- sponson:preview -->\n")).toBe(true);
  });

  it("the run step renders the comment after the CLI, from the JSON it saved, for source and npm installs alike", async () => {
    const { steps } = await action();
    const run = steps.find((s) => s.id === "run")!.run!;
    expect(run).toContain('markdown_module="$root/packages/cli/src/markdown.ts"');
    expect(run).toContain('markdown_module="$prefix/node_modules/sponson/dist/index.js"');
    expect(run).toContain('"$GITHUB_ACTION_PATH/render-comment.mjs"');
    expect(run.indexOf("render-comment.mjs")).toBeGreaterThan(run.indexOf('> "$RUNNER_TEMP/sponson-result.json"'));
  });
});


// ---------------------------------------------------------------------------
// The documented workflow
// ---------------------------------------------------------------------------

describe("action/README.md example workflow", () => {
  async function workflow(): Promise<any> {
    const md = await readFile(join(root, "action/README.md"), "utf8");
    const block = md.match(/## Example workflow[\s\S]*?```yaml\n([\s\S]*?)```/)![1]!;
    return parseYaml(block);
  }

  it("filters deployment_status to finished preview deployments", async () => {
    const wf = await workflow();
    const preview = Object.values(wf.jobs)[0] as any;
    expect(preview.if).toContain("github.event.deployment_status.state == 'success'");
    expect(preview.if).toContain("github.event.deployment.environment != 'Production'");
    expect(preview.if).toContain("github.event.deployment.environment != 'production'");
  });

  it("gives every preview step, destroy included, the provider tokens", async () => {
    const wf = await workflow();
    const preview = Object.values(wf.jobs)[0] as any;
    const destroy = preview.steps.find((s: Step) => s.with?.command === "destroy");
    const env = { ...(wf.env ?? {}), ...(preview.env ?? {}), ...(destroy.env ?? {}) };
    for (const k of ["VERCEL_TOKEN", "NEON_API_KEY", "CLERK_SECRET_KEY"]) expect(env[k], k).toMatch(/secrets\./);
  });

  it("declares permissions, and production runs on push behind an environment with the approver from its review", async () => {
    const wf = await workflow();
    expect(wf.permissions).toMatchObject({ contents: "write", "pull-requests": "write", actions: "read" });
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(["pull_request", "deployment_status", "push"]));
    const prod = wf.jobs.production;
    expect(prod.environment).toBe("production");
    expect(prod.if).toContain("push");
    expect(prod.env.VERCEL_TOKEN).toMatch(/secrets\.PROD_/);
    expect(prod.env.PROD_DATABASE_URL).toMatch(/secrets\.PROD_DATABASE_URL/);
    const approval = prod.steps.find((s: Step) => s.id === "approval");
    expect(approval.with.script).toContain("getReviewsForRun");
    const apply = prod.steps.find((s: Step) => s.uses?.includes("/action@"));
    expect(apply.with).toMatchObject({ command: "apply", env: "production", "approved-by": "${{ steps.approval.outputs.by }}" });
  });
});

describe("action.yml script injection", () => {
  it("never splices ${{ … }} into a shell script or github-script body; values arrive through env", async () => {
    const { steps } = await action();
    const spliced = steps.flatMap((s, i) => {
      const bodies = [s.run ?? "", s.with?.script ?? ""];
      return bodies.filter((b) => b.includes("${{")).map(() => `step ${i}${s.id ? ` (${s.id})` : ""}`);
    });
    expect(spliced, "move these expressions into `env:` and reference them as $VAR / process.env.VAR").toEqual([]);
  });

  it("writes multi-line step outputs with a random delimiter", async () => {
    const { steps } = await action();
    const run = steps.map((s) => s.run ?? "").join("\n");
    expect(run).not.toMatch(/<<\s*[A-Z_]+EOF\b/);
    expect(run).toMatch(/eof="SPONSON_\$\(openssl rand -hex 16\)"/);
  });
});
