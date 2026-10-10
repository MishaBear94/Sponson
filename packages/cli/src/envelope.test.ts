/**
 * The one output contract (G6) and the redaction choke point (G5) at the CLI / MCP layer:
 * every command and every failure path answers with one envelope, JSON is redacted field by field,
 * and the text renderer is the only place display strings exist.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Registry, SponsonError, sha256, type ApplyResultSummary, type LiveState, type PlanResult, type Receipt, type ResourceAdapter } from "@sponson/core";
import { describe, expect, it } from "vitest";
import type { IO } from "./context.js";
import { appendChanges } from "./commands/init.js";
import { buildMcpServer, readReceipt, validateArgs } from "./commands/mcp.js";
import { run } from "./main.js";
import { errorEnvelope, exitCodeFor, serialize } from "./output.js";
import { ERROR_CODES, Redactor } from "@sponson/core";
import { finalLine, renderApply, renderPlan } from "./render.js";
import { createRequire } from "node:module";

const PKG_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// ---------------------------------------------------------------------------
// A one-op fake registry: `fake.thing` stores `value`; `fail: true` echoes `token` in its error.
// ---------------------------------------------------------------------------

function fakeRegistry(store = new Map<string, string>(), opts: { throwOnCreate?: Error } = {}): Registry {
  const read = async (_a: unknown, p: Record<string, unknown>): Promise<LiveState | null> => {
    const v = store.get(String(p.name));
    if (v === undefined) return null;
    return { resources: [{ key: `thing:${String(p.name)}`, id: `id-${String(p.name)}`, hash: sha256(v), label: `thing ${String(p.name)}` }], outputs: { id: `id-${String(p.name)}` } };
  };
  const adapter: ResourceAdapter = {
    name: "fake",
    ops: {
      thing: {
        outputs: { id: { available: "immediate" } },
        read,
        diff(live, p) {
          const after = { state: "literal" as const, value: String(p.value ?? "") };
          if (!live) return [{ key: `thing:${String(p.name)}`, kind: "create", label: `thing ${String(p.name)}`, after }];
          return [{ key: live.resources[0]!.key, kind: live.resources[0]!.hash === sha256(String(p.value ?? "")) ? "unchanged" : "update", label: `thing ${String(p.name)}`, after }];
        },
        async apply(a, p, live) {
          if (p.fail) throw new Error(`provider said: bad token ${String(p.token ?? "")}`);
          store.set(String(p.name), String(p.value ?? ""));
          const next = (await read(a, p))!;
          return { resources: next.resources, outputs: next.outputs, created: live ? [] : [`thing:${String(p.name)}`] };
        },
        async destroy(_a, resources) {
          for (const r of resources) store.delete(r.key.replace(/^thing:/, ""));
        },
      },
    },
  };
  const r = new Registry();
  r.addAdapter(adapter);
  r.addSecretSource({
    scheme: "env",
    async resolve(ref: string, env: NodeJS.ProcessEnv) {
      const v = env[ref.slice("env://".length)];
      if (v === undefined) throw new Error(`missing ${ref}`);
      return v;
    },
  } as never);
  if (opts.throwOnCreate) {
    return new Proxy(r, {
      get(target, prop, recv) {
        if (prop === "op") throw opts.throwOnCreate;
        return Reflect.get(target, prop, recv);
      },
    });
  }
  return r;
}

const PLAN = (extra = "") => `version: 1
environments: [preview, production]
receipts: local
changes:
  - id: a
    adapter: fake
    op: thing
    name: alpha
    value: one
${extra}`;

async function world(plan: string | null = PLAN(), env: NodeJS.ProcessEnv = {}, registry: () => Registry = () => fakeRegistry()) {
  const cwd = await mkdtemp(join(tmpdir(), "sponson-env-"));
  if (plan !== null) await writeFile(join(cwd, "release.plan.yaml"), plan);
  const ctxArgs = ["--receipts", "local", "--receipts-dir", join(cwd, "receipts"), "--branch", "feat", "--sha", "abcdef1234567890", "--pr", "42"];
  const exec = async (args: string[], withCtx = true) => {
    let out = "";
    let err = "";
    const code = await run(withCtx ? [...args, ...ctxArgs] : args, {
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) },
      env: { PATH: process.env.PATH, ...env },
      cwd,
      createRegistry: registry,
      color: false,
    });
    let json: any = null;  
    try {
      json = JSON.parse(out);
    } catch {
      /* not JSON */
    }
    return { code, out, err, json };
  };
  return { cwd, exec, env };
}

// ---------------------------------------------------------------------------

describe("error envelope on every failure path", () => {
  it.each([
    ["unknown option", ["apply", "--aproved-by", "alice", "--json"], "apply"],
    ["bad choice", ["plan", "--json", "--receipts", "s3"], "plan"],
    ["unknown command", ["status-json", "--json"], null],
    ["missing option value", ["plan", "--json", "--env"], "plan"],
    ["bad --pr", ["plan", "--json", "--pr", "abc", "--branch", "x", "--sha", "abc"], "plan"],
    ["bad --wait-timeout", ["apply", "--json", "--wait-timeout", "soon", "--branch", "x", "--sha", "abc", "--pr", "1"], "apply"],
  ])("%s → { ok:false, command, error.code USAGE }, exit 2, nothing else on stdout", async (_n, args, command) => {
    const w = await world();
    const r = await w.exec(args as string[], false);
    expect(r.code).toBe(2);
    expect(r.json, r.out + r.err).toMatchObject({ ok: false, command, error: { code: "USAGE", message: expect.any(String) } });
    expect(r.out.trim().split("\n").length).toBeGreaterThan(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });

  it("usage errors without --json are one line on stderr", async () => {
    const w = await world();
    const r = await w.exec(["apply", "--aproved-by", "x"], false);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^error USAGE: unknown option '--aproved-by'/);
  });

  it("a SponsonError keeps its code and details; plan problems exit 2", async () => {
    const w = await world();
    const r = await w.exec(["plan", "--json", "--env", "stagging"]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, command: "plan", error: { code: "ENV_UNKNOWN", known: ["preview", "production"] } });
  });

  it("an unexpected exception is INTERNAL, exit 1, still JSON", async () => {
    const w = await world(PLAN(), {}, () => fakeRegistry(new Map(), { throwOnCreate: new TypeError("cannot read properties of undefined") }));
    const r = await w.exec(["plan", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, command: "plan", error: { code: "INTERNAL", message: "cannot read properties of undefined" } });
  });

  it("exit codes: 3 lock, 2 usage/plan/ref/env/param, 1 otherwise", () => {
    const code = (c: string) => exitCodeFor(new SponsonError(c as never, "x"));
    expect(["LOCK_HELD", "LOCK_LOST"].map(code)).toEqual([3, 3]);
    expect(["USAGE", "PLAN_INVALID", "REF_UNKNOWN", "REF_OUTPUT_UNKNOWN", "ENV_UNKNOWN", "ENV_NOT_APPROVED", "PARAM_INVALID", "SECRET_LITERAL"].map(code)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(["STORE_CONTENDED", "STORE_REJECTED", "OWNED_BY_OTHER_SCOPE", "PROVIDER_TRANSIENT", "PROVIDER_AUTH", "INTERNAL", "STORE_PERMISSION", "DRIFT_CHANGED"].map(code)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("every error code has its exit code in core's ERROR_CODES, and the old hand list still holds", () => {
    for (const [c, spec] of Object.entries(ERROR_CODES)) {
      const expected = c === "LOCK_HELD" || c === "LOCK_LOST" ? 3 : /^(PLAN_|REF_|ENV_)/.test(c) || ["USAGE", "PARAM_INVALID", "CTX_NULL", "SECRET_LITERAL", "ADAPTER_UNKNOWN", "OP_UNKNOWN", "MANUAL_STEP_PENDING"].includes(c) ? 2 : 1;
      expect([c, spec.exit]).toEqual([c, expected]);
    }
  });

  it("the envelope carries the CLI remedy for codes whose fix is a flag", () => {
    expect(errorEnvelope("apply", new SponsonError("ENV_NOT_APPROVED", "approval is required (approvedBy)")).error.hint).toMatch(/--approved-by/);
    expect(errorEnvelope("apply", new SponsonError("DRIFT_CHANGED", "x")).error.hint).toMatch(/--reconcile/);
    expect(errorEnvelope("plan", new SponsonError("PLAN_INVALID", "x")).error).not.toHaveProperty("hint");
  });

  it("errorEnvelope never lets details overwrite code or message", () => {
    const e = new SponsonError("PLAN_INVALID", "real message", { code: "FAKE", message: "fake", path: "p" });
    expect(errorEnvelope("plan", e)).toEqual({ ok: false, command: "plan", error: { code: "PLAN_INVALID", message: "real message", path: "p" } });
  });
});

describe("JSON is redacted field by field, never by string replacement", () => {
  it.each(["true", "applied", "complete", "null"])("a secret equal to %j leaves --json valid and truthful", async (secret) => {
    const w = await world(PLAN(`  - id: b\n    adapter: fake\n    op: thing\n    name: beta\n    value: { secret: "env://S" }\n`), { S: secret });
    const r = await w.exec(["apply", "--json"]);
    expect(r.json, r.out).not.toBeNull();
    expect(r.json.ok).toBe(true);
    expect(r.json.receipt.status).toBe("complete");
    expect(r.json.receipt.lines.b.status).toBe("applied");
  });

  it("serialize masks string leaves but not keys, numbers, booleans or structural enums", () => {
    const red = new Redactor();
    red.register("applied");
    red.register("hunter2-value");
    const text = serialize({ ok: true, status: "applied", applied: 1, note: "hunter2-value was applied" }, red, false);
    expect(JSON.parse(text)).toEqual({ ok: true, status: "applied", applied: 1, note: "[REDACTED] was [REDACTED]" });
  });

  it("a provider error echoing the secret is masked in JSON and text", async () => {
    const secret = "tok_live_ECHOED_value_123456";
    const w = await world(PLAN(`  - id: b\n    adapter: fake\n    op: thing\n    name: beta\n    fail: true\n    token: { secret: "env://T" }\n`), { T: secret });
    for (const args of [["apply", "--json"], ["apply"]]) {
      const r = await w.exec(args);
      expect(r.code).toBe(1);
      expect(r.out + r.err).not.toContain(secret);
      expect(r.out).toContain("[REDACTED]");
    }
  });

  it("a secret shorter than 4 characters produces one warning with a count, never the value", async () => {
    const w = await world(PLAN(`  - id: b\n    adapter: fake\n    op: thing\n    name: beta\n    value: { secret: "env://PIN" }\n`), { PIN: "917" });
    const r = await w.exec(["apply", "--json"]);
    const hits = (r.json.warnings as string[]).filter((x) => x.includes("secret shorter than 4 characters cannot be redacted reliably"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toContain("917");
  });
});

describe("approval", () => {
  const prodPlan = `version: 1
environments: [preview, production]
receipts: local
changes:
  - id: a
    adapter: fake
    op: thing
    name: alpha
    value: one
    environments: [production]
`;
  it("--approved-by that is blank after trimming is no approval", async () => {
    const w = await world(prodPlan, { SPONSON_APPROVED_BY: "  " });
    const r = await w.exec(["apply", "--json", "--env", "production", "--approved-by", "   "]);
    expect(r.json?.error?.code).toBe("ENV_NOT_APPROVED");
    expect(r.code).toBe(2);
  });

  it("a trimmed approver is recorded", async () => {
    const w = await world(prodPlan);
    const r = await w.exec(["apply", "--json", "--env", "production", "--approved-by", "  alice@example.com "]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.receipt.approvedBy).toBe("alice@example.com");
  });

  it("without --approved-by, $SPONSON_APPROVED_BY (trimmed) is the approver", async () => {
    const w = await world(prodPlan, { SPONSON_APPROVED_BY: "  bob " });
    const r = await w.exec(["apply", "--json", "--env", "production"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.receipt.approvedBy).toBe("bob");
  });
});

describe("init", () => {
  it("--json in an empty repo: created, path, detected, added, warnings", async () => {
    const w = await world(null);
    const r = await w.exec(["init", "--json"], false);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      ok: true,
      command: "init",
      created: true,
      path: join(w.cwd, "release.plan.yaml"),
      detected: {
        found: [],
        unsupported: [],
        todo: [
          { path: "providers.vercel.project", placeholder: "prj_xxx", hint: expect.stringContaining("vercel link") },
          { path: "providers.neon.project", placeholder: "proj_xxx", hint: expect.stringContaining("neonctl projects list") },
        ],
        assumed: true,
      },
      added: [],
      warnings: [],
    });
  });

  it("--json on an existing plan with nothing to adopt: detected is null", async () => {
    const w = await world();
    const r = await w.exec(["init", "--json"]);
    expect(r.json).toMatchObject({ ok: true, command: "init", created: false, detected: null, added: [] });
  });

  it("a broken plan is an error envelope with the plan's code", async () => {
    const w = await world("version: one\n");
    const r = await w.exec(["init", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, command: "init", error: { code: expect.stringMatching(/^PLAN_/) } });
  });
});

describe("appendChanges keeps the existing text byte for byte", () => {
  const line = { id: "env-preview", adapter: "vercel", op: "env", target: "preview", values: { LEGACY: { secret: "env://LEGACY" } }, environments: ["preview"] };

  it("appends after the last line of `changes:`, with the list's indentation", () => {
    const src = `# keep me
version: 1
changes:
  - id: env   # the main one
    adapter: vercel
    values: { A: "1",   B: 'two' }
  # a comment inside the list
receipts: local   # after the list
`;
    const out = appendChanges(src, [line]);
    const block = "\n  - id: env-preview\n    adapter: vercel\n    op: env\n    target: preview\n    values:\n      LEGACY: { secret: env://LEGACY }\n    environments: [ preview ]\n";
    expect(out).toContain(block);
    // Remove what was added: the original, byte for byte.
    expect(out.replace(block, "")).toBe(src);
    expect(out.indexOf(block)).toBeGreaterThan(src.indexOf("values: { A"));
  });

  it("works for a zero-indent list, a file without trailing newline, `changes: []` and a missing key", () => {
    const zero = "version: 1\nchanges:\n- id: a\n  adapter: x\n  op: y";
    expect(appendChanges(zero, [line]).startsWith(zero + "\n\n- id: env-preview\n  adapter: vercel")).toBe(true);
    const empty = "version: 1\nchanges: []\nreceipts: local\n";
    const e = appendChanges(empty, [line]);
    expect(e.startsWith("version: 1\nchanges:\n  - id: env-preview")).toBe(true);
    expect(e.endsWith("\nreceipts: local\n")).toBe(true);
    const none = "version: 1\n";
    expect(appendChanges(none, [line]).startsWith("version: 1\nchanges:\n  - id: env-preview")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rendering: display strings exist only in text
// ---------------------------------------------------------------------------

function planResult(over: Partial<PlanResult> = {}): PlanResult {
  return { environment: "preview", scope: "pr-42", planHash: "0123456789abcdef", lines: [], drift: [], warnings: [], previous: null, lock: null, requiresApproval: false, ...over };
}

describe("text renderer", () => {
  it("renders DiffSide states, blocked lines, waitingFor and the lock warning", () => {
    const text = renderPlan(
      planResult({
        lock: { holder: "run-1", acquiredAt: "t0", expiresAt: "t1" },
        lines: [
          {
            id: "env",
            adapter: "vercel",
            op: "env",
            status: "update",
            inputs: {},
            outputs: {},
            diffs: [
              { key: "k1", kind: "update", label: "FLAG", before: { state: "literal", value: "off" }, after: { state: "literal", value: "on" } },
              { key: "k2", kind: "update", label: "DATABASE_URL", before: { state: "sensitive" }, after: { state: "pending", ref: "db.connection_string" } },
              { key: "k3", kind: "create", label: "STRIPE_KEY", before: { state: "absent" }, after: { state: "secret", ref: "env://STRIPE_KEY" } },
            ],
          },
          { id: "callback", adapter: "clerk", op: "redirect_allow", status: "pending", waitingOn: "env", waitingFor: "deploy", inputs: {}, outputs: {}, diffs: [] },
          { id: "other", adapter: "vercel", op: "env", status: "blocked", error: "changed outside Sponson", errorCode: "DRIFT_CHANGED", inputs: {}, outputs: {}, diffs: [] },
        ],
      }),
      { color: false },
    );
    expect(text).toContain("an apply is running on this scope; this plan may change");
    expect(text).toContain("~ FLAG  off → on");
    expect(text).toContain("~ DATABASE_URL  (secret) → (pending ← db.connection_string)");
    expect(text).toContain("+ STRIPE_KEY  (secret ← env://STRIPE_KEY)");
    expect(text).toMatch(/^\? callback .*waiting on `env` \(deploy\)$/m);
    expect(text).toMatch(/^- other .*blocked\s+DRIFT_CHANGED: changed outside Sponson Re-run with --reconcile/m); // the CLI remedy follows the engine message
    expect(text).toContain("1 to update, 1 pending, 1 blocked");
  });

  function summary(r: Partial<Receipt>): ApplyResultSummary {
    const receipt = {
      version: 2,
      runId: "run-x",
      environment: "production",
      scope: "main",
      status: "complete",
      startedAt: "",
      finishedAt: "",
      plan: { hash: "h" },
      ctx: { env: "production", git: { branch: "main", sha: "abc", short_sha: "abc" }, pr: { number: null }, scope: "main" },
      lines: {},
      ledger: [],
      history: [{ sha: "fffffff1234", at: "" }],
      hashKey: "k",
      ...r,
    } as Receipt;
    return { receipt, drift: [], warnings: [] };
  }

  it("shows approvedBy, blocked receipt lines and stale runs", () => {
    const text = renderApply(
      summary({
        approvedBy: "alice",
        status: "partial",
        lines: { a: { id: "a", adapter: "vercel", op: "env", status: "blocked", createdBy: "sponson", resources: [], outputs: {}, error: "owned by pr-7", errorCode: "OWNED_BY_OTHER_SCOPE" } },
      }),
      { color: false },
    );
    expect(text).toContain("approved by alice");
    expect(text).toMatch(/^- a .*blocked\s+OWNED_BY_OTHER_SCOPE: owned by pr-7$/m);
    expect(finalLine(summary({ stale: true }))).toBe("apply skipped (stale): a newer commit (fffffff) was already applied to this scope");
  });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

describe("MCP argument validation", () => {
  const spec = { pr: { type: "positive integer" as const, description: "" }, destroy: { type: "boolean" as const, description: "" }, env: { type: "string" as const, description: "" } };
  it.each([
    [{ pr: "42" }, "pr"],
    [{ destroy: "true" }, "destroy"],
    [{ env: ["preview"] }, "env"],
    [{ pr: 1.5 }, "pr"],
  ])("%j is a USAGE error naming the argument", (args, name) => {
    expect(() => validateArgs("t", args, spec)).toThrow(expect.objectContaining({ code: "USAGE", details: expect.objectContaining({ argument: name }) }));
  });

  it("unknown arguments are rejected with the valid list", () => {
    expect(() => validateArgs("t", { reconcile_drift: true }, spec)).toThrow(expect.objectContaining({ code: "USAGE", details: { unknown: ["reconcile_drift"], valid: ["pr", "destroy", "env"] } }));
  });

  it("null and absent arguments are omitted", () => {
    expect(validateArgs("t", { pr: null, env: "preview" }, spec)).toEqual({ env: "preview" });
    expect(validateArgs("t", undefined, spec)).toEqual({});
  });
});

function quietIO(cwd: string, env: NodeJS.ProcessEnv = {}, registry = () => fakeRegistry()): IO {
  const sink = { write: () => true };
  return { stdout: sink, stderr: sink, json: () => {}, env: { PATH: process.env.PATH, ...env }, cwd, createRegistry: registry, color: false };
}

async function mcpClient(cwd: string, env: NodeJS.ProcessEnv = {}, registry = () => fakeRegistry()) {
  const server = buildMcpServer({ receipts: "local", receiptsDir: join(cwd, "receipts"), branch: "feat", sha: "abcdef1234567890", pr: "42" }, quietIO(cwd, env, registry));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    return { isError: r.isError === true, json: JSON.parse(text.split("\n")[0]!) };
  };
  return { client, call };
}

describe("MCP tools", () => {
  it("loose types and unknown arguments come back as the USAGE envelope, not a protocol error", async () => {
    const w = await world();
    const { call } = await mcpClient(w.cwd);
    for (const [tool, args] of [
      ["sponson_plan", { pr: "42" }],
      ["sponson_apply", { destroy: "true" }],
      ["sponson_receipt", { env: ["preview"] }],
      ["sponson_apply", { reconcile_drift: true }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    }
  });

  it("an unexpected exception is INTERNAL, not APPLY_FAILED", async () => {
    const w = await world();
    const { call } = await mcpClient(w.cwd, {}, () => fakeRegistry(new Map(), { throwOnCreate: new Error("kaboom") }));
    const r = await call("sponson_apply", {});
    expect(r.json).toMatchObject({ ok: false, command: "apply", error: { code: "INTERNAL", message: "kaboom" } });
  });

  it("whitespace approvedBy on production is ENV_NOT_APPROVED", async () => {
    const w = await world(PLAN().replace("value: one", "value: one\n    environments: [production]"));
    const { call } = await mcpClient(w.cwd);
    const r = await call("sponson_apply", { env: "production", approvedBy: "   " });
    expect(r.json.error.code).toBe("ENV_NOT_APPROVED");
  });

  it("without approvedBy, the server's $SPONSON_APPROVED_BY (trimmed) is the approver", async () => {
    const w = await world(PLAN().replace("value: one", "value: one\n    environments: [production]"));
    const { call } = await mcpClient(w.cwd, { SPONSON_APPROVED_BY: " carol " });
    const r = await call("sponson_apply", { env: "production" });
    expect(r.json.receipt?.approvedBy, JSON.stringify(r.json)).toBe("carol");
  });

  it("reports the package version", async () => {
    const w = await world();
    const { client } = await mcpClient(w.cwd);
    expect(client.getServerVersion()?.version).toBe(PKG_VERSION);
  });

  it("descriptions list every plan status and every receipt line status; apply takes waitTimeout", async () => {
    const w = await world();
    const { client } = await mcpClient(w.cwd);
    const { tools } = await client.listTools();
    const plan = tools.find((t) => t.name === "sponson_plan")!.description!;
    for (const s of ["create", "update", "unchanged", "pending", "blocked", "error"]) expect(plan).toContain(s);
    const apply = tools.find((t) => t.name === "sponson_apply")!;
    for (const s of ["applied", "unchanged", "waiting", "failed", "rolled_back", "rollback_failed", "skipped", "blocked", "destroyed", "destroy_failed"]) expect(apply.description).toContain(s);
    expect(Object.keys((apply.inputSchema as { properties: object }).properties)).toContain("waitTimeout");
  });
});

describe("sponson_receipt without a valid plan", () => {
  it("reads the store from the raw file and warns instead of failing", async () => {
    const w = await world("version: one\nreceipts: local\n");
    const r = await readReceipt({ receiptsDir: join(w.cwd, "receipts"), branch: "feat", sha: "abc", pr: 42 }, quietIO(w.cwd), new Redactor());
    expect(r).toMatchObject({ ok: true, command: "receipt", environment: "preview", scope: "pr-42", receipt: null });
    expect(r.warnings.join("\n")).toMatch(/not usable \(PLAN_/);
  });

  it("checks the environment when the plan parses", async () => {
    const w = await world();
    await expect(readReceipt({ env: "prod", receiptsDir: join(w.cwd, "receipts"), branch: "feat", sha: "abc", pr: 42 }, quietIO(w.cwd), new Redactor())).rejects.toMatchObject({ code: "ENV_UNKNOWN" });
  });

  it("a missing plan file is fine too", async () => {
    const w = await world(null);
    const r = await readReceipt({ receipts: "local", receiptsDir: join(w.cwd, "receipts"), branch: "feat", sha: "abc", pr: 42 }, quietIO(w.cwd), new Redactor());
    expect(r.receipt).toBeNull();
    expect(await readFile(join(w.cwd, "release.plan.yaml"), "utf8").catch(() => "absent")).toBe("absent");
  });
});
