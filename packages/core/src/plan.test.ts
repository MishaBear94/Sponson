import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCtx, interpolate, scopeFor } from "./ctx.js";
import { orderChanges } from "./graph.js";
import { changesFor, dependenciesOf, parsePlan } from "./plan.js";
import { Redactor } from "./redact.js";
import type { Ctx } from "./types.js";

const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc1234def", short_sha: "abc1234" }, pr: { number: 42 }, scope: "pr-42" };

function plan(body: string) {
  return parsePlan(`version: 1\nchanges:\n${body}`);
}

describe("parsePlan", () => {
  it("separates reserved keys from adapter params", () => {
    const { plan: p } = plan(`  - id: db\n    adapter: neon\n    op: branch\n    parent: main\n    environments: [preview]\n`);
    expect(p.changes[0]).toMatchObject({ id: "db", adapter: "neon", op: "branch", environments: ["preview"], params: { parent: "main" } });
    expect(p.environments).toEqual(["preview", "production"]);
    expect(p.receipts).toBe("git-branch");
    expect(p.hash).toHaveLength(64);
  });

  it("rejects duplicate ids", () => {
    expect(() => plan(`  - { id: a, adapter: x, op: y }\n  - { id: a, adapter: x, op: y }\n`)).toThrow(/Duplicate change id/);
  });

  it("rejects environments written as a string with a helpful message", () => {
    expect(() => plan(`  - { id: a, adapter: x, op: y, environments: preview }\n`)).toThrow(/environments must be a list/);
  });

  it("rejects references to unknown ids and references without an output", () => {
    expect(() => plan(`  - { id: a, adapter: x, op: y, v: { from: nope.id } }\n`)).toThrow(/unknown id `nope`/);
    expect(() => plan(`  - { id: a, adapter: x, op: y }\n  - { id: b, adapter: x, op: y, v: { from: a } }\n`)).toThrow(/must name an output/);
  });

  it("rejects secret-looking literals and tells the agent what to write instead", () => {
    expect(() => plan(`  - { id: a, adapter: vercel, op: env, values: { STRIPE_KEY: fake_lv_123 } }\n`)).toThrow(/looks like a secret.*env:\/\/STRIPE_KEY/);
    expect(() => plan(`  - { id: a, adapter: vercel, op: env, values: { STRIPE_KEY: { secret: "env://STRIPE_KEY" } } }\n`)).not.toThrow();
  });

  it("rejects display text pasted back as a value", () => {
    expect(() => plan(`  - { id: a, adapter: x, op: y, v: "(pending ← db.connection_string)" }\n`)).toThrow(/display text/);
  });

  it("rejects secret references that are not URLs", () => {
    expect(() => plan(`  - { id: a, adapter: x, op: y, v: { secret: "TOKEN" } }\n`)).toThrow(/must be a URL/);
  });

  it("rejects undeclared environments on a line", () => {
    expect(() => parsePlan(`version: 1\nenvironments: [preview]\nchanges:\n  - { id: a, adapter: x, op: y, environments: [staging] }\n`)).toThrow(/not declared/);
  });

  it("warns on YAML anchors but accepts them", () => {
    const { warnings } = parsePlan(`version: 1\nchanges:\n  - &base { id: a, adapter: x, op: y }\n  - { <<: *base, id: b }\n`);
    expect(warnings[0]?.code).toBe("YAML_ANCHOR");
  });

  it("reports YAML syntax errors as PLAN_PARSE", () => {
    expect(() => parsePlan("version: 1\nchanges: [")).toThrow(expect.objectContaining({ code: "PLAN_PARSE" }));
  });

  it("filters by environment", () => {
    const { plan: p } = plan(`  - { id: a, adapter: x, op: y, environments: [preview] }\n  - { id: b, adapter: x, op: y, environments: [production] }\n  - { id: c, adapter: x, op: y }\n`);
    expect(changesFor(p, "preview").map((c) => c.id)).toEqual(["a", "c"]);
    expect(changesFor(p, "production").map((c) => c.id)).toEqual(["b", "c"]);
  });
});

describe("graph", () => {
  it("orders by references and explicit depends_on", () => {
    const { plan: p } = plan(`  - { id: c, adapter: x, op: y, v: { from: b.id } }\n  - { id: b, adapter: x, op: y, depends_on: [a] }\n  - { id: a, adapter: x, op: y }\n`);
    expect(dependenciesOf(p.changes[0]!)).toEqual(["b"]);
    expect(orderChanges(p.changes, p.changes).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("names the cycle", () => {
    const { plan: p } = plan(`  - { id: a, adapter: x, op: y, v: { from: b.id } }\n  - { id: b, adapter: x, op: y, v: { from: a.id } }\n`);
    expect(() => orderChanges(p.changes, p.changes)).toThrow(/a → b → a|b → a → b/);
  });

  it("explains references into a filtered-out line", () => {
    const { plan: p } = plan(`  - { id: a, adapter: x, op: y, environments: [production] }\n  - { id: b, adapter: x, op: y, v: { from: a.id } }\n`);
    expect(() => orderChanges(changesFor(p, "preview"), p.changes)).toThrow(/filtered out of this environment.*environments: \[production\]/);
  });
});

describe("ctx", () => {
  it("interpolates ctx variables", () => {
    expect(interpolate({ name: "br-${ctx.pr.number}-${ctx.git.short_sha}", nested: ["${ctx.env}"] }, ctx, "t")).toEqual({ name: "br-42-abc1234", nested: ["preview"] });
  });

  it("explains null and unknown variables", () => {
    expect(() => interpolate("x-${ctx.pr.number}", { ...ctx, pr: { number: null } }, "line `db`")).toThrow(/is null here.*--pr/);
    expect(() => interpolate("${ctx.nope}", ctx, "t")).toThrow(/unknown context variable/);
  });

  it("derives scopes", () => {
    expect(scopeFor("feat/x", 42)).toBe("pr-42");
    expect(scopeFor("main", null)).toBe("main");
    expect(scopeFor("feat/x y", null)).toBe("branch-feat-x-y");
    expect(scopeFor("trunk", null, "trunk")).toBe("main");
  });
});

describe("detectCtx", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const notARepo = () => mkdtemp(join(tmpdir(), "sponson-ctx-"));

  it("a push to main in GitHub Actions (GITHUB_HEAD_REF empty) is scope main", async () => {
    const dir = await notARepo();
    const event = join(dir, "event.json");
    await writeFile(event, JSON.stringify({ ref: "refs/heads/main", after: SHA, repository: { default_branch: "main" } }));
    const c = await detectCtx({ env: "production" }, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_HEAD_REF: "", GITHUB_SHA: SHA }, dir);
    expect(c).toMatchObject({ env: "production", scope: "main", git: { branch: "main", sha: SHA }, pr: { number: null } });
  });

  it("a push to a non-`main` default branch is scope main", async () => {
    const dir = await notARepo();
    const event = join(dir, "event.json");
    await writeFile(event, JSON.stringify({ ref: "refs/heads/trunk", repository: { default_branch: "trunk" } }));
    const c = await detectCtx({}, { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: event, GITHUB_REF_NAME: "trunk", GITHUB_HEAD_REF: "", GITHUB_SHA: SHA }, dir);
    expect(c.scope).toBe("main");
  });

  it("empty SPONSON_CTX_* and CI variables are unset, not values", async () => {
    const c = await detectCtx({}, { SPONSON_CTX_ENV: "", SPONSON_CTX_BRANCH: " ", SPONSON_CTX_SHA: "", SPONSON_CTX_PR: "", GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "feat/y", GITHUB_SHA: SHA }, await notARepo());
    expect(c).toMatchObject({ env: "preview", scope: "branch-feat-y", git: { branch: "feat/y", sha: SHA }, pr: { number: null } });
  });

  it("pull_request events take the head ref and the PR number", async () => {
    const c = await detectCtx({}, { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/7/merge", GITHUB_REF_NAME: "7/merge", GITHUB_HEAD_REF: "feat/z", GITHUB_SHA: SHA }, await notARepo());
    expect(c).toMatchObject({ scope: "pr-7", git: { branch: "feat/z" } });
  });

  it("an invalid SPONSON_CTX_PR is an error, not NaN", async () => {
    await expect(detectCtx({ branch: "b", sha: SHA }, { SPONSON_CTX_PR: "abc" }, await notARepo())).rejects.toMatchObject({ code: "CTX_NULL" });
  });
});

describe("redactor", () => {
  it("masks registered values, longest first", () => {
    const r = new Redactor();
    r.register("abcd");
    r.register("abcdefg");
    expect(r.redact("x abcdefg y abcd z")).toBe("x [REDACTED] y [REDACTED] z");
    expect(r.leaks("abcd")).toEqual(["abcd"]);
  });

  it("ignores values too short to be secrets", () => {
    const r = new Redactor();
    r.register("ab");
    expect(r.redact("ab")).toBe("ab");
  });
});
