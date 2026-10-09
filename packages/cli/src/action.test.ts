 
/**
 * action/action.yml's github-script steps, extracted verbatim and run in node with mocked github / context / core
 * (the approach of scenarios/journeys/secrets/action-comment.test.ts), plus the documented workflow in action/README.md.
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url).pathname;
const requireFn = createRequire(import.meta.url);
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

async function comment(result: unknown, command = "apply", exit = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sponson-action-"));
  const path = join(dir, "result.json");
  await writeFile(path, result === null ? "" : JSON.stringify(result));
  const { github, calls } = mockGithub();
  await runScript(await script("comment"), { payload: { pull_request: { number: 42 } }, github, env: { RESULT_PATH: path, SPONSON_COMMAND: command, SPONSON_EXIT: String(exit), SPONSON_PR: "42" } });
  return calls.find((c) => c.op === "create" || c.op === "update")!.args.body as string;
}

function tableProblems(body: string): string[] {
  const problems: string[] = [];
  if (/\r/.test(body)) problems.push("bare CR");
  const lines = body.split(/\r\n|\r|\n/);
  const start = lines.findIndex((l) => l.startsWith("| | line |"));
  if (start < 0) return problems;
  for (let i = start; i < lines.length && lines[i] !== ""; i++) {
    const pipes = (lines[i]!.match(/(?<!\\)\|/g) ?? []).length;
    if (!lines[i]!.startsWith("|") || pipes !== 6) problems.push(`row ${i - start}: ${lines[i]!.slice(0, 120)}`);
  }
  return problems;
}

const receipt = (lines: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  ok: true,
  command: "apply",
  receipt: { runId: "run-1", environment: "preview", scope: "pr-42", status: "failed", lines, ...over },
  drift: [],
  warnings: [],
});

describe("comment step escaping", () => {
  const hostile = [
    "<!DOCTYPE html><html><body><h1>502</h1><!-- cf-ray 8c2f",
    "line one\r\nline two | with a pipe\rand `backticks` <script>alert(1)</script> & more",
  ];

  it.each(hostile)("provider text %#: one row per line, no tag, no HTML comment, no code span", async (error) => {
    const body = await comment(receipt({ env: { id: "env", adapter: "vercel", op: "env", status: "failed", errorCode: "PROVIDER_TRANSIENT", error, resources: [], outputs: {} } }), "apply", 1);
    expect(tableProblems(body), body).toEqual([]);
    const rest = body.replace(/^<!-- sponson:preview -->/, "");
    expect(rest).not.toContain("<!--");
    expect(rest).not.toMatch(/<(html|body|h1|script)\b/i);
    expect(rest).not.toMatch(/`backticks`/);
    expect(rest).toContain("`PROVIDER_TRANSIENT`");
  });

  it("escapes error envelopes, drift and warnings too", async () => {
    const body = await comment({ ok: false, command: "apply", error: { code: "INTERNAL", message: "<b>x</b>\n| y" } }, "apply", 1);
    expect(body).toContain("`INTERNAL`");
    expect(body).toContain("&lt;b&gt;x&lt;/b&gt; &#124; y");
    const plan = await comment(
      { ok: true, command: "plan", environment: "preview", scope: "pr-42", planHash: "abcdef0123", requiresApproval: false, lock: null, lines: [], drift: [{ kind: "changed", adapter: "vercel", message: "<img src=x>\nedited" }], warnings: ["`w`\r\n<i>"] },
      "plan",
    );
    expect(plan).not.toMatch(/<(img|i)\b/);
    expect(plan).toContain("&lt;img src=x&gt; edited");
  });

  it("renders DiffSide values, blocked lines, waitingFor and the lock", async () => {
    const body = await comment(
      {
        ok: false,
        command: "plan",
        environment: "preview",
        scope: "pr-42",
        planHash: "abcdef0123",
        requiresApproval: false,
        lock: { holder: "run-9", acquiredAt: "", expiresAt: "" },
        lines: [
          {
            id: "env",
            adapter: "vercel",
            op: "env",
            status: "update",
            diffs: [
              { key: "a", kind: "update", label: "FLAG", before: { state: "literal", value: "off" }, after: { state: "literal", value: "on" } },
              { key: "b", kind: "create", label: "DATABASE_URL", after: { state: "pending", ref: "db.connection_string" } },
              { key: "c", kind: "update", label: "STRIPE_KEY", before: { state: "sensitive" }, after: { state: "secret", ref: "env://STRIPE_KEY" } },
            ],
          },
          { id: "callback", adapter: "clerk", op: "redirect_allow", status: "pending", waitingOn: "env", waitingFor: "deploy", diffs: [] },
          { id: "other", adapter: "vercel", op: "env", status: "blocked", errorCode: "DRIFT_CHANGED", error: "changed outside Sponson", diffs: [] },
        ],
        drift: [],
        warnings: [],
      },
      "plan",
      1,
    );
    expect(body).toContain("FLAG off → on<br>DATABASE_URL (pending ← db.connection_string)<br>STRIPE_KEY (secret) → (secret ← env://STRIPE_KEY)");
    expect(body).toContain("waiting on `env` (deploy)");
    expect(body).toMatch(/\| `-` \| `other` \| vercel\.env \| blocked \| `DRIFT_CHANGED` changed outside Sponson \|/);
    expect(body).toContain("An apply is running on this scope");
    expect(body).not.toContain("[object Object]");
    expect(tableProblems(body)).toEqual([]);
  });

  it("shows approvedBy and stale runs; blocked receipt lines get the `-` symbol", async () => {
    const body = await comment(
      receipt({ a: { id: "a", adapter: "vercel", op: "env", status: "blocked", errorCode: "OWNED_BY_OTHER_SCOPE", error: "owned by pr-7", resources: [], outputs: {} } }, { status: "complete", stale: true, approvedBy: "alice", environment: "production" }),
    );
    expect(body).toContain("stale (a newer commit was already applied)");
    expect(body).toContain("approved by alice");
    expect(body).toMatch(/\| `-` \| `a` \|/);
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
