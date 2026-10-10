/**
 * schema/release.plan.schema.json is written by hand; this suite keeps it honest against the real parser
 * (packages/core/src/plan.ts):
 *
 *   1. every example plan and every plan the parser accepts in scenarios/ validates against the schema;
 *   2. every invalid plan in INVALID is rejected by both, so the structural rules a schema can express stay in parity;
 *   3. the rules a JSON Schema cannot express (CROSS_REFERENCE) are rejected by the parser and accepted by the
 *      schema. If one of these starts failing, the schema or the docs (docs/plan-format.md, "What the schema
 *      does not check") are out of date.
 */
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { parsePlan, isSponsonError } from "@sponson/core";
import { examplePlans, scenarioPlans, SCHEMA_PATH } from "./plans.js";

const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validate = ajv.compile(schema);

/** The plan as an editor's YAML language server sees it: plain JSON data, merge keys applied as the parser does. */
function data(source: string): unknown {
  return parseDocument(source, { merge: true }).toJS();
}

function schemaErrors(source: string): string[] {
  return validate(data(source)) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
}

function parserCode(source: string): string | null {
  try {
    parsePlan(source);
    return null;
  } catch (e) {
    if (isSponsonError(e)) return e.code;
    throw e;
  }
}

const HEAD = "version: 1\nproviders:\n  vercel: { project: prj_demo }\n  neon: { project: proj_demo }\nchanges:\n";

/** Invalid plans both the parser and the schema must reject: [why, plan, parser code]. */
const INVALID: Array<[string, string, string]> = [
  ["version is not 1", "version: 2\nchanges: []\n", "PLAN_INVALID"],
  ["version is missing", "changes: []\n", "PLAN_INVALID"],
  ["changes is missing", "version: 1\n", "PLAN_INVALID"],
  ["changes is not a list", "version: 1\nchanges: { id: db }\n", "PLAN_INVALID"],
  ["unknown receipt store", "version: 1\nreceipts: s3\nchanges: []\n", "PLAN_INVALID"],
  ["top-level environments is empty", "version: 1\nenvironments: []\nchanges: []\n", "PLAN_INVALID"],
  ["top-level environments is a string", "version: 1\nenvironments: preview\nchanges: []\n", "PLAN_INVALID"],
  ["a provider block is not a map", "version: 1\nproviders: { vercel: prj_demo }\nchanges: []\n", "PLAN_INVALID"],
  ["id has upper case", HEAD + "  - { id: DB, adapter: neon, op: branch }\n", "PLAN_INVALID"],
  ["id starts with a digit", HEAD + "  - { id: 1db, adapter: neon, op: branch }\n", "PLAN_INVALID"],
  ["id is missing", HEAD + "  - { adapter: neon, op: branch }\n", "PLAN_INVALID"],
  ["adapter is missing", HEAD + "  - { id: db, op: branch }\n", "PLAN_INVALID"],
  ["op is empty", HEAD + "  - { id: db, adapter: neon, op: '' }\n", "PLAN_INVALID"],
  ["line environments is a string", HEAD + "  - { id: db, adapter: neon, op: branch, environments: preview }\n", "PLAN_INVALID"],
  ["line environments is empty", HEAD + "  - { id: db, adapter: neon, op: branch, environments: [] }\n", "PLAN_INVALID"],
  ["depends_on holds a bad id", HEAD + "  - { id: db, adapter: neon, op: branch, depends_on: [Env] }\n", "PLAN_INVALID"],
  ["secret-looking name with a literal string", HEAD + "  - id: env\n    adapter: vercel\n    op: env\n    values: { STRIPE_SECRET_KEY: sk_live_abc }\n", "SECRET_LITERAL"],
  ["secret-looking name with a literal number", HEAD + "  - id: env\n    adapter: vercel\n    op: env\n    values: { ADMIN_PASSWORD: 84736291 }\n", "SECRET_LITERAL"],
  ["secret-looking name, lower case, in a plugin op", HEAD + "  - id: x\n    adapter: acme\n    op: thing\n    settings: { api_token: abc123 }\n", "SECRET_LITERAL"],
  ["secret-looking name as a line param", HEAD + "  - { id: x, adapter: acme, op: thing, PRIVATE: abcd }\n", "SECRET_LITERAL"],
  ["display text pasted back", HEAD + "  - id: env\n    adapter: vercel\n    op: env\n    values: { DATABASE_URL: \"(pending ← db.connection_string)\" }\n", "PLAN_INVALID"],
  ["display text pasted back, angle form", HEAD + "  - { id: x, adapter: acme, op: thing, value: \"<secret>\" }\n", "PLAN_INVALID"],
  ["from: without an output", HEAD + "  - { id: db, adapter: neon, op: branch }\n  - id: env\n    adapter: vercel\n    op: env\n    values: { DATABASE_URL: { from: db } }\n", "REF_UNKNOWN"],
  ["secret: that is not a URL", HEAD + "  - id: env\n    adapter: vercel\n    op: env\n    values: { STRIPE_SECRET_KEY: { secret: STRIPE_SECRET_KEY } }\n", "PLAN_INVALID"],
  ["secret: in a plugin op that is not a URL", HEAD + "  - { id: x, adapter: acme, op: thing, token: { secret: 'vault:abc' } }\n", "PLAN_INVALID"],
];

/** Invalid plans only the parser can reject: they need to compare values across the document. */
const CROSS_REFERENCE: Array<[string, string, string]> = [
  ["duplicate ids", HEAD + "  - { id: db, adapter: neon, op: branch }\n  - { id: db, adapter: neon, op: branch }\n", "PLAN_INVALID"],
  ["line environment not declared", "version: 1\nenvironments: [preview]\nchanges:\n  - { id: db, adapter: neon, op: branch, environments: [staging], name: x }\n", "PLAN_INVALID"],
  ["depends_on an unknown id", HEAD + "  - { id: db, adapter: neon, op: branch, depends_on: [nope] }\n", "REF_UNKNOWN"],
  ["from: an unknown id", HEAD + "  - id: env\n    adapter: vercel\n    op: env\n    values: { DATABASE_URL: { from: nope.connection_string } }\n", "REF_UNKNOWN"],
];

describe("schema/release.plan.schema.json", () => {
  it("is a valid draft 2020-12 schema", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  it("accepts every example plan", async () => {
    const plans = await examplePlans();
    expect(plans.length).toBeGreaterThanOrEqual(4);
    for (const p of plans) expect({ plan: p.name, errors: schemaErrors(p.source) }).toEqual({ plan: p.name, errors: [] });
  });

  it("accepts every scenario plan the parser accepts, and rejects the structurally invalid ones it rejects", async () => {
    const plans = await scenarioPlans();
    expect(plans.length).toBeGreaterThan(50);
    let rejected = 0;
    for (const p of plans) {
      const code = parserCode(p.source);
      if (code === null) expect({ plan: p.name, errors: schemaErrors(p.source) }).toEqual({ plan: p.name, errors: [] });
      else if (code !== "PLAN_PARSE" && !CROSS_REFERENCE_MESSAGE.test(parserMessage(p.source))) {
        rejected++;
        expect({ plan: p.name, rejected: schemaErrors(p.source).length > 0 }).toEqual({ plan: p.name, rejected: true });
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it.each(INVALID)("rejects, like the parser: %s", (_why, source, code) => {
    expect(parserCode(source)).toBe(code);
    expect(schemaErrors(source)).not.toEqual([]);
  });

  it.each(CROSS_REFERENCE)("leaves cross-references to the parser: %s", (_why, source, code) => {
    expect(parserCode(source)).toBe(code);
    expect(schemaErrors(source)).toEqual([]);
  });

  it("checks the parameters of the built-in ops", () => {
    const line = (body: string) => schemaErrors(HEAD + body);
    // A typo that the adapter would silently ignore.
    expect(line("  - { id: db, adapter: neon, op: branch, from: main }\n")).not.toEqual([]);
    expect(line("  - { id: env, adapter: vercel, op: env, target: staging }\n")).not.toEqual([]);
    expect(line("  - { id: env, adapter: vercel, op: env, target: \"${ctx.env}\" }\n")).toEqual([]);
    expect(line("  - { id: cb, adapter: clerk, op: redirect_allow }\n")).not.toEqual([]);
    expect(line("  - { id: d, adapter: vercel, op: deploy, target: preview }\n")).not.toEqual([]);
    // Plugin ops take any parameters.
    expect(line("  - { id: x, adapter: acme, op: thing, anything: [1, { nested: true }] }\n")).toEqual([]);
  });
});

/** Parser messages of the cross-reference rules (see CROSS_REFERENCE). */
const CROSS_REFERENCE_MESSAGE = /Duplicate change id|which is not declared|depends_on unknown id|references unknown id/;

function parserMessage(source: string): string {
  try {
    parsePlan(source);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}
