import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, verifyRecipeCredential, loadRecipe } from "@sponson/adapters";
import { isSponsonError } from "@sponson/core";
import { childEnv, ghSecretSet, githubRepoOf } from "./gh.js";
import { gatherNeeds } from "./setup.js";
import { NO_TERMINAL, processTerminal, type TtyStreams } from "./terminal.js";
import { ACTION_REPO, releaseTag, renderWorkflow, resolveTagCommit } from "./workflow.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sponson-setup-unit-"));
  dirs.push(d);
  return d;
}

/** A terminal's streams: stdin a TTY in raw mode or not, stderr capturing what is shown. */
function fakeTty(tty = true): { streams: TtyStreams; shown: () => string; type: (s: string) => void; raw: () => boolean[] } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  const modes: boolean[] = [];
  Object.assign(stdin, { isTTY: tty, setRawMode: (on: boolean) => (modes.push(on), stdin) });
  let shown = "";
  const stderr = { isTTY: tty, write: (s: string) => ((shown += s), true) } as unknown as NodeJS.WriteStream;
  return { streams: { stdin, stderr }, shown: () => shown, type: (s) => stdin.write(s), raw: () => modes };
}

describe("the terminal", () => {
  it("hidden input: nothing typed is shown, Backspace edits, Enter ends; raw mode is restored", async () => {
    const t = fakeTty();
    const term = processTerminal(t.streams);
    expect(term.interactive).toBe(true);
    const answer = term.secret("TOKEN: ");
    t.type("tok_secrex");
    t.type("\u007ft-value\r");
    expect(await answer).toBe("tok_secret-value");
    expect(t.shown()).toBe("TOKEN: \n");
    expect(t.raw()).toEqual([true, false]);
  });

  it("Ctrl-C cancels hidden input; Ctrl-D ends it", async () => {
    const t = fakeTty();
    const term = processTerminal(t.streams);
    const cancelled = term.secret("TOKEN: ");
    t.type("abc\u0003");
    await expect(cancelled).rejects.toThrow("cancelled");
    const ended = term.secret("TOKEN: ");
    t.type("xyz\u0004");
    expect(await ended).toBe("xyz");
  });

  it("confirm: y and yes are yes, anything else no", async () => {
    const t = fakeTty();
    const term = processTerminal(t.streams);
    const a = term.confirm("Store?");
    t.type("yes\n");
    expect(await a).toBe(true);
    const b = term.confirm("Store?");
    t.type("n\n");
    expect(await b).toBe(false);
    expect(t.shown()).toBe("Store? [y/N] Store? [y/N] ");
  });

  it("not a TTY, or nobody: never interactive", async () => {
    expect(processTerminal(fakeTty(false).streams).interactive).toBe(false);
    expect(NO_TERMINAL.interactive).toBe(false);
    await expect(NO_TERMINAL.secret("x")).rejects.toThrow();
    await expect(NO_TERMINAL.confirm("x")).rejects.toThrow();
  });
});

describe("gh", () => {
  it("githubRepoOf: https, ssh and scp-like GitHub remotes; nothing else", () => {
    expect(githubRepoOf("https://github.com/acme/web.git")).toBe("acme/web");
    expect(githubRepoOf("https://x-access-token:abc@github.com/acme/web")).toBe("acme/web");
    expect(githubRepoOf("git@github.com:acme/web.git")).toBe("acme/web");
    expect(githubRepoOf("ssh://git@github.com/acme/my.repo.git")).toBe("acme/my.repo");
    expect(githubRepoOf("https://gitlab.com/acme/web.git")).toBeNull();
    expect(githubRepoOf("/tmp/bare")).toBeNull();
    expect(githubRepoOf(null)).toBeNull();
  });

  it("childEnv drops the collected variables", () => {
    expect(childEnv({ A: "1", TOKEN: "t", PATH: "/bin" }, ["TOKEN"])).toEqual({ A: "1", PATH: "/bin" });
  });

  it("gh secret set: the value on stdin, not in argv; a gh that is not installed is gh-missing", async () => {
    const bin = await temp();
    const log = join(bin, "log.json");
    await writeFile(join(bin, "gh"), `#!${process.execPath}\nlet s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),stdin:s})));\n`);
    await chmod(join(bin, "gh"), 0o755);
    expect(await ghSecretSet("TOKEN", "tok-value", "acme/web", { PATH: `${bin}:${process.env.PATH}` }, bin)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(log, "utf8"))).toEqual({ argv: ["secret", "set", "TOKEN", "--repo", "acme/web"], stdin: "tok-value" });

    const missing = await ghSecretSet("TOKEN", "tok-value", "acme/web", { PATH: bin.replace(/$/, "/nothing-here") }, bin);
    expect(missing).toMatchObject({ ok: false, reason: "gh-missing" });
    expect(JSON.stringify(missing)).not.toContain("tok-value");
  });
});

describe("the workflow", () => {
  it("pins the action to the tag's commit, reads every variable from secrets, notes CLI logins", () => {
    const text = renderWorkflow({ variables: ["VERCEL_TOKEN", "NEON_API_KEY"], commit: "a".repeat(40), tag: releaseTag("1.2.3"), commandNotes: ["Google Cloud Run authenticates with `gcloud auth print-access-token`"] });
    expect(text).toContain(`uses: ${ACTION_REPO}/action@${"a".repeat(40)} # sponson@1.2.3`);
    expect(text).toContain("      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    expect(text).toContain("    # Google Cloud Run authenticates");
    const unpinned = renderWorkflow({ variables: [], commit: null, tag: "sponson@1.2.3", commandNotes: [] });
    expect(unpinned).toContain("action@<commit-sha> # TODO: the commit of tag sponson@1.2.3");
    expect(unpinned).toContain("# no provider variables");
  });

  it("is action/README.md's preview job, with this plan's variables and a pinned action", async () => {
    const readme = await readFile(new URL("../../../action/README.md", import.meta.url), "utf8");
    const example = /## Example workflow[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)![1]!;
    const previewJob = example.slice(example.indexOf("  preview:"), example.indexOf("  production:")).trimEnd();
    const ours = renderWorkflow({ variables: ["NEON_API_KEY", "VERCEL_TOKEN", "CLERK_SECRET_KEY"], commit: "<commit-sha>", tag: "x", commandNotes: [] });
    const job = ours.slice(ours.indexOf("  preview:")).replaceAll("<commit-sha> # x", "<commit-sha>").trimEnd();
    expect(job).toBe(previewJob);
    // The triggers and permissions the preview job needs are the README's too (production's push and actions: read aside).
    for (const line of ["  pull_request:", "    types: [opened, synchronize, closed]", "  deployment_status:", "  contents: write", "  pull-requests: write", "  deployments: read"]) expect(ours).toContain(`${line}\n`);
  });

  it("resolveTagCommit: null when the repository or the tag cannot be read", async () => {
    const dir = await temp();
    expect(await resolveTagCommit("sponson@0.0.0", { ...process.env, SPONSON_ACTION_REPO: join(dir, "none") }, dir)).toBeNull();
  });
});

describe("what a plan needs", () => {
  const plan = (text: string) => async () => {
    const dir = await temp();
    await writeFile(join(dir, "release.plan.yaml"), text);
    return gatherNeeds(join(dir, "release.plan.yaml"), createRegistry(), []);
  };

  it("adapters, a recipe API, a hand-written API, a CLI login and the values the plan references, in order; placeholders dropped", async () => {
    const needs = await plan(
      [
        "version: 1",
        "providers:",
        '  neon: { project: "proj_xxx" }   # TODO: run `neonctl projects list`',
        "  http:",
        "    acme: { base_url: https://api.acme.dev, auth: { bearer_env: ACME_TOKEN } }",
        "  cloud_run: { project: p, region: r }",
        "changes:",
        "  - { id: db, adapter: neon, op: branch }",
        "  - { id: hook, adapter: http, op: resource, recipe: stripe.webhook_endpoint, name: n, url: https://x.dev/hook }",
        "  - { id: thing, adapter: http, op: resource, api: acme, path: /things, body: { key: { secret: 'env://ACME_KEY' } }, key: x }",
        "  - { id: run, adapter: cloud_run, op: revision, service: web, tag: pr }",
        "  - { id: step, adapter: manual, op: step, title: t, instructions: i }",
      ].join("\n"),
    )();
    expect(needs.map((n) => [n.provider, n.variables, Boolean(n.verify), n.command ?? null])).toEqual([
      ["neon", ["NEON_API_KEY"], true, null],
      ["stripe", ["STRIPE_SECRET_KEY"], true, null],
      ["http.acme", ["ACME_TOKEN"], false, null],
      ["cloud_run", [], false, ["gcloud", "auth", "print-access-token"]],
      ["plan", ["ACME_KEY"], false, null],
    ]);
    expect(needs[0]!.url).toBe("https://neon.com/docs/manage/api-keys");
  });

  it("the provider block without its placeholders: the check reads the account, not proj_xxx", async () => {
    const [neon] = await plan('version: 1\nproviders:\n  neon: { project: "proj_xxx" }   # TODO: fill in\nchanges:\n  - { id: db, adapter: neon, op: branch }\n')();
    let path = "";
    const fetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      path = new URL(url).pathname;
      return Promise.resolve(new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
    try {
      const r = await neon!.verify!({ ctx: { env: "preview", git: { branch: "b", sha: "s", short_sha: "s" }, pr: { number: null }, scope: "s" }, provider: {}, env: { NEON_API_KEY: "k-value", NEON_API_URL: "https://neon.test/api/v2" }, log: () => {}, intend: () => Promise.resolve(), redact: (t) => t });
      expect(r).toEqual({ request: "GET /projects", reaches: "account" });
      expect(path).toBe("/api/v2/projects");
    } finally {
      globalThis.fetch = fetch;
    }
  });
});

describe("a recipe's credential check", () => {
  it("a per-account API without its base URL in the plan cannot be checked: PLAN_INVALID naming the block", async () => {
    const actx = { ctx: { env: "preview", git: { branch: "b", sha: "s", short_sha: "s" }, pr: { number: null }, scope: "s" }, provider: {}, env: { OKTA_API_TOKEN: "t-value" }, log: () => {}, intend: () => Promise.resolve(), redact: (t: string) => t };
    const e = await verifyRecipeCredential(loadRecipe("okta"), "okta", {}, actx).catch((x: unknown) => x);
    expect(isSponsonError(e) && e.code).toBe("PLAN_INVALID");
    expect(String((e as Error).message)).toContain("providers.http.okta");
  });

  it("a recipe without a verify request is refused", async () => {
    const actx = { ctx: { env: "preview", git: { branch: "b", sha: "s", short_sha: "s" }, pr: { number: null }, scope: "s" }, provider: {}, env: {}, log: () => {}, intend: () => Promise.resolve(), redact: (t: string) => t };
    await expect(verifyRecipeCredential(loadRecipe("heroku"), "heroku", {}, actx)).rejects.toThrow("declares no credential.verify");
  });

  it("every recipe with an API block says where its credential is created", () => {
    for (const name of ["stripe", "auth0", "heroku", "s3", "railway"]) expect(loadRecipe(name).credential?.url, name).toMatch(/^https:\/\//);
  });
});
