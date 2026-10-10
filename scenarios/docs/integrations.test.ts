/**
 * The copy-paste integrations under integrations/ cannot be run on their hosts from here, so this suite checks what
 * can be checked without GitLab, CircleCI, Bitbucket or the agent tools:
 *
 *   - every CI template parses as YAML (anchors and aliases resolved), and has the shape its host expects: for GitLab
 *     a JSON Schema of the keys the template uses (stages, jobs, rules, environments) plus the cross-references a
 *     schema cannot express (a job's stage is declared, `on_stop` names a manual stop job of the same environment);
 *     for CircleCI every job, executor and command a workflow names exists; for Bitbucket the pipeline kinds exist;
 *   - every `npx -y sponson@<version> …` line in a template pins one exact version and, with the host's variables
 *     expanded the way the shell would, runs through the real CLI (in an empty plan, offline) to the expected scope;
 *     and the same line without `--pr/--branch/--sha` reaches the same scope through detection of the host's
 *     variables (packages/cli/src/detect.ts), so the template and the detection agree;
 *   - every JSON and TOML block in integrations/agents/README.md parses and its server runs `sponson mcp`.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { run } from "sponson";
import { mapLines } from "../../scripts/gen-site.js";
import { REPO } from "./plans.js";

const read = (path: string) => readFile(join(REPO, path), "utf8");

async function yamlOf(path: string): Promise<Record<string, any>> {
  const doc = parseDocument(await read(path));
  expect(doc.errors.map((e) => e.message), path).toEqual([]);
  expect(doc.warnings.map((e) => e.message), path).toEqual([]);
  return doc.toJS({ maxAliasCount: 100 }) as Record<string, any>;
}

// ---------------------------------------------------------------------------------------------------------------
// Sponson command lines in a template

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";

/** Every string in a parsed YAML tree, split into lines. */
function lines(node: unknown): string[] {
  if (typeof node === "string") return node.split("\n");
  if (Array.isArray(node)) return node.flatMap(lines);
  if (node && typeof node === "object") return Object.values(node).flatMap(lines);
  return [];
}

interface Invocation {
  version: string;
  args: string;
}

function invocations(tree: unknown): Invocation[] {
  return lines(tree).flatMap((l) => {
    const m = /npx -y sponson@(\S+) (.*)$/.exec(l.trim());
    return m ? [{ version: m[1]!, args: m[2]! }] : [];
  });
}

// `$NAME`, `${NAME}`, `${NAME:-WORD}` and `${NAME##*/}`, as a POSIX shell expands them (unset is empty).
function expand(s: string, env: Record<string, string>): string {
  return s.replace(/\$\{(\w+)(:-[^}]*|##\*\/)?\}|\$(\w+)/g, (_m, braced: string | undefined, op: string | undefined, bare: string | undefined) => {
    const v = env[(braced ?? bare)!] ?? "";
    if (op === "##*/") return v.replace(/^.*\//, "");
    if (op?.startsWith(":-")) return v === "" ? expand(op.slice(2), env) : v;
    return v;
  });
}

/** Split a command line into words (double quotes group, and are removed), expanding variables inside them. */
function words(args: string, env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/"([^"]*)"|(\S+)/g)) out.push(expand(m[1] ?? m[2]!, env));
  return out;
}

const SCOPE_FLAGS = new Set(["--pr", "--branch", "--sha"]);

function withoutScopeFlags(argv: string[]): string[] {
  return argv.filter((w, i) => !SCOPE_FLAGS.has(w) && !SCOPE_FLAGS.has(argv[i - 1] ?? ""));
}

const PLAN = "version: 1\nenvironments: [preview, production]\nreceipts: local\nchanges: []\n";

/** Run the CLI in an empty plan, offline, with `env` as its whole environment; returns the scope and the commit. */
async function scopeOf(argv: string[], env: Record<string, string>): Promise<{ code: number; scope: string; sha?: string; out: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "sponson-integration-"));
  await writeFile(join(cwd, "release.plan.yaml"), PLAN);
  let out = "";
  const code = await run([...argv, "--json"], { cwd, env, stdout: { write: (s: string) => (out += s) }, stderr: { write: () => true }, color: false });
  const json = JSON.parse(out) as { scope?: string; receipt?: { scope: string; ctx: { git: { sha: string } } } };
  return { code, scope: json.scope ?? json.receipt?.scope ?? "", sha: json.receipt?.ctx.git.sha, out };
}

interface Host {
  template: string;
  /** The variables of a pull request pipeline (and of a destroy pipeline started for that PR). */
  preview: Record<string, string>;
  /** The variables of a pipeline on the default branch. */
  production: Record<string, string>;
  /** Invocations whose PR comes from a pipeline parameter rather than the host: detection cannot know it. */
  parameterised?: RegExp;
  expectedSha: string;
}

const HOSTS: Host[] = [
  {
    template: "integrations/gitlab/gitlab-ci.yml",
    preview: {
      GITLAB_CI: "true", CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_IID: "12",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feat/x", CI_COMMIT_REF_NAME: "feat/x",
      // a merged-results pipeline: CI_COMMIT_SHA is the synthetic merge commit, the source head is what deploys
      CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: HEAD, CI_COMMIT_SHA: SHA, CI_DEFAULT_BRANCH: "main",
    },
    production: { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "main", CI_COMMIT_REF_NAME: "main", CI_COMMIT_SHA: HEAD, CI_DEFAULT_BRANCH: "main", GITLAB_USER_LOGIN: "alice" },
    expectedSha: HEAD,
  },
  {
    template: "integrations/circleci/config.yml",
    preview: { CIRCLECI: "true", CIRCLE_PULL_REQUEST: "https://github.com/acme/app/pull/12", CIRCLE_BRANCH: "feat/x", CIRCLE_SHA1: HEAD, DESTROY_PR: "12", DESTROY_BRANCH: "feat/x" },
    production: { CIRCLECI: "true", CIRCLE_BRANCH: "main", CIRCLE_SHA1: HEAD, SPONSON_APPROVED_BY: "alice" },
    parameterised: /DESTROY_PR/,
    expectedSha: HEAD,
  },
  {
    template: "integrations/bitbucket/bitbucket-pipelines.yml",
    preview: { BITBUCKET_BUILD_NUMBER: "7", BITBUCKET_PR_ID: "12", BITBUCKET_BRANCH: "feat/x", BITBUCKET_COMMIT: HEAD, SPONSON_PR_ID: "12", SPONSON_PR_BRANCH: "feat/x" },
    production: { BITBUCKET_BUILD_NUMBER: "8", BITBUCKET_BRANCH: "main", BITBUCKET_COMMIT: HEAD, BITBUCKET_STEP_TRIGGERER_UUID: "{0f1e2d3c-0000-4000-8000-000000000000}" },
    parameterised: /SPONSON_PR_ID/,
    expectedSha: HEAD,
  },
];

describe.each(HOSTS.map((h) => [h.template, h] as const))("%s", (template, host) => {
  it("pins one exact Sponson version, and every command names its environment and scope", async () => {
    const calls = invocations(await yamlOf(template));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls.map((c) => c.version)).size).toBe(1);
    expect(calls[0]!.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const c of calls) {
      expect(c.args, c.args).toMatch(/^(plan|apply) /);
      for (const flag of ["--env", "--pr", "--branch", "--sha"]) expect(c.args, `${c.args} has ${flag}`).toContain(`${flag} `);
    }
    // destroy, the deploy barrier and production are all covered
    expect(calls.some((c) => c.args.includes("--destroy"))).toBe(true);
    expect(calls.some((c) => c.args.includes("--wait"))).toBe(true);
    expect(calls.some((c) => c.args.includes("--env production"))).toBe(true);
  });

  it("points the receipts store at a remote it can push to", async () => {
    // (CircleCI writes the export into $BASH_ENV, so its quotes are escaped.)
    expect(await read(template)).toMatch(/export SPONSON_RECEIPTS_REMOTE=\\?"(https:\/\/|\$\{CI_SERVER_PROTOCOL\}:\/\/)\w[\w-]*:\$\{SPONSON_\w+_TOKEN\}@/);
  });

  it("every command runs through the CLI to the expected scope, with the flags and through detection alike", async () => {
    for (const call of invocations(await yamlOf(template))) {
      const production = call.args.includes("--env production");
      const env = production ? host.production : host.preview;
      const argv = words(call.args, env);
      const flagged = await scopeOf(argv, env);
      expect(flagged.code, `${call.args}\n${flagged.out}`).toBe(0);
      expect(flagged.scope, call.args).toBe(production ? "main" : "pr-12");
      if (flagged.sha !== undefined && !host.parameterised?.test(call.args)) expect(flagged.sha, call.args).toBe(host.expectedSha);
      if (host.parameterised?.test(call.args)) continue;
      const detected = await scopeOf(withoutScopeFlags(argv), env);
      expect({ scope: detected.scope, sha: detected.sha }, `${call.args} without --pr/--branch/--sha`).toEqual({ scope: flagged.scope, sha: flagged.sha });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GitLab: structure

const ruleSchema = {
  type: "object",
  properties: {
    if: { type: "string" },
    when: { enum: ["on_success", "manual", "never", "always", "delayed"] },
    allow_failure: { type: "boolean" },
    changes: {},
    exists: {},
    variables: { type: "object" },
  },
  additionalProperties: false,
};

/** The subset of GitLab's CI schema the template uses; an unknown key or a misspelt one fails. */
const GITLAB_SCHEMA = {
  type: "object",
  required: ["stages"],
  properties: {
    workflow: { type: "object", required: ["rules"], properties: { rules: { type: "array", items: ruleSchema } }, additionalProperties: false },
    stages: { type: "array", minItems: 1, items: { type: "string" }, uniqueItems: true },
    variables: { type: "object", additionalProperties: { type: "string" } },
    default: { type: "object" },
    include: {},
  },
  additionalProperties: {
    type: "object",
    properties: {
      extends: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      stage: { type: "string" },
      image: { type: "string" },
      variables: { type: "object", additionalProperties: { type: "string" } },
      before_script: { type: "array", items: { type: "string" } },
      script: { type: "array", minItems: 1, items: { type: "string" } },
      after_script: { type: "array", items: { type: "string" } },
      rules: { type: "array", minItems: 1, items: ruleSchema },
      environment: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          action: { enum: ["start", "prepare", "stop", "verify", "access"] },
          on_stop: { type: "string" },
          url: { type: "string" },
          auto_stop_in: { type: "string" },
          deployment_tier: { enum: ["production", "staging", "testing", "development", "other"] },
        },
        additionalProperties: false,
      },
      interruptible: { type: "boolean" },
      allow_failure: { type: "boolean" },
      when: { enum: ["on_success", "manual", "never", "always", "delayed", "on_failure"] },
      needs: { type: "array" },
      resource_group: { type: "string" },
      timeout: { type: "string" },
    },
    additionalProperties: false,
  },
};

const RESERVED = new Set(["workflow", "stages", "variables", "default", "include"]);

/** A job with its `extends` chain merged in (GitLab merges hashes deeply; the template only extends one level of keys). */
function resolved(ci: Record<string, any>, name: string): Record<string, any> {
  const job = ci[name] as Record<string, any>;
  const parents = job.extends === undefined ? [] : ([] as string[]).concat(job.extends);
  return Object.assign({}, ...parents.map((p) => resolved(ci, p)), job);
}

const gitlab = await yamlOf("integrations/gitlab/gitlab-ci.yml");
const circleci = await yamlOf("integrations/circleci/config.yml");
const bitbucket = await yamlOf("integrations/bitbucket/bitbucket-pipelines.yml");
const agentsReadme = await read("integrations/agents/README.md");

describe("integrations/gitlab/gitlab-ci.yml structure", () => {
  const ci = gitlab;
  const jobs = Object.keys(ci).filter((k) => !RESERVED.has(k) && !k.startsWith("."));

  it("matches the schema of the keys it uses", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    const validate = ajv.compile(GITLAB_SCHEMA);
    expect(validate(ci) ? [] : validate.errors).toEqual([]);
  });

  it("every job has a declared stage, a script and rules", () => {
    for (const name of jobs) {
      const job = resolved(ci, name);
      expect(ci.stages, `${name}.stage`).toContain(job.stage);
      expect(job.script, `${name}.script`).toBeDefined();
      expect(job.rules, `${name}.rules`).toBeDefined();
      for (const parent of ([] as string[]).concat(ci[name].extends ?? [])) expect(ci, `${name} extends ${parent}`).toHaveProperty([parent]);
    }
  });

  it("the review environment's on_stop names a manual stop job of the same environment", () => {
    const starters = jobs.filter((n) => resolved(ci, n).environment?.on_stop);
    expect(starters.length).toBeGreaterThan(0);
    for (const name of starters) {
      const env = resolved(ci, name).environment;
      const stop = resolved(ci, env.on_stop);
      expect(stop.environment, `${env.on_stop}.environment`).toEqual({ name: env.name, action: "stop" });
      expect(stop.rules.every((r: { when?: string }) => r.when === "manual"), `${env.on_stop} is manual`).toBe(true);
      expect(stop.script.join("\n")).toContain("apply --destroy");
      expect(resolved(ci, name).rules).toEqual(stop.rules.map(({ if: cond }: { if: string }) => ({ if: cond })));
    }
  });

  it("merge request jobs run only in merge request pipelines; production is manual on the default branch", () => {
    for (const name of jobs) {
      const job = resolved(ci, name);
      const script = job.script.join("\n");
      if (script.includes("CI_MERGE_REQUEST_IID")) {
        expect(job.rules.map((r: { if: string }) => r.if), name).toEqual(['$CI_PIPELINE_SOURCE == "merge_request_event"']);
      }
      if (script.includes("--env production")) {
        expect(job.rules, name).toEqual([{ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", when: "manual" }]);
        expect(script, name).toContain("--approved-by");
        expect(job.environment?.name, name).toBe("production");
      }
      // An apply that GitLab's auto-cancel could kill half way would leave the scope to the next run.
      if (/\bapply\b/.test(script)) expect(job.interruptible, `${name}.interruptible`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CircleCI and Bitbucket: structure

describe("integrations/circleci/config.yml structure", () => {
  const ci = circleci;

  it("is config version 2.1 and every job, executor and command it names exists", () => {
    expect(ci.version).toBe(2.1);
    const commands = new Set(Object.keys(ci.commands));
    for (const [name, job] of Object.entries<Record<string, any>>(ci.jobs)) {
      expect(ci.executors, `${name}.executor`).toHaveProperty([job.executor]);
      for (const step of job.steps as unknown[]) {
        const stepName = typeof step === "string" ? step : Object.keys(step as object)[0]!;
        expect(["checkout", "run", "add_ssh_keys", ...commands], `${name}: step ${stepName}`).toContain(stepName);
      }
    }
    for (const [wf, def] of Object.entries<Record<string, any>>(ci.workflows)) {
      for (const entry of def.jobs as unknown[]) {
        const [jobName, opts] = typeof entry === "string" ? [entry, {}] : Object.entries(entry as Record<string, Record<string, unknown>>)[0]!;
        if (opts.type === "approval") continue;
        expect(ci.jobs, `${wf}: ${jobName}`).toHaveProperty([jobName]);
      }
    }
  });

  it("every pipeline parameter it uses is declared", async () => {
    const text = await read("integrations/circleci/config.yml");
    for (const m of text.matchAll(/pipeline\.parameters\.([\w-]+)/g)) expect(ci.parameters, m[1]).toHaveProperty([m[1]!]);
  });
});

describe("integrations/bitbucket/bitbucket-pipelines.yml structure", () => {
  const bb = bitbucket;

  it("has only pipeline kinds Bitbucket knows, and every step has a name and a script", () => {
    expect(Object.keys(bb.pipelines).every((k) => ["default", "branches", "tags", "bookmarks", "pull-requests", "custom"].includes(k))).toBe(true);
    const steps = collectSteps(bb.pipelines);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const s of steps) {
      expect(typeof s.name).toBe("string");
      expect(Array.isArray(s.script) && s.script.length > 0, s.name).toBe(true);
    }
    const production = steps.find((s) => s.deployment === "production");
    expect(production).toMatchObject({ trigger: "manual" });
  });
});

function collectSteps(node: unknown): Array<Record<string, any>> {
  if (Array.isArray(node)) return node.flatMap(collectSteps);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.step && typeof o.step === "object") return [o.step as Record<string, any>];
    return Object.values(o).flatMap(collectSteps);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// Agent tools

/** Fenced blocks of a Markdown text, with their info string's language. */
function fencedBlocks(md: string): Array<{ lang: string; body: string }> {
  const out: Array<{ lang: string; body: string }> = [];
  let current: { lang: string; lines: string[] } | null = null;
  mapLines(md, (line, fenced) => {
    if (fenced && current === null) current = { lang: line.trim().replace(/^`{3,}/, "").split(/\s/)[0] ?? "", lines: [] };
    else if (fenced && /^\s*`{3,}\s*$/.test(line)) {
      out.push({ lang: current!.lang, body: current!.lines.join("\n") });
      current = null;
    } else if (current) current.lines.push(line);
    return line;
  });
  return out;
}

/**
 * The subset of TOML the Codex snippets use: `[table.path]` headers and `key = value` lines whose value is a
 * basic string or an array of them (both valid JSON). Anything else is a parse error, not a silent skip.
 */
function parseMiniToml(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  let table = root;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([\w.-]+)\]$/.exec(line);
    if (header) {
      table = root;
      for (const key of header[1]!.split(".")) table = table[key] ??= {};
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`not TOML this check understands: ${line}`);
    table[kv[1]!] = JSON.parse(kv[2]!);
  }
  return root;
}

/** The command line a server entry runs. */
function commandLine(server: { command?: unknown; args?: unknown }): string {
  expect(typeof server.command).toBe("string");
  expect(Array.isArray(server.args) && server.args.every((a) => typeof a === "string")).toBe(true);
  return [server.command as string, ...(server.args as string[])].join(" ");
}

describe("integrations/agents/README.md", () => {
  const md = agentsReadme;
  const blocks = fencedBlocks(md);

  it("every JSON and TOML block parses and runs `sponson mcp`", () => {
    const configs = blocks.filter((b) => b.lang === "json" || b.lang === "toml");
    expect(configs.length).toBeGreaterThanOrEqual(6);
    for (const b of configs) {
      const parsed = b.lang === "json" ? (JSON.parse(b.body) as Record<string, any>) : parseMiniToml(b.body);
      // Claude Code, Cursor, Windsurf: mcpServers; VS Code: servers; Codex: mcp_servers.
      const servers = parsed.mcpServers ?? parsed.servers ?? parsed.mcp_servers;
      expect(servers, b.body).toBeDefined();
      expect(Object.keys(servers)).toEqual(["sponson"]);
      expect(commandLine(servers.sponson), b.body).toMatch(/^npx -y sponson(@\d+\.\d+\.\d+)? mcp$/);
      if (parsed.servers) expect(servers.sponson.type).toBe("stdio");
    }
  });

  it("the one-line installs run the same command", () => {
    expect(md).toContain("claude mcp add sponson -- npx -y sponson mcp");
    expect(md).toContain("codex mcp add sponson -- npx -y sponson mcp");
  });

  it("no snippet carries a token value", () => {
    for (const b of blocks) expect(b.body, b.body).not.toMatch(/(TOKEN|KEY|SECRET)"\s*:\s*"(?!\$\{)/);
  });
});
