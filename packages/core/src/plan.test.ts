import { describe, expect, it } from "vitest";
import { interpolate, scopeFor } from "./ctx.js";
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
