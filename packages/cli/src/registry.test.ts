import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, isSponsonError } from "@sponson/core";
import { describe, expect, it } from "vitest";
import { run } from "./main.js";
import { loadPlugins, pluginSpecifiers } from "./registry.js";

/** A plugin adding adapter `plug` (op `thing`, read-only: always absent) and secret source `vault://`. */
const PLUGIN = `
const adapter = {
  name: "plug",
  ops: {
    thing: {
      outputs: {},
      async read() { return null; },
      diff(_live, p) { return [{ key: "thing:" + p.name, kind: "create", label: "plug thing " + p.name }]; },
      async apply() { throw new Error("not in this test"); },
      async destroy() {},
    },
  },
};
export function register(registry) {
  registry.addAdapter(adapter).addSecretSource({ scheme: "vault", async resolve() { return "v"; } });
}
`;

async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sponson-plugins-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(d, name), text);
  return d;
}

async function failure(env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  try {
    await loadPlugins(new Registry(), env, cwd);
  } catch (e) {
    if (isSponsonError(e)) return { code: e.code, message: e.message, details: e.details };
    throw e;
  }
  throw new Error("expected loadPlugins to fail");
}

describe("SPONSON_PLUGINS", () => {
  it("splits on commas and ignores blanks", () => {
    expect(pluginSpecifiers({ SPONSON_PLUGINS: " ./a.mjs, ,b ," })).toEqual(["./a.mjs", "b"]);
    expect(pluginSpecifiers({})).toEqual([]);
  });

  it("loads named, default and default-object `register` exports, resolved from cwd", async () => {
    const cwd = await dir({
      "named.mjs": PLUGIN,
      "default.mjs": PLUGIN.replace("export function register", "export default function register"),
      "object.mjs": PLUGIN.replace("export function register(registry) {", "export default { register(registry) {") + "};",
    });
    for (const file of ["named.mjs", "default.mjs", "object.mjs"]) {
      const registry = await loadPlugins(new Registry(), { SPONSON_PLUGINS: `./${file}` }, cwd);
      expect(registry.op("plug", "thing")).toBeDefined();
      expect(registry.secretSource("vault://x").scheme).toBe("vault");
    }
  });

  it("extends the registry `sponson plan` uses", async () => {
    const cwd = await dir({
      "plugin.mjs": PLUGIN,
      "release.plan.yaml": "version: 1\nenvironments: [preview]\nreceipts: local\nchanges:\n  - id: p\n    adapter: plug\n    op: thing\n    name: one\n",
    });
    let out = "";
    const code = await run(["plan", "--json", "--receipts-dir", join(cwd, "r"), "--branch", "feat", "--sha", "abcdef1234567890", "--pr", "1"], {
      cwd,
      env: { PATH: process.env.PATH, SPONSON_PLUGINS: "./plugin.mjs" },
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: () => true },
      createRegistry: () => new Registry(),
    });
    expect(code, out).toBe(0);
    expect(JSON.parse(out).lines).toMatchObject([{ id: "p", adapter: "plug", status: "create" }]);
  });

  it("a plugin that cannot be loaded, has no register, or throws is ADAPTER_UNKNOWN naming the module", async () => {
    const cwd = await dir({
      "empty.mjs": "export const nothing = 1;\n",
      "throws.mjs": "export function register() { throw new Error('bad registry'); }\n",
    });
    const missing = await failure({ SPONSON_PLUGINS: "sponson-plugin-does-not-exist" }, cwd);
    expect(missing).toMatchObject({ code: "ADAPTER_UNKNOWN", details: { plugin: "sponson-plugin-does-not-exist" } });
    expect(missing.message).toContain("could not be loaded");

    const empty = await failure({ SPONSON_PLUGINS: "./empty.mjs" }, cwd);
    expect(empty).toMatchObject({ code: "ADAPTER_UNKNOWN", details: { plugin: "./empty.mjs" } });
    expect(empty.message).toContain("must export `register(registry)`");

    const throws = await failure({ SPONSON_PLUGINS: "./throws.mjs" }, cwd);
    expect(throws).toMatchObject({ code: "ADAPTER_UNKNOWN", details: { plugin: "./throws.mjs", cause: "bad registry" } });
  });

  it("through the CLI, a broken plugin is a JSON error envelope, not a crash", async () => {
    const cwd = await dir({ "release.plan.yaml": "version: 1\nenvironments: [preview]\nreceipts: local\nchanges: []\n" });
    let out = "";
    const code = await run(["plan", "--json", "--receipts-dir", join(cwd, "r"), "--branch", "feat", "--sha", "abcdef1234567890"], {
      cwd,
      env: { PATH: process.env.PATH, SPONSON_PLUGINS: "./nope.mjs" },
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: () => true },
      createRegistry: () => new Registry(),
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: "plan", error: { code: "ADAPTER_UNKNOWN", plugin: "./nope.mjs" } });
  });
});
