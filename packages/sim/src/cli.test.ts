import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSimArgs, runSimCli, USAGE, type SimCliIO, type SimCliResult } from "./cli.js";
import { demoSteps } from "./demo.js";

let root: string;
const running: SimCliResult[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sponson-sim-cli-"));
});
afterEach(async () => {
  for (const r of running.splice(0)) await r.sim?.close();
  await rm(root, { recursive: true, force: true });
});

function io(env: NodeJS.ProcessEnv = {}): SimCliIO & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { stdout: (s) => void (out += s), stderr: (s) => void (err += s), env, cwd: root, out: () => out, err: () => err };
}

async function run(argv: string[], t: ReturnType<typeof io>): Promise<SimCliResult> {
  const r = await runSimCli(argv, t);
  running.push(r);
  return r;
}

describe("parseSimArgs", () => {
  it("serves on --port, else SPONSON_SIM_PORT, else 4777; a blank variable counts as unset", () => {
    expect(parseSimArgs([], {})).toEqual({ kind: "serve", port: 4777 });
    expect(parseSimArgs([], { SPONSON_SIM_PORT: "5000" })).toEqual({ kind: "serve", port: 5000 });
    expect(parseSimArgs([], { SPONSON_SIM_PORT: " " })).toEqual({ kind: "serve", port: 4777 });
    expect(parseSimArgs(["--port", "0"], { SPONSON_SIM_PORT: "5000" })).toEqual({ kind: "serve", port: 0 });
    expect(parseSimArgs(["--demo", "d", "--port=6000"], {})).toEqual({ kind: "serve", port: 6000, demo: "d" });
    expect(parseSimArgs(["env", "--port", "6000"], {})).toEqual({ kind: "env", port: 6000 });
    expect(parseSimArgs(["-h"], {})).toEqual({ kind: "help" });
  });

  it.each([
    [["--port", "x"], "invalid port: x"],
    [["--port", "70000"], "invalid port: 70000"],
    [["--port", ""], "invalid port: "],
    [["serve"], "unexpected argument: serve"],
    [["env", "extra"], "unexpected argument: env extra"],
    [["env", "--demo", "d"], "cannot be combined"],
    [["--demo", " "], "--demo needs a directory"],
    [["--nope"], "Unknown option"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseSimArgs(argv, {})).toThrow(message);
  });
});

describe("runSimCli", () => {
  it("--help prints the usage", async () => {
    const t = io();
    expect(await run(["--help"], t)).toEqual({ code: 0 });
    expect(t.out()).toBe(USAGE);
  });

  it("a usage error exits 2 with the reason and the usage, starting nothing", async () => {
    const t = io();
    expect(await run(["--port", "x"], t)).toEqual({ code: 2 });
    expect(t.err()).toBe(`sponson-sim: invalid port: x\n${USAGE}`);
  });

  it("env prints export lines for eval, without starting a sim", async () => {
    const t = io({ SPONSON_SIM_PORT: "4999" });
    expect(await run(["env"], t)).toEqual({ code: 0 });
    expect(t.out()).toContain("export SPONSON_SIM_URL=http://127.0.0.1:4999\n");
    expect(t.out()).toContain("export NEON_API_URL=http://127.0.0.1:4999/neon\n");
    expect(t.out()).toContain("export VERCEL_TOKEN=tok_vercel\n");
    expect(t.out().split("\n").filter((l) => l !== "").every((l) => l.startsWith("export "))).toBe(true);
  });

  it("without --demo, serves and prints the env to paste", async () => {
    const t = io();
    const r = await run(["--port", "0"], t);
    expect(r.code).toBe(0);
    expect(t.out()).toContain(`sponson-sim listening on ${r.sim!.url}\n`);
    expect(t.out()).toContain(`export CLERK_API_URL=${r.sim!.url}/clerk\n`);
    expect((await fetch(`${r.sim!.url}/_state`)).status).toBe(200);
  });

  it("--demo serves, writes the demo pointing at this sim, and prints the steps", async () => {
    const t = io();
    const r = await run(["--port", "0", "--demo", "demo"], t);
    expect(r.code, t.err()).toBe(0);
    expect(await readFile(join(root, "demo", "sim.env"), "utf8")).toContain(`export SPONSON_SIM_URL=${r.sim!.url}\n`);
    for (const s of demoSteps("demo")) expect(t.out()).toContain(`  ${s}\n`);
  });

  it("--demo into a directory with files stops the sim again and says why", async () => {
    await writeFile(join(root, "taken"), "");
    const t = io();
    const r = await run(["--port", "0", "--demo", "."], t);
    expect(r).toEqual({ code: 1 });
    expect(t.err()).toMatch(/^sponson-sim: .* is not empty/);
  });

  it("a busy port is explained, and no demo is written for it", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      const t = io();
      expect(await run(["--port", String(port), "--demo", "demo"], t)).toEqual({ code: 1 });
      expect(t.err()).toContain(`port ${String(port)} is in use`);
      await expect(readFile(join(root, "demo", "release.plan.yaml"))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
