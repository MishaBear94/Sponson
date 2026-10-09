import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, sha256, type LiveState, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { describe, expect, it } from "vitest";
import { run } from "./main.js";

// ---------------------------------------------------------------------------
// In-memory adapter: one op with an immediate output, a sensitive output and an external one.
// ---------------------------------------------------------------------------

interface MemState {
  things: Map<string, { value: unknown }>;
  deployed: Set<string>;
  /** Extra resources `listScope` reports, to simulate unmanaged drift. */
  scopeExtra: ResourceRecord[];
}

function memState(): MemState {
  return { things: new Map(), deployed: new Set(), scopeExtra: [] };
}

function memAdapter(name: string, op: string, state: MemState): ResourceAdapter {
  const read = async (_a: unknown, p: Record<string, unknown>): Promise<LiveState | null> => {
    const key = String(p.name);
    const t = state.things.get(key);
    if (!t) return null;
    const outputs: Record<string, string> = { id: `id-${key}`, conn: `conn-${key}` };
    if (state.deployed.has(key)) outputs.url = `https://${key}.example`;
    return { resources: [{ key: `thing:${key}`, id: `id-${key}`, hash: sha256(JSON.stringify(t.value ?? null)), label: `thing ${key}` }], outputs };
  };
  return {
    name,
    ops: {
      [op]: {
        outputs: { id: { available: "immediate" }, conn: { available: "immediate", sensitive: true }, url: { available: "external", event: "deploy" } },
        read,
        diff(live, p) {
          const key = String(p.name);
          const after = String(p.value ?? "");
          if (!live) return [{ key: `thing:${key}`, kind: "create", label: `thing ${key}`, after }];
          const r = live.resources[0]!;
          const kind = r.hash === sha256(JSON.stringify(p.value ?? null)) ? "unchanged" : "update";
          return [{ key: r.key, kind, label: r.label!, before: r.hash.slice(0, 8), after }];
        },
        async apply(_a, p, live) {
          if (p.fail) throw new Error(`boom: ${String(p.token ?? "")}`);
          const key = String(p.name);
          state.things.set(key, { value: p.value });
          const next = (await read(_a, p))!;
          return { resources: next.resources, outputs: next.outputs, created: live ? [] : [`thing:${key}`] };
        },
        async destroy(_a, resources) {
          for (const r of resources) state.things.delete(r.key.replace(/^thing:/, ""));
        },
        async awaitExternal(_a, p, live) {
          return state.deployed.has(String(p.name)) ? { url: live.outputs.url ?? `https://${String(p.name)}.example` } : null;
        },
        async listScope() {
          const own = [...state.things.keys()].map((k) => ({ key: `thing:${k}`, id: `id-${k}`, hash: "x" }));
          return [...own, ...state.scopeExtra];
        },
      },
    },
  };
}

function registryWith(...adapters: ResourceAdapter[]): Registry {
  const r = new Registry();
  for (const a of adapters) r.addAdapter(a);
  r.addSecretSource({
    scheme: "env",
    async resolve(ref, env) {
      const v = env[ref.slice("env://".length)];
      if (v === undefined) throw new Error(`missing ${ref}`);
      return v;
    },
    async fingerprint(ref, env) {
      return sha256(env[ref.slice("env://".length)] ?? "");
    },
  });
  return r;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BASE_PLAN = `version: 1
environments: [preview, production]
receipts: local
changes:
  - id: a
    adapter: mem
    op: thing
    name: alpha
    value: one

  - id: b
    adapter: mem
    op: thing
    name: beta
    value: { from: a.id }
`;

async function harness(plan: string | null = BASE_PLAN, state = memState(), adapter = memAdapter("mem", "thing", state)) {
  const cwd = await mkdtemp(join(tmpdir(), "sponson-cli-"));
  if (plan !== null) await writeFile(join(cwd, "release.plan.yaml"), plan);
  const receipts = join(cwd, "receipts");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, MY_TOKEN: "hunter2-super-secret" };
  const exec = async (...args: string[]) => {
    const stdout = { text: "", write(s: string) { this.text += s; return true; } };
    const stderr = { text: "", write(s: string) { this.text += s; return true; } };
    const code = await run([...args, "--receipts", "local", "--receipts-dir", receipts, "--branch", "feat", "--sha", "abcdef1234567890", "--pr", "42"], {
      stdout, stderr, env, cwd, createRegistry: () => registryWith(adapter), color: false,
    });
    return { code, out: stdout.text, err: stderr.text };
  };
  return { cwd, receipts, state, env, exec };
}

// ---------------------------------------------------------------------------

describe("sponson plan", () => {
  it("prints the text table and exits 0", async () => {
    const h = await harness();
    const r = await h.exec("plan");
    expect(r.code).toBe(0);
    expect(r.out).toContain("sponson plan · preview · pr-42 · plan ");
    expect(r.out).toMatch(/^\+ a  mem\.thing  create\s+thing alpha  one$/m);
    expect(r.out).toMatch(/^\? b  mem\.thing  pending\s+waiting on `a`/m);
    // Sub-rows under a pending line carry the same symbol as top-level rows do.
    expect(r.out).toMatch(/^    \+ thing beta  /m);
    expect(r.out).toContain("1 to create, 1 pending");
  });

  it("emits the JSON shape with --json", async () => {
    const h = await harness();
    const r = await h.exec("plan", "--json");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ ok: true, command: "plan", environment: "preview", scope: "pr-42", drift: [], warnings: [] });
    expect(typeof j.planHash).toBe("string");
    expect(j.lines.map((l: { id: string; status: string }) => [l.id, l.status])).toEqual([["a", "create"], ["b", "pending"]]);
    expect(j.lines[1].inputs.value).toEqual({ state: "pending", value: null, ref: "a.id", dependsOn: "a", sensitive: false });
  });

  it("status is an alias", async () => {
    const h = await harness();
    expect((await h.exec("status", "--json")).code).toBe(0);
  });
});

describe("exit codes", () => {
  it("2 for PLAN_INVALID", async () => {
    const h = await harness("version: 2\nchanges: []\n");
    const r = await h.exec("plan");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^error PLAN_INVALID: /);
  });

  it("2 for ENV_UNKNOWN, as JSON on stdout with --json", async () => {
    const h = await harness();
    const r = await h.exec("plan", "--env", "staging", "--json");
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "ENV_UNKNOWN", environment: "staging" } });
  });

  it("2 for ENV_NOT_APPROVED", async () => {
    const h = await harness();
    const r = await h.exec("apply", "--env", "production");
    expect(r.code).toBe(2);
    expect(r.err).toContain("ENV_NOT_APPROVED");
  });

  it("3 for LOCK_HELD", async () => {
    const h = await harness();
    await mkdir(join(h.receipts, "preview", "pr-42"), { recursive: true });
    const far = new Date(Date.now() + 3600_000).toISOString();
    await writeFile(join(h.receipts, "preview", "pr-42", "lock.json"), JSON.stringify({ holder: "run-other", acquiredAt: far, expiresAt: far }));
    const r = await h.exec("apply");
    expect(r.code).toBe(3);
    expect(r.err).toContain("LOCK_HELD");
  });

  it("2 for a usage error", async () => {
    const h = await harness();
    expect((await h.exec("plan", "--bogus")).code).toBe(2);
    expect((await h.exec("frobnicate")).code).toBe(2);
  });
});

describe("sponson apply", () => {
  it("complete exits 0 and writes a receipt", async () => {
    const h = await harness();
    const r = await h.exec("apply");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\+ a  mem\.thing  applied\s+thing alpha$/m);
    expect(r.out).toContain("  a.id = id-alpha");
    expect(r.out).not.toContain("conn-alpha"); // sensitive output never printed
    expect(r.out.trim().endsWith("apply complete")).toBe(true);
    const receipt = JSON.parse(await readFile(join(h.receipts, "preview", "pr-42", "latest.json"), "utf8"));
    expect(receipt.status).toBe("complete");
    expect(receipt.lines.b.status).toBe("applied");
    // second run: nothing changes
    const again = await h.exec("apply", "--json");
    expect(JSON.parse(again.out).receipt.lines.a.status).toBe("unchanged");
  });

  it("partial (waiting on a deploy) exits 0, then completes once the event happened", async () => {
    const plan = BASE_PLAN + `
  - id: c
    adapter: mem
    op: thing
    name: gamma
    value: { from: a.url }
`;
    const h = await harness(plan);
    const r = await h.exec("apply");
    expect(r.code).toBe(0);
    expect(r.out).toContain("apply partial: waiting on deploy for lines c");
    h.state.deployed.add("alpha");
    const r2 = await h.exec("apply", "--json");
    expect(r2.code).toBe(0);
    const j = JSON.parse(r2.out);
    expect(j.receipt.status).toBe("complete");
    expect(j.receipt.lines.c.outputs.id).toBe("id-gamma");
  });

  it("failed exits 1 and rolls back what this run created", async () => {
    const plan = BASE_PLAN.replace("name: beta\n", "name: beta\n    fail: true\n");
    const h = await harness(plan);
    const r = await h.exec("apply");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^- a  mem\.thing  rolled_back/m);
    expect(r.out).toMatch(/^! b  mem\.thing  failed\s+boom/m);
    expect(r.out).toContain("apply failed: b: boom");
    expect(h.state.things.has("alpha")).toBe(false);
  });

  it("--destroy removes what apply created", async () => {
    const h = await harness();
    await h.exec("apply");
    const r = await h.exec("apply", "--destroy");
    expect(r.code).toBe(0);
    expect(r.out).toContain("destroy complete");
    expect(h.state.things.size).toBe(0);
  });

  it("redacts resolved secrets from every stream", async () => {
    const plan = BASE_PLAN.replace("name: beta\n", "name: beta\n    fail: true\n    token: { secret: \"env://MY_TOKEN\" }\n");
    const h = await harness(plan);
    for (const args of [["apply"], ["apply", "--json"]]) {
      const r = await h.exec(...args);
      expect(r.code).toBe(1);
      expect(r.out + r.err).not.toContain("hunter2-super-secret");
      expect(r.out).toContain("[REDACTED]");
    }
  });
});

describe("sponson init", () => {
  it("writes a starter plan and .gitignore", async () => {
    const h = await harness(null);
    await mkdir(join(h.cwd, ".vercel"));
    await writeFile(join(h.cwd, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_abc", orgId: "team_xyz" }));
    const r = await h.exec("init");
    expect(r.code).toBe(0);
    const plan = await readFile(join(h.cwd, "release.plan.yaml"), "utf8");
    expect(plan).toContain("version: 1");
    expect(plan).toContain('vercel: { project: "prj_abc", team: "team_xyz" }');
    expect(plan).toContain("DATABASE_URL: { from: db.connection_string }");
    expect(await readFile(join(h.cwd, ".gitignore"), "utf8")).toBe(".sponson/\n");
    // idempotent for .gitignore
    await h.exec("init");
    expect(await readFile(join(h.cwd, ".gitignore"), "utf8")).toBe(".sponson/\n");
  });

  it("adopts an unmanaged resource into the existing plan and keeps comments", async () => {
    const state = memState();
    state.scopeExtra.push({ key: "env:preview:LEGACY_KEY", id: "env_1", hash: "h", label: "LEGACY_KEY (preview)" });
    const plan = `# keep me
version: 1
environments: [preview, production]
receipts: local
changes:
  - id: env   # the main one
    adapter: vercel
    op: env
    name: alpha
    value: one
`;
    const h = await harness(plan, state, memAdapter("vercel", "env", state));
    const r = await h.exec("init");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Added 1 line");
    const text = await readFile(join(h.cwd, "release.plan.yaml"), "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("# the main one");
    expect(text).toContain("id: env-preview");
    expect(text).toContain("LEGACY_KEY:\n        secret: env://LEGACY_KEY");
    expect(text).not.toContain("env_1");
    // the adopted line parses and plans
    expect((await h.exec("plan", "--json")).code).toBe(0);
  });

  it("--adopt with no match exits 1", async () => {
    const h = await harness();
    expect((await h.exec("init", "--adopt", "nope")).code).toBe(1);
  });
});
