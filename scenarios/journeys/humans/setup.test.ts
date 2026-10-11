/**
 * `sponson init --setup`: a newcomer goes from a repository to checked tokens, stored GitHub secrets and a workflow
 * in one run, against the fake cloud. The person is a scripted terminal (typing the sim's test tokens, answering
 * yes or no), `gh` is a fake on PATH that records its argv, environment and stdin, and the action's release tag lives
 * in a local repository. Every token must reach `gh` on stdin and nowhere else: not argv, not the child's
 * environment, not stdout or stderr, not a file of the repository.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "@sponson/adapters";
import { SponsonError, type AdapterContext, type CredentialCheck } from "@sponson/core";
import { SIM_TOKENS, SUPABASE_DEMO_PROJECT, startSim, type SimHandle } from "@sponson/sim";
import { run } from "sponson";
import { classify } from "../../../packages/cli/src/setup.js";
import type { Terminal } from "../../../packages/cli/src/terminal.js";
import { VERSION } from "../../../packages/cli/src/version.js";
import { simEnv } from "../../support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sponson-setup-${prefix}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function sim(): Promise<SimHandle> {
  const s = await startSim();
  cleanups.push(() => s.close());
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Each first-class provider's check against the sim
// ---------------------------------------------------------------------------------------------------------------

/** Each adapter's provider block naming what the sim seeds by default, and one naming something it does not have. */
const BLOCKS: Record<string, { block: Record<string, unknown>; reaches: string; other?: Record<string, unknown> }> = {
  vercel: { block: { project: "prj_demo" }, reaches: "project prj_demo", other: { project: "prj_other" } },
  netlify: { block: { site: "site_demo" }, reaches: "site site_demo", other: { site: "site_other" } },
  cloudflare: { block: { account: "acc_demo", project: "demo" }, reaches: "Pages project demo", other: { account: "acc_demo", project: "other" } },
  neon: { block: { project: "proj_demo" }, reaches: "project proj_demo", other: { project: "proj_other" } },
  planetscale: { block: { organization: "acme", database: "app" }, reaches: "database app", other: { organization: "acme", database: "other" } },
  clerk: { block: {}, reaches: "instance" },
  supabase: { block: { project: SUPABASE_DEMO_PROJECT }, reaches: `project ${SUPABASE_DEMO_PROJECT}`, other: { project: "zzzzzzzzzzzzzzzzzzzz" } },
  launchdarkly: { block: { project: "demo", environment: "preview" }, reaches: "project demo", other: { project: "other", environment: "preview" } },
  algolia: { block: { application_id: "app" }, reaches: "application app" },
  digitalocean: { block: {}, reaches: "account" },
  xata: { block: { organization: "acme", project: "app" }, reaches: "project app", other: { organization: "acme", project: "other" } },
};

function actxFor(s: SimHandle, provider: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): AdapterContext {
  return {
    ctx: { env: "preview", git: { branch: "setup", sha: "0".repeat(40), short_sha: "0000000" }, pr: { number: null }, scope: "setup" },
    provider,
    env: { ...simEnv(s), SPONSON_HTTP_RETRIES: "0", ...env },
    log: () => {},
    intend: () => Promise.reject(new Error("a check must not create")),
    redact: (t) => t,
  };
}

async function verify(name: string, actx: AdapterContext): Promise<CredentialCheck> {
  return createRegistry().adapter(name).verifyCredential!(actx);
}

/** The adapters whose API answers 403, never 404, for what a credential cannot reach (`notFoundMeansMissing`). */
const MISSING_ON_404 = ["cloudflare", "launchdarkly"];

/** The classified failure of a check expected to fail, as setup classifies it for `release.plan.yaml`. */
async function notFound(name: string, actx: AdapterContext): Promise<ReturnType<typeof classify>> {
  const missing = createRegistry().adapter(name).about?.notFoundMeansMissing === true;
  expect(missing, name).toBe(MISSING_ON_404.includes(name));
  return verify(name, actx).then(
    () => expect.fail(`${name}: the check passed`),
    (e: unknown) => classify(e, { plan: "release.plan.yaml", notFoundMeansMissing: missing }),
  );
}

async function outcome(name: string, actx: AdapterContext): Promise<string> {
  try {
    await verify(name, actx);
    return "ok";
  } catch (e) {
    return classify(e).status;
  }
}

describe("each first-class provider's credential check, against the sim", () => {
  it("every first-class adapter with a credential variable declares where to create it, the least it needs, and a check", () => {
    const registry = createRegistry();
    for (const name of registry.adapterNames().filter((n) => !["http", "manual"].includes(n))) {
      const a = registry.adapter(name);
      expect(a.about?.credentialUrl, name).toMatch(/^https:\/\//);
      expect(a.about?.credentialScope, name).toBeTruthy();
      if (!a.about?.credentialCommand) expect(Object.keys(BLOCKS), `${name} has a verifyCredential and a case here`).toContain(name);
      if (!a.about?.credentialCommand) expect(typeof a.verifyCredential, name).toBe("function");
    }
  });

  for (const [name, c] of Object.entries(BLOCKS)) {
    it(`${name}: ok with the sim's token, reaching what the plan names`, async () => {
      const s = await sim();
      const r = await verify(name, actxFor(s, c.block));
      expect(r.reaches).toBe(c.reaches);
      expect(r.request).toMatch(/^GET \/\S*$/);
      expect(r.request).not.toContain("?");
      expect(s.state.writes).toEqual([]);
    });

    it(`${name}: a 401 is unauthorized, a 403 wrong scope`, async () => {
      const s = await sim();
      s.state.applyChaos({ fail_next: 1, status: 401, fail_on: "GET *" });
      expect(await outcome(name, actxFor(s, c.block))).toBe("unauthorized");
      s.state.applyChaos({ fail_next: 1, status: 403, fail_on: "GET *" });
      expect(await outcome(name, actxFor(s, c.block))).toBe("wrong_scope");
    });

    if (c.other) {
      it(`${name}: a project the sim does not have is not found, said as the API can tell it; without one, the account is checked`, async () => {
        const s = await sim();
        expect(await outcome(name, actxFor(s, c.other!))).toBe("not_found");
        const failed = await notFound(name, actxFor(s, c.other!));
        expect(failed.message).toContain("check the id in release.plan.yaml");
        // Only an API that answers 403 for what a credential cannot reach says the id is wrong, and nothing else.
        if (MISSING_ON_404.includes(name)) expect(failed.message).not.toContain("cannot see it");
        else expect(failed.message).toContain("or the credential cannot see it: another account or team");
        const r = await verify(name, actxFor(s, {}));
        expect(r.reaches).toBe("account");
      });
    }
  }

  it("a missing token is unauthorized before any request", async () => {
    const s = await sim();
    const env = { VERCEL_TOKEN: "" };
    expect(await outcome("vercel", actxFor(s, { project: "prj_demo" }, env))).toBe("unauthorized");
  });

  it("classify: what is neither a 401, a 403 nor a 404 is an error with its message", () => {
    expect(classify(new SponsonError("PROVIDER_TRANSIENT", "vercel: 503", { method: "GET", path: "/v2/user?x=1", status: 503 }))).toEqual({ status: "error", checked: "GET /v2/user", reaches: null, message: "vercel: 503" });
    expect(classify(new Error("boom")).status).toBe("error");
  });

  it("classify: a 404 is not found, never wrong scope; a 403 is wrong scope", () => {
    const at = { method: "GET", path: "/accounts/a/pages/projects/p", status: 404 };
    expect(classify(new SponsonError("PROVIDER_NOT_FOUND", "cloudflare: not found", at), { plan: "release.plan.yaml", notFoundMeansMissing: true })).toEqual({ status: "not_found", checked: "GET /accounts/a/pages/projects/p", reaches: null, message: "cloudflare: not found (check the id in release.plan.yaml)" });
    expect(classify(new SponsonError("PROVIDER_NOT_FOUND", "vercel: not found", at), { plan: "release.plan.yaml" }).message).toBe("vercel: not found (check the id in release.plan.yaml; or the credential cannot see it: another account or team)");
    expect(classify(new SponsonError("PROVIDER_AUTH", "cloudflare: forbidden", { ...at, status: 403 })).status).toBe("wrong_scope");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------------------------

/** The person at the keyboard: types `tokens[NAME]` when asked for NAME, answers `confirm(question)`. */
function person(tokens: Record<string, string>, confirm: (q: string) => boolean = () => true): Terminal & { asked: string[] } {
  const asked: string[] = [];
  return {
    interactive: true,
    asked,
    secret: (q) => {
      asked.push(q);
      const name = /([A-Z][A-Z0-9_]+) \(input hidden/.exec(q)?.[1] ?? "";
      return Promise.resolve(tokens[name] ?? "");
    },
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(confirm(q));
    },
  };
}

/** A fake `gh` on PATH: each call appends `{ argv, env, stdin }` to $FAKE_GH_LOG; $FAKE_GH_FAIL makes it fail echoing stdin. */
async function fakeGh(): Promise<{ bin: string; log: string; calls(): Promise<Array<{ argv: string[]; env: Record<string, string>; stdin: string }>> }> {
  const bin = await tempDir("bin");
  const log = join(bin, "calls.jsonl");
  const script = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "let stdin = '';",
    "process.stdin.on('data', (c) => (stdin += c)).on('end', () => {",
    "  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin }) + '\\n');",
    "  if (process.env.FAKE_GH_FAIL) { process.stderr.write('HTTP 403: could not set ' + stdin + '\\n'); process.exit(1); }",
    "  process.stdout.write('✓ Set Actions secret ' + process.argv[4] + ' for ' + process.argv[6] + '\\n');",
    "});",
  ].join("\n");
  await writeFile(join(bin, "gh"), script);
  await chmod(join(bin, "gh"), 0o755);
  return {
    bin,
    log,
    calls: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string>; stdin: string }),
  };
}

/** A repository standing in for the action's, with the installed version's release tag; returns its path and the tag's commit. */
async function actionRepo(): Promise<{ url: string; commit: string }> {
  const dir = await tempDir("action");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "release");
  git("tag", "-a", `sponson@${VERSION}`, "-m", "release");
  return { url: dir, commit: git("rev-parse", "HEAD") };
}

const FIXTURE: Record<string, string | object> = {
  "package.json": { dependencies: { next: "15.1.0", "@neondatabase/serverless": "^1.0.0", "@clerk/nextjs": "^6.0.0", stripe: "^16.0.0" } },
  ".vercel/project.json": { projectId: "prj_demo" },
  ".neon": { projectId: "proj_demo" },
  ".env.example": "DATABASE_URL=\nCLERK_SECRET_KEY=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\n",
};

/** The one note the fixture's starter leaves: the Stripe webhook path, the recipe's default, to check against the app. */
const PATH_CHECK = /^ {4}path: "\/api\/webhooks\/stripe"\s+# CHECK: The path of the app's webhook handler.*$/m;

/** The Neon project TODO a repository without `.neon` leaves: a placeholder the plan cannot run with. */
const NEON_TODO = /^( {2}neon: \{ project: )"proj_xxx"( \}) +# TODO:.*$/m;

/** The person looks up the Neon project id and writes it in place of the placeholder, deleting the TODO comment. */
async function fillInNeonProject(cwd: string): Promise<void> {
  const plan = join(cwd, "release.plan.yaml");
  const text = await readFile(plan, "utf8");
  expect(text).toMatch(NEON_TODO);
  await writeFile(plan, text.replace(NEON_TODO, '$1"proj_demo"$2'));
}

/** The fixture app's repository, with a GitHub origin; `without` leaves files out. */
async function appRepo(without: string[] = []): Promise<string> {
  const dir = await tempDir("app");
  for (const [path, content] of Object.entries(FIXTURE).filter(([path]) => !without.includes(path))) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/web.git"], { cwd: dir });
  return dir;
}

/** The sim's test tokens for this fixture's providers, each made unique so a leak is unambiguous. */
const TOKENS = {
  VERCEL_TOKEN: `${SIM_TOKENS.VERCEL_TOKEN}-setup-secret-1`,
  NEON_API_KEY: `${SIM_TOKENS.NEON_API_KEY}-setup-secret-2`,
  CLERK_SECRET_KEY: `${SIM_TOKENS.CLERK_SECRET_KEY}-setup-secret-3`,
  STRIPE_SECRET_KEY: "sk_test_setup-secret-4",
};

async function everyFile(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && !e.parentPath.includes(`${join(dir, ".git")}`)) out.push(join(e.parentPath, e.name));
  }
  return out;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function setup(cwd: string, env: NodeJS.ProcessEnv, terminal: Terminal | undefined, ...args: string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await run(["init", "--setup", ...args], { cwd, env, terminal, stdout: { write: (s: string) => void (stdout += s) }, stderr: { write: (s: string) => void (stderr += s) }, color: false });
  return { code, stdout, stderr };
}

async function expectNoLeak(r: Run, cwd: string, extra: string[] = []): Promise<void> {
  for (const token of Object.values(TOKENS)) {
    expect(r.stdout).not.toContain(token);
    expect(r.stderr).not.toContain(token);
    for (const f of await everyFile(cwd)) expect(await readFile(f, "utf8"), f).not.toContain(token);
    for (const x of extra) expect(x).not.toContain(token);
  }
}

describe("init --setup, end to end on a fixture repository", () => {
  it("a person types each token: checked, stored with gh on stdin only, and the workflow pinned to the release tag's commit", async () => {
    const s = await sim();
    s.state.reset({ rest: { collections: { "/webhook_endpoints": [] } } });
    const gh = await fakeGh();
    const action = await actionRepo();
    const cwd = await appRepo();
    const env = { ...simEnv(s, { tokens: false }), STRIPE_API_URL: `${s.url}/rest`, PATH: `${gh.bin}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_GH_LOG: gh.log, SPONSON_ACTION_REPO: action.url };
    const me = person(TOKENS);

    const r = await setup(cwd, env, me);

    expect(r.code, r.stderr).toBe(0);
    // A recipe default the plan runs with is a "please check", listed first, and blocks nothing: no TODO, no wait.
    expect(await readFile(join(cwd, "release.plan.yaml"), "utf8")).toMatch(PATH_CHECK);
    expect(r.stdout).toContain('Please check (release.plan.yaml runs with this default; nothing waits on it):\n  changes.stripe_webhook_endpoint.path (now "/api/webhooks/stripe"): The path of the app\'s webhook handler');
    expect(r.stdout.indexOf("Please check")).toBeLessThan(r.stdout.indexOf("Credentials for release.plan.yaml:"));
    expect(r.stdout).not.toContain("To fill in first");
    // The endpoint's once-only signing secret goes to the name .env.example uses, by reference.
    expect(await readFile(join(cwd, "release.plan.yaml"), "utf8")).toContain("      STRIPE_WEBHOOK_SECRET: { from: stripe_webhook_endpoint.secret }");
    // Where to create each token, before it is asked for.
    expect(r.stdout).toContain("create it: https://vercel.com/account/tokens");
    expect(r.stdout).toContain("create it: https://neon.com/docs/manage/api-keys");
    expect(r.stdout).toContain("create it: https://dashboard.clerk.com/last-active?path=api-keys");
    expect(r.stdout).toContain("create it: https://dashboard.stripe.com/test/apikeys");
    expect(r.stdout.indexOf("create it: https://vercel.com/account/tokens")).toBeLessThan(r.stdout.indexOf("ok: GET /v9/projects/prj_demo"));
    expect(r.stdout).toContain("ok: GET /projects/proj_demo (reaches project proj_demo)");
    expect(r.stdout).toContain("ok: GET /redirect_urls (reaches instance)");
    expect(r.stdout).toContain("ok: GET /webhook_endpoints (reaches account)");
    expect(me.asked.filter((q) => q.includes("input hidden"))).toHaveLength(4);

    // gh got each value on stdin, and nowhere else.
    const calls = await gh.calls();
    expect(calls.map((c) => c.argv)).toEqual(["NEON_API_KEY", "VERCEL_TOKEN", "CLERK_SECRET_KEY", "STRIPE_SECRET_KEY"].map((name) => ["secret", "set", name, "--repo", "acme/web"]));
    for (const c of calls) {
      expect(c.stdin).toBe(TOKENS[c.argv[2] as keyof typeof TOKENS]);
      for (const token of Object.values(TOKENS)) {
        expect(c.argv.join(" ")).not.toContain(token);
        expect(JSON.stringify(c.env)).not.toContain(token);
      }
    }
    expect(r.stdout).toContain("VERCEL_TOKEN: stored");

    // Nothing blocks, so the workflow is offered in the same run: the action pinned to the commit of the installed
    // version's tag, every variable from secrets.
    expect(me.asked.some((q) => q.includes("Write .github/workflows/sponson.yml"))).toBe(true);
    const workflow = await readFile(join(cwd, ".github/workflows/sponson.yml"), "utf8");
    expect(workflow).toContain(`uses: MishaBear94/Sponson/action@${action.commit} # sponson@${VERSION}`);
    for (const name of Object.keys(TOKENS)) expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(r.stdout).toContain("Ready: run `sponson plan`.");
    expect(r.stdout).not.toContain("To try Sponson first");
    await expectNoLeak(r, cwd, [workflow]);

    // The tokens work for the next command too: the same values, from the environment, plan the release.
    let out = "";
    const plan = await run(["plan", "--json", "--receipts", "local", "--pr", "1", "--branch", "feat/x", "--sha", "0".repeat(40)], { cwd, env: { ...env, ...TOKENS }, stdout: { write: (x: string) => void (out += x) }, stderr: { write: () => {} } });
    expect(plan, out).toBe(0);
  });

  it("--json --yes with the tokens in the environment: a report without values, everything stored, nothing asked", async () => {
    const s = await sim();
    s.state.reset({ rest: { collections: { "/webhook_endpoints": [] } } });
    const gh = await fakeGh();
    const action = await actionRepo();
    const cwd = await appRepo();
    const env = { ...simEnv(s, { tokens: false }), ...TOKENS, STRIPE_API_URL: `${s.url}/rest`, PATH: `${gh.bin}:${process.env.PATH}`, FAKE_GH_LOG: gh.log, SPONSON_ACTION_REPO: action.url };

    const first = JSON.parse((await setup(cwd, env, undefined, "--json", "--yes")).stdout) as { created: boolean; detected: { todo: unknown[]; check: Array<{ path: string }> } | null; setup: { ready: boolean; next: { command: string | null; why: string }; workflow: { result: string; commit: string } } };
    expect(first.created).toBe(true);
    // The Stripe path is a default to check, not a TODO: it neither blocks readiness nor the workflow.
    expect(first.detected!.todo).toEqual([]);
    expect(first.detected!.check.map((t) => t.path)).toEqual(["changes.stripe_webhook_endpoint.path"]);
    expect(first.setup).toMatchObject({ ready: true, workflow: { result: "written", commit: action.commit } });
    // `next` is a command an agent can run, and why.
    expect(first.setup.next).toEqual({ command: "sponson plan", why: expect.stringContaining("every credential") });

    // The re-run, on the plan that now exists: detection is reported the same way, with the notes the plan still has.
    const r = await setup(cwd, env, undefined, "--json", "--yes");

    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as { ok: boolean; created: boolean; detected: { found: Array<{ id: string }>; todo: unknown[]; check: Array<{ path: string }> } | null; setup: { ready: boolean; next: { command: string | null }; repo: string; credentials: Array<{ provider: string; status: string; variables: Array<{ from: string }> }>; secrets: Array<{ name: string; result: string }>; workflow: { result: string; commit: string } } };
    expect(report.ok).toBe(true);
    expect(report.created).toBe(false);
    expect(report.detected!.found.map((f) => f.id)).toEqual(expect.arrayContaining(["vercel", "neon", "clerk", "stripe"]));
    expect(report.detected!.todo).toEqual([]);
    expect(report.detected!.check.map((t) => t.path)).toEqual(["changes.stripe_webhook_endpoint.path"]);
    expect(report.setup.next.command).toBe("sponson plan");
    expect(report.setup.repo).toBe("acme/web");
    expect(report.setup.ready).toBe(true);
    expect(report.setup.credentials.map((c) => [c.provider, c.status])).toEqual([
      ["neon", "ok"],
      ["vercel", "ok"],
      ["clerk", "ok"],
      ["stripe", "ok"],
    ]);
    expect(report.setup.credentials.flatMap((c) => c.variables.map((v) => v.from))).toEqual(["environment", "environment", "environment", "environment"]);
    expect(report.setup.secrets.every((x) => x.result === "stored")).toBe(true);
    expect(report.setup.workflow).toMatchObject({ result: "exists" });
    // gh's environment: not the tokens this process was given.
    for (const c of await gh.calls()) for (const token of Object.values(TOKENS)) expect(JSON.stringify(c.env)).not.toContain(token);
    await expectNoLeak(r, cwd);
  });

  it("a placeholder the plan cannot run with (no Neon project id found) is a TODO: no workflow, and `next` has no command until it is filled in", async () => {
    const s = await sim();
    s.state.reset({ rest: { collections: { "/webhook_endpoints": [] } } });
    const gh = await fakeGh();
    const action = await actionRepo();
    const cwd = await appRepo([".neon"]);
    const env = { ...simEnv(s, { tokens: false }), ...TOKENS, STRIPE_API_URL: `${s.url}/rest`, PATH: `${gh.bin}:${process.env.PATH}`, FAKE_GH_LOG: gh.log, SPONSON_ACTION_REPO: action.url };

    const text = await setup(cwd, env, person({}, () => true));
    expect(text.stdout).toContain('To fill in first (1 TODO in release.plan.yaml):\n  providers.neon.project (now "proj_xxx")');
    expect(text.stdout).toContain("Workflow: not offered while release.plan.yaml has TODOs (listed at the top)");
    expect(text.stdout).toContain("Not ready yet: Fill in the TODO in release.plan.yaml (and delete each `# TODO` comment), then run `sponson init --setup` again and `sponson plan`.");
    await expect(readFile(join(cwd, ".github/workflows/sponson.yml"), "utf8")).rejects.toThrow();

    const blocked = JSON.parse((await setup(cwd, env, undefined, "--json", "--yes")).stdout) as { detected: { todo: Array<{ path: string }> }; setup: { ready: boolean; next: { command: string | null; why: string }; workflow: { result: string } } };
    expect(blocked.detected.todo.map((t) => t.path)).toEqual(["providers.neon.project"]);
    expect(blocked.setup).toMatchObject({ ready: false, workflow: { result: "todo" }, next: { command: null, why: expect.stringContaining("Fill in the TODO in release.plan.yaml") } });

    await fillInNeonProject(cwd);
    const ready = JSON.parse((await setup(cwd, env, undefined, "--json", "--yes")).stdout) as { setup: { ready: boolean; next: { command: string | null }; workflow: { result: string } } };
    expect(ready.setup).toMatchObject({ ready: true, workflow: { result: "written" }, next: { command: "sponson plan" } });
  });

  it("a rejected token is unauthorized and never offered to gh; a declined secret is not stored; an existing workflow is left alone", async () => {
    const s = await sim();
    s.state.reset({ rest: { collections: { "/webhook_endpoints": [] } } });
    const gh = await fakeGh();
    const cwd = await appRepo();
    await mkdir(join(cwd, ".github/workflows"), { recursive: true });
    await writeFile(join(cwd, ".github/workflows/sponson.yml"), "# mine\n");
    s.state.applyChaos({ fail_next: 1, status: 401, fail_on: "GET /vercel/*" });
    const env = { ...simEnv(s, { tokens: false }), STRIPE_API_URL: `${s.url}/rest`, PATH: `${gh.bin}:${process.env.PATH}`, FAKE_GH_LOG: gh.log };

    const r = await setup(cwd, env, person(TOKENS, (q) => !q.includes("CLERK_SECRET_KEY")));

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/unauthorized: .*401/);
    expect(r.stdout).toContain("CLERK_SECRET_KEY: not stored");
    expect(r.stdout).toContain("Not ready yet");
    expect((await gh.calls()).map((c) => c.argv[2])).toEqual(["NEON_API_KEY", "STRIPE_SECRET_KEY"]);
    expect(await readFile(join(cwd, ".github/workflows/sponson.yml"), "utf8")).toBe("# mine\n");
    expect(r.stdout).toContain(".github/workflows/sponson.yml exists; left as it is.");
    await expectNoLeak(r, cwd);
  });

  it("each credential says Sponson calls the provider with it, apart from the app's own variables; `next.why` points nowhere positional", async () => {
    const s = await sim();
    s.state.reset({ rest: { collections: { "/webhook_endpoints": [] } } });
    const cwd = await appRepo();
    // The app names its Stripe key STRIPE_KEY; Sponson's credential is STRIPE_SECRET_KEY. Only names are read.
    await writeFile(join(cwd, ".env.example"), "DATABASE_URL=\nCLERK_SECRET_KEY=\nSTRIPE_KEY=sk_test_value-never-read\nSTRIPE_WEBHOOK_SECRET=\n");
    s.state.applyChaos({ fail_next: 1, status: 401, fail_on: "GET /vercel/*" });
    const env = { ...simEnv(s, { tokens: false }), ...TOKENS, STRIPE_API_URL: `${s.url}/rest` };

    const r = await setup(cwd, env, undefined, "--json");

    const report = JSON.parse(r.stdout) as { setup: { next: { command: string | null; why: string }; credentials: Array<{ provider: string; purpose: string | null }> } };
    const purpose = (p: string) => report.setup.credentials.find((c) => c.provider === p)!.purpose;
    expect(purpose("stripe")).toBe("Sponson calls Stripe with this key; it is not your app's STRIPE_KEY or STRIPE_WEBHOOK_SECRET.");
    expect(purpose("vercel")).toBe("Sponson calls Vercel with this token; it is Sponson's credential, not one of your app's variables.");
    expect(purpose("clerk")).toBe("Sponson calls Clerk with this key; your app's own CLERK_SECRET_KEY has the same name but is set separately, where your app runs.");
    // Said once per credential in the progress too, under where to create it.
    expect(r.stderr).toContain("  pick:      A test-mode restricted key");
    expect(r.stderr).toContain("  Sponson calls Stripe with this key; it is not your app's STRIPE_KEY or STRIPE_WEBHOOK_SECRET.");
    expect(r.stdout + r.stderr).not.toContain("sk_test_value-never-read");
    // The JSON has no "above": the reason names each credential and how it stands.
    expect(report.setup.next.why).not.toMatch(/above|below/);
    expect(report.setup.next).toEqual({ command: null, why: "Fix the credential that did not check ok (Vercel: unauthorized), then run `sponson init --setup` again and `sponson plan`." });
    await expectNoLeak(r, cwd);
  });

  it("gh's failure text is masked: a gh that echoes the value prints [REDACTED]", async () => {
    const s = await sim();
    const gh = await fakeGh();
    const cwd = await appRepo();
    await writeFile(join(cwd, "release.plan.yaml"), "version: 1\nproviders:\n  vercel: { project: prj_demo }\nchanges:\n  - { id: env, adapter: vercel, op: env, target: preview, values: { A: x } }\n");
    const env = { ...simEnv(s, { tokens: false }), VERCEL_TOKEN: TOKENS.VERCEL_TOKEN, PATH: `${gh.bin}:${process.env.PATH}`, FAKE_GH_LOG: gh.log, FAKE_GH_FAIL: "1" };

    const r = await setup(cwd, env, undefined, "--yes");

    expect((await gh.calls())[0]!.stdin).toBe(TOKENS.VERCEL_TOKEN);
    expect(r.stdout).toContain("VERCEL_TOKEN: not stored: gh exited with 1: HTTP 403: could not set [REDACTED]");
    expect(r.stdout).toContain("Workflow: wrote .github/workflows/sponson.yml");
    await expectNoLeak(r, cwd);
  });

  it("without a terminal or --yes: tokens missing from the environment are reported with where to create them, nothing is stored or written", async () => {
    const s = await sim();
    const gh = await fakeGh();
    const cwd = await appRepo();
    const env = { ...simEnv(s, { tokens: false }), NEON_API_KEY: TOKENS.NEON_API_KEY, PATH: `${gh.bin}:${process.env.PATH}`, FAKE_GH_LOG: gh.log };

    const r = await setup(cwd, env, undefined, "--json");

    const report = JSON.parse(r.stdout) as { setup: { ready: boolean; next: { command: string | null; why: string }; credentials: Array<{ provider: string; status: string; url: string }>; secrets: Array<{ name: string; result: string }>; workflow: { result: string } } };
    expect(report.setup.ready).toBe(false);
    expect(report.setup.credentials.find((c) => c.provider === "vercel")).toMatchObject({ status: "missing", url: "https://vercel.com/account/tokens" });
    expect(report.setup.credentials.find((c) => c.provider === "neon")!.status).toBe("ok");
    expect(report.setup.secrets.find((x) => x.name === "NEON_API_KEY")!.result).toBe("not-asked");
    expect(report.setup.workflow.result).toBe("not-asked");
    // Nobody can type a token here: the advice is to set it in the environment, or to run setup where someone can.
    expect(r.stderr).toContain("missing: VERCEL_TOKEN (no terminal to ask in: set it in the environment this command runs with, or run `sponson init --setup` in an interactive terminal to type it)");
    expect(report.setup.next).toEqual({ command: "sponson init --setup", why: expect.stringMatching(/^Set VERCEL_TOKEN, .* in the environment it runs with/) });
    expect(await gh.calls()).toEqual([]);
    await expectNoLeak(r, cwd);
  });

  it("an origin that is not GitHub: secrets are skipped with the reason; --yes without --setup is a usage error", async () => {
    const s = await sim();
    const cwd = await appRepo();
    execFileSync("git", ["remote", "set-url", "origin", "https://gitlab.com/acme/web.git"], { cwd });
    const env = { ...simEnv(s), STRIPE_API_URL: `${s.url}/rest` };
    const r = await setup(cwd, env, undefined, "--json", "--yes");
    const report = JSON.parse(r.stdout) as { setup: { repo: null; secrets: Array<{ result: string }> } };
    expect(report.setup.repo).toBeNull();
    expect(new Set(report.setup.secrets.map((x) => x.result))).toEqual(new Set(["no-repo"]));

    let out = "";
    const code = await run(["init", "--yes", "--json"], { cwd, env, stdout: { write: (x: string) => void (out += x) } });
    expect(code).toBe(2);
    expect(JSON.parse(out).error.code).toBe("USAGE");
  });
});
