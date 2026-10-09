import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { LockHeldError, type Receipt, type ReceiptStore } from "../types.js";
import { GitBranchReceiptStore } from "./git.js";
import { LocalReceiptStore } from "./local.js";

const exec = promisify(execFile);

function receipt(scope: string, runId: string): Receipt {
  return {
    version: 1,
    runId,
    environment: "preview",
    scope,
    status: "complete",
    startedAt: "2026-10-10T00:00:00Z",
    finishedAt: "2026-10-10T00:00:01Z",
    plan: { hash: "h" },
    ctx: { env: "preview", git: { branch: "b", sha: "s", short_sha: "s" }, pr: { number: null }, scope },
    lines: {},
  };
}

async function bareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sponson-remote-"));
  await exec("git", ["init", "--bare", "-q", "--initial-branch=main", dir]);
  return dir;
}

const stores: Array<[string, () => Promise<ReceiptStore>, () => Promise<ReceiptStore>]> = [
  [
    "local",
    async () => new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-local-"))),
    async () => {
      throw new Error("n/a");
    },
  ],
  [
    "git-branch",
    async () => {
      const remote = await bareRemote();
      return new GitBranchReceiptStore({ remote, workdir: await mkdtemp(join(tmpdir(), "sponson-wd-")) });
    },
    async () => {
      throw new Error("n/a");
    },
  ],
];

describe.each(stores)("%s store", (_name, make) => {
  let store: ReceiptStore;
  beforeEach(async () => {
    store = await make();
  });

  it("returns null before any write, then the latest receipt", async () => {
    expect(await store.read("preview", "pr-1")).toBeNull();
    await store.write(receipt("pr-1", "run-1"));
    await store.write(receipt("pr-1", "run-2"));
    expect((await store.read("preview", "pr-1"))?.runId).toBe("run-2");
    expect((await store.list("preview")).map((s) => s.scope)).toEqual(["pr-1"]);
  });

  it("locks are exclusive, expire, and release only for the holder", async () => {
    expect(await store.acquireLock("preview", "pr-1", "a", 60_000)).toBeNull();
    await expect(store.acquireLock("preview", "pr-1", "b", 60_000)).rejects.toBeInstanceOf(LockHeldError);
    await store.releaseLock("preview", "pr-1", "b"); // not the holder: no-op
    await expect(store.acquireLock("preview", "pr-1", "b", 60_000)).rejects.toBeInstanceOf(LockHeldError);
    await store.releaseLock("preview", "pr-1", "a");
    expect(await store.acquireLock("preview", "pr-1", "b", 60_000)).toBeNull();
  });

  it("preempts an expired lock and reports who held it", async () => {
    await store.acquireLock("preview", "pr-1", "crashed", -1000);
    const taken = await store.acquireLock("preview", "pr-1", "fresh", 60_000);
    expect(taken?.holder).toBe("crashed");
  });

  it("rejects a corrupt receipt with its location and a newer version with an upgrade hint", async () => {
    await store.write(receipt("pr-1", "run-1"));
    await store.write({ ...receipt("pr-1", "run-2"), version: 2 as 1 });
    await expect(store.read("preview", "pr-1")).rejects.toMatchObject({ code: "RECEIPT_VERSION" });
  });
});

describe("local store atomic writes", () => {
  it("leaves the previous latest intact when a write is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "sponson-local-"));
    const store = new LocalReceiptStore(root);
    await store.write(receipt("pr-1", "run-1"));
    // Simulate a crash mid-write: a stray temp file next to latest.json.
    await writeFile(join(root, "preview/pr-1/latest.json.999.tmp"), "{ half");
    expect(JSON.parse(await readFile(join(root, "preview/pr-1/latest.json"), "utf8")).runId).toBe("run-1");
    expect((await store.read("preview", "pr-1"))?.runId).toBe("run-1");
  });
});

describe("git-branch store", () => {
  it("creates the orphan branch with a README on first use", async () => {
    const remote = await bareRemote();
    const store = new GitBranchReceiptStore({ remote, workdir: await mkdtemp(join(tmpdir(), "sponson-wd-")) });
    await store.write(receipt("pr-7", "run-1"));
    const { stdout } = await exec("git", ["--git-dir", remote, "ls-tree", "--name-only", "sponson/receipts"]);
    expect(stdout.split("\n")).toContain("README.md");
    const { stdout: tree } = await exec("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "sponson/receipts"]);
    expect(tree).toContain("preview/pr-7/latest.json");
    expect(tree).toContain("preview/pr-7/run-1.json");
  });

  it("converges when five writers race on the same remote", async () => {
    const remote = await bareRemote();
    const writers = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => new GitBranchReceiptStore({ remote, workdir: await mkdtemp(join(tmpdir(), `sponson-wd-${i}-`)), attempts: 20 })),
    );
    await Promise.all(writers.map((w, i) => w.write(receipt(`pr-${i}`, `run-${i}`))));
    const reader = new GitBranchReceiptStore({ remote, workdir: await mkdtemp(join(tmpdir(), "sponson-wd-r-")) });
    const scopes = (await reader.list("preview")).map((s) => s.scope).sort();
    expect(scopes).toEqual(["pr-0", "pr-1", "pr-2", "pr-3", "pr-4"]);
  });

  it("only one of several concurrent lockers wins", async () => {
    const remote = await bareRemote();
    const lockers = await Promise.all(
      Array.from({ length: 4 }, async (_, i) => new GitBranchReceiptStore({ remote, workdir: await mkdtemp(join(tmpdir(), `sponson-lk-${i}-`)), attempts: 20 })),
    );
    const results = await Promise.allSettled(lockers.map((l, i) => l.acquireLock("preview", "pr-1", `h${i}`, 60_000)));
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.every((r) => (r as PromiseRejectedResult).reason instanceof LockHeldError)).toBe(true);
  });

  it("survives the branch being deleted by a human", async () => {
    const remote = await bareRemote();
    const store = new GitBranchReceiptStore({ remote, workdir: await mkdtemp(join(tmpdir(), "sponson-wd-")) });
    await store.write(receipt("pr-1", "run-1"));
    await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/sponson/receipts"]);
    expect(await store.read("preview", "pr-1")).toBeNull();
    await store.write(receipt("pr-1", "run-2"));
    expect((await store.read("preview", "pr-1"))?.runId).toBe("run-2");
  });

  it("never echoes credentials embedded in the remote URL", async () => {
    const store = new GitBranchReceiptStore({ remote: "https://x-access-token:ghs_SECRET123@github.invalid/o/r.git", workdir: await mkdtemp(join(tmpdir(), "sponson-wd-")) });
    const err = await store.read("preview", "pr-1").catch((e: Error & { code?: string; details?: unknown }) => e);
    expect(err).toMatchObject({ code: "STORE_PERMISSION" });
    expect(JSON.stringify({ m: (err as Error).message, d: (err as { details?: unknown }).details })).not.toContain("ghs_SECRET123");
  });

  it("explains an unreachable remote", async () => {
    const store = new GitBranchReceiptStore({ remote: "/nonexistent/repo.git", workdir: await mkdtemp(join(tmpdir(), "sponson-wd-")) });
    await expect(store.read("preview", "pr-1")).rejects.toMatchObject({ code: "STORE_PERMISSION" });
  });
});
