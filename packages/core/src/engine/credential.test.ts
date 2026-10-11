import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isSponsonError } from "../errors.js";
import { planRun, type RunOptions } from "./index.js";
import { parsePlan } from "../plan.js";
import { Redactor } from "../redact.js";
import { LocalReceiptStore } from "../receipts/local.js";
import { Registry } from "../registry.js";
import { FakeCloud } from "../testing/fake.js";
import type { Ctx, ResourceAdapter } from "../types.js";

// OpSpec.credentialInputs (ADR 0017, "Line credentials"): a param that carries a credential must be a reference whose
// value Sponson masks and later runs can resolve again. The engine checks it in prepare, before any provider call.

const ctx: Ctx = { env: "preview", git: { branch: "feat/x", sha: "abc1234def", short_sha: "abc1234" }, pr: { number: 42 }, scope: "pr-42" };

let cloud: FakeCloud;
let registry: Registry;
let store: LocalReceiptStore;

/** The fake `item` op, declaring its `credential` param as a credential. */
function withCredential(adapter: ResourceAdapter): ResourceAdapter {
  const item = adapter.ops.item!;
  return { name: "cred", ops: { item: { ...item, credentialInputs: (p) => (p.credential === undefined ? [] : ["credential"]) } } };
}

beforeEach(async () => {
  cloud = new FakeCloud();
  registry = new Registry().addAdapter(cloud.adapter()).addAdapter(withCredential(cloud.adapter()));
  store = new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-cred-")));
});

function opts(credential: string): RunOptions {
  const source = `
version: 1
changes:
  - id: producer
    adapter: fake
    op: item
    name: producer
    value: one
  - id: user
    adapter: cred
    op: item
    name: user
    value: two
    credential: ${credential}
`;
  return { plan: parsePlan(source).plan, ctx, registry, store, env: { CRED_TOKEN: "cred-token-0042" }, redactor: new Redactor() };
}

async function codeOf(credential: string): Promise<string> {
  try {
    await planRun(opts(credential));
    return "(no error)";
  } catch (e) {
    if (isSponsonError(e)) return `${e.code}: ${e.message}`;
    throw e;
  }
}

describe("credential inputs are checked before any provider call", () => {
  it("accepts a secret reference and a sensitive output that later runs can read again", async () => {
    expect(await codeOf('{ secret: "env://CRED_TOKEN" }')).toBe("(no error)");
    expect(await codeOf("{ from: producer.secret }")).toBe("(no error)");
  });

  it("refuses a literal, a non-sensitive output and a once-only output, naming the line and the param", async () => {
    expect(await codeOf("literal-token-0042")).toMatch(/^PARAM_INVALID: cred: line `user`: `credential` must be .*never a literal credential/);
    expect(await codeOf("{ keep: true }")).toMatch(/^PARAM_INVALID: .*never a literal credential/);
    expect(await codeOf("{ from: producer.id }")).toMatch(/^PARAM_INVALID: .*reads `producer.id`, which is not a sensitive output/);
    expect(await codeOf("{ from: producer.token }")).toMatch(/^PARAM_INVALID: .*reads `producer.token`, which the provider shows only when it is created/);
    expect(cloud.items.size, "nothing was read or written").toBe(0);
  });

  it("leaves unknown outputs to the reference checks", async () => {
    expect(await codeOf("{ from: producer.nope }")).toMatch(/^REF_OUTPUT_UNKNOWN: /);
  });
});
