import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { LockHeldError, LockLostError, type Receipt, type ReceiptStore } from "../types.js";
import { GitBranchReceiptStore, receiptsBranch } from "./git.js";
import { parseReceipt, serialize } from "./layout.js";
import { LocalReceiptStore } from "./local.js";

const exec = promisify(execFile);

function receipt(scope: string, runId: string): Receipt {
  return {
    version: 2,
    runId,
    environment: "preview",
    scope,
    status: "complete",
    startedAt: "2026-10-10T00:00:00Z",
    finishedAt: "2026-10-10T00:00:01Z",
    plan: { hash: "h" },
    ctx: { env: "preview", git: { branch: "b", sha: "s", short_sha: "s" }, pr: { number: null }, scope },
    lines: {},
    ledger: [],
    history: [{ sha: "s", at: "2026-10-10T00:00:01Z" }],
    hashKey: "k",
  };
}

const tmp = (p: string) => mkdtemp(join(tmpdir(), `sponson-${p}-`));

async function bareRemote(): Promise<string> {
  const dir = await tmp("remote");
  await exec("git", ["init", "--bare", "-q", "--initial-branch=main", dir]);
  return dir;
}

async function gitStore(remote: string, extra: Partial<ConstructorParameters<typeof GitBranchReceiptStore>[0]> = {}) {
  return new GitBranchReceiptStore({ remote, workdir: await tmp("wd"), fallbackDir: await tmp("kept"), ...extra });
}

/** Factory of independent actors sharing one store backend (one directory, or one remote). */
type Backend = () => Promise<() => Promise<ReceiptStore>>;
const backends: Array<[string, Backend]> = [
  ["local", async () => { const root = await tmp("local"); return async () => new LocalReceiptStore(root); }],
  ["git-branch", async () => { const remote = await bareRemote(); return () => gitStore(remote); }],
];

const expired = (holder: string) => ({ holder, acquiredAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString() });

describe.each(backends)("%s store", (_name, backend) => {
  let actor: () => Promise<ReceiptStore>;
  let store: ReceiptStore;
  beforeEach(async () => {
    actor = await backend();
    store = await actor();
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
    expect(await store.readLock("preview", "pr-1")).toBeNull();
    expect(await store.acquireLock("preview", "pr-1", "b", 60_000)).toBeNull();
  });

  it("preempts an expired lock and reports who held it", async () => {
    await store.acquireLock("preview", "pr-1", "crashed", -1000);
    const taken = await store.acquireLock("preview", "pr-1", "fresh", 60_000);
    expect(taken?.holder).toBe("crashed");
  });

  it("exactly one of several concurrent successors takes over an expired lock", async () => {
    const n = _name === "local" ? 8 : 4;
    for (let round = 0; round < (_name === "local" ? 5 : 1); round++) {
      const scope = `pr-${10 + round}`;
      await store.acquireLock("preview", scope, "crashed", -1000);
      const actors = await Promise.all(Array.from({ length: n }, () => actor()));
      const results = await Promise.allSettled(actors.map((a, i) => a.acquireLock("preview", scope, `h${i}`, 60_000)));
      const won = results.flatMap((r, i) => (r.status === "fulfilled" ? [i] : []));
      expect(won, `round ${round}`).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockHeldError);
      for (const r of results) if (r.status === "rejected") expect((r.reason as LockHeldError).lock.holder).toBe(`h${won[0]}`);
      expect((await store.readLock("preview", scope))?.holder).toBe(`h${won[0]}`);
    }
  });

  it("renews a held lease, and renew/readLock report a lost one", async () => {
    await store.acquireLock("preview", "pr-1", "a", 1_000);
    const before = (await store.readLock("preview", "pr-1"))!;
    await store.renewLock("preview", "pr-1", "a", 60_000);
    const after = (await store.readLock("preview", "pr-1"))!;
    expect(after.holder).toBe("a");
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
    await expect(store.renewLock("preview", "pr-1", "b", 60_000)).rejects.toBeInstanceOf(LockLostError);
    expect(await store.readLock("preview", "pr-2")).toBeNull();
  });

  it("a fenced write is rejected once another actor took the lock over, and lands while still held", async () => {
    await store.acquireLock("preview", "pr-1", "a", 60_000);
    await store.write(receipt("pr-1", "run-a1"), { holder: "a" });
    await store.renewLock("preview", "pr-1", "a", -1000); // lease runs out while "a" is still working
    const other = await actor();
    expect((await other.acquireLock("preview", "pr-1", "b", 60_000))?.holder).toBe("a");
    const err = await store.write(receipt("pr-1", "run-a2"), { holder: "a" }).catch((e) => e);
    expect(err).toBeInstanceOf(LockLostError);
    expect((err as LockLostError).current?.holder).toBe("b");
    await expect(store.renewLock("preview", "pr-1", "a", 60_000)).rejects.toBeInstanceOf(LockLostError);
    expect((await other.read("preview", "pr-1"))?.runId).toBe("run-a1");
    await other.write(receipt("pr-1", "run-b"), { holder: "b" });
    await store.releaseLock("preview", "pr-1", "a"); // stale holder: must not remove b's lock
    expect((await other.readLock("preview", "pr-1"))?.holder).toBe("b");
  });

  it("rejects a newer version with an upgrade hint", async () => {
    await store.write(receipt("pr-1", "run-1"));
    await store.write({ ...receipt("pr-1", "run-2"), version: 3 as 2 });
    await expect(store.read("preview", "pr-1")).rejects.toMatchObject({ code: "RECEIPT_VERSION" });
  });
});

describe("receipt format", () => {
  const v1 = {
    version: 1,
    runId: "r1",
    environment: "preview",
    scope: "pr-1",
    status: "complete",
    startedAt: "2026-10-10T00:00:00Z",
    finishedAt: "",
    plan: { hash: "h" },
    ctx: { env: "preview", git: { branch: "b", sha: "abc", short_sha: "abc" }, pr: { number: 1 }, scope: "pr-1" },
    lines: {
      db: { id: "db", adapter: "neon", op: "branch", status: "applied", createdBy: "sponson", outputs: { branch: "x" }, resources: [{ key: "branch:x", id: "br_1", hash: "h1", label: "x" }] },
      env: { id: "env", adapter: "vercel", op: "env", status: "unchanged", createdBy: "sponson", outputs: {}, resources: [{ key: "env:A", id: "e1", hash: "h2", createdBy: "adopted" }] },
      old: { id: "old", adapter: "clerk", op: "redirect_allow", status: "unchanged", createdBy: "sponson", outputs: {}, orphan: true, resources: [{ key: "url:u", id: "u1", hash: "h3" }] },
      gone: { id: "gone", adapter: "neon", op: "branch", status: "failed", createdBy: "sponson", outputs: {}, resources: [] },
    },
  };

  it("migrates v1 to v2: ledger from line resources, history from ctx, unkeyed hashes", () => {
    const r = parseReceipt(JSON.stringify(v1), "test");
    expect(r.version).toBe(2);
    expect(r.hashKey).toBe("");
    expect(r.history).toEqual([{ sha: "abc", at: "2026-10-10T00:00:00Z" }]);
    expect(r.ledger).toEqual([
      { adapter: "neon", op: "branch", provider: {}, key: "branch:x", id: "br_1", hash: "h1", label: "x", createdBy: "sponson", line: "db", outputs: { branch: "x" } },
      { adapter: "vercel", op: "env", provider: {}, key: "env:A", id: "e1", hash: "h2", createdBy: "adopted", line: "env", outputs: {} },
      { adapter: "clerk", op: "redirect_allow", provider: {}, key: "url:u", id: "u1", hash: "h3", createdBy: "sponson", line: "old", orphan: true, outputs: {} },
    ]);
    expect(Object.keys(r.lines)).toEqual(["db", "env", "old", "gone"]);
    // Round trip: the migrated receipt is a valid v2 receipt and survives serialization unchanged.
    expect(parseReceipt(serialize(r), "again")).toEqual(r);
  });

  it("reads a v1 receipt from a store as v2", async () => {
    const root = await tmp("local");
    await mkdir(join(root, "preview/pr-1"), { recursive: true });
    await writeFile(join(root, "preview/pr-1/latest.json"), JSON.stringify(v1));
    const r = await new LocalReceiptStore(root).read("preview", "pr-1");
    expect(r?.version).toBe(2);
    expect(r?.ledger).toHaveLength(3);
  });

  it("keeps RECEIPT_CORRUPT for broken files and for v2 receipts without a ledger", () => {
    expect(() => parseReceipt("{ half", "x")).toThrow(expect.objectContaining({ code: "RECEIPT_CORRUPT" }));
    expect(() => parseReceipt(JSON.stringify({ lines: {} }), "x")).toThrow(expect.objectContaining({ code: "RECEIPT_CORRUPT" }));
    const { ledger: _l, ...noLedger } = receipt("pr-1", "r");
    expect(() => parseReceipt(JSON.stringify(noLedger), "x")).toThrow(expect.objectContaining({ code: "RECEIPT_CORRUPT" }));
  });
});

describe("local store", () => {
  it("leaves the previous latest intact when a write is interrupted", async () => {
    const root = await tmp("local");
    const store = new LocalReceiptStore(root);
    await store.write(receipt("pr-1", "run-1"));
    await writeFile(join(root, "preview/pr-1/latest.json.999.tmp"), "{ half");
    expect(JSON.parse(await readFile(join(root, "preview/pr-1/latest.json"), "utf8")).runId).toBe("run-1");
    expect((await store.read("preview", "pr-1"))?.runId).toBe("run-1");
  });

  it("a stale mutex left by a crashed process does not wedge the scope", async () => {
    const root = await tmp("local");
    await mkdir(join(root, "preview/pr-1"), { recursive: true });
    await writeFile(join(root, "preview/pr-1/lock.mutex"), JSON.stringify({ pid: 1, token: "x", at: 0 }));
    await writeFile(join(root, "preview/pr-1/lock.json"), JSON.stringify(expired("crashed")));
    expect((await new LocalReceiptStore(root).acquireLock("preview", "pr-1", "a", 60_000))?.holder).toBe("crashed");
  });

  it("a fenced write re-asserts a lock a human deleted when nobody wrote the scope meanwhile, and refuses otherwise", async () => {
    const root = await tmp("local");
    const a = new LocalReceiptStore(root);
    await a.acquireLock("preview", "pr-1", "a", 60_000);
    await exec("rm", [join(root, "preview/pr-1/lock.json")]);
    await a.write(receipt("pr-1", "run-a"), { holder: "a" });
    expect((await a.readLock("preview", "pr-1"))?.holder).toBe("a");
    await exec("rm", [join(root, "preview/pr-1/lock.json")]);
    const b = new LocalReceiptStore(root);
    await b.acquireLock("preview", "pr-1", "b", 60_000);
    await b.write(receipt("pr-1", "run-b"), { holder: "b" });
    await b.releaseLock("preview", "pr-1", "b");
    await expect(a.write(receipt("pr-1", "run-a2"), { holder: "a" })).rejects.toBeInstanceOf(LockLostError);
  });
});

describe("git-branch store", () => {
  it("creates the scope's orphan branch with a README on first use", async () => {
    const remote = await bareRemote();
    const store = await gitStore(remote);
    await store.write(receipt("pr-7", "run-1"));
    const ref = "sponson-receipts/preview/pr-7";
    expect(receiptsBranch("preview", "pr-7")).toBe(ref);
    const { stdout } = await exec("git", ["--git-dir", remote, "ls-tree", "--name-only", ref]);
    expect(stdout.split("\n")).toContain("README.md");
    const { stdout: readme } = await exec("git", ["--git-dir", remote, "show", `${ref}:README.md`]);
    expect(readme).toMatch(/only when no apply is running/);
    expect(readme).toMatch(/unmanaged/);
    const { stdout: tree } = await exec("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", ref]);
    expect(tree).toContain("preview/pr-7/latest.json");
    expect(tree).toContain("preview/pr-7/run-1.json");
    // Nothing else is created: no shared branch.
    expect(await refs(remote)).toEqual([`refs/heads/${ref}`]);
  });

  it("branch names stay valid git refs for any scope, and distinct scopes get distinct branches", () => {
    expect(receiptsBranch("preview", "branch-feat/x y")).toBe("sponson-receipts/preview/branch-feat-x-y");
    const odd = ["x.lock", ".hidden", "trailing.", "a..b"].map((s) => receiptsBranch("preview", s));
    expect(new Set(odd).size).toBe(4);
    for (const b of odd) expect(b).toMatch(/^sponson-receipts\/preview\/=[0-9a-f]+$/);
  });

  it("eight scopes writing at once (lock, receipt, unlock) never contend: no ref race, and each scope's branch has exactly its own commits", async () => {
    const remote = await bareRemote();
    const writers = await Promise.all(Array.from({ length: 8 }, () => gitStore(remote, { budgetMs: 30_000 })));
    await Promise.all(
      writers.map(async (w, i) => {
        await w.acquireLock("preview", `pr-${i}`, `h${i}`, 60_000);
        await w.write(receipt(`pr-${i}`, `run-${i}`), { holder: `h${i}` });
        await w.releaseLock("preview", `pr-${i}`, `h${i}`);
      }),
    );
    expect(writers.map((w) => w.refRaceCount)).toEqual(Array(8).fill(0));
    for (let i = 0; i < 8; i++) {
      const { stdout } = await exec("git", ["--git-dir", remote, "log", "--format=%s", `sponson-receipts/preview/pr-${i}`]);
      expect(stdout.trim().split("\n").reverse()).toEqual([
        `Start receipts for preview/pr-${i}`,
        `lock preview/pr-${i} h${i}`,
        `receipt preview/pr-${i} run-${i} (complete)`,
        `unlock preview/pr-${i} h${i}`,
      ]);
    }
    const reader = await gitStore(remote);
    expect((await reader.list("preview")).map((s) => s.scope)).toEqual(Array.from({ length: 8 }, (_, i) => `pr-${i}`));
    for (let i = 0; i < 8; i++) expect(await reader.readLock("preview", `pr-${i}`)).toBeNull();
  }, 45_000); // longer than the 30s store budget it tests: only the product may give up first

  it("concurrent lockers on a fresh scope: one wins, the rest see the real holder", async () => {
    const remote = await bareRemote();
    const lockers = await Promise.all(Array.from({ length: 4 }, () => gitStore(remote)));
    const results = await Promise.allSettled(lockers.map((l, i) => l.acquireLock("preview", "pr-1", `h${i}`, 60_000)));
    const won = results.flatMap((r, i) => (r.status === "fulfilled" ? [`h${i}`] : []));
    expect(won).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as LockHeldError).lock.holder).toBe(won[0]);
  });

  it("lists scopes whose names differ only by case, even on a case-insensitive filesystem", async () => {
    // A reftable remote can hold refs that differ only by case on any filesystem, as GitHub does.
    const remote = await tmp("remote-reftable");
    const supported = await exec("git", ["init", "--bare", "-q", "--initial-branch=main", "--ref-format=reftable", remote]).then(() => true, () => false);
    if (!supported) return; // git older than 2.45: nothing to check
    for (const scope of ["branch-Feature", "branch-feature", "pr-2"]) {
      const w = await gitStore(remote);
      await w.write(receipt(scope, `run-${scope}`));
      await w.close();
    }
    const listed = (await (await gitStore(remote)).list("preview")).map((s) => s.scope).sort();
    expect(listed).toEqual(["branch-Feature", "branch-feature", "pr-2"]);
  });

  it("instances without a workdir get their own owner-only working clone, created on first use with mkdtemp", async () => {
    const remote = await bareRemote();
    const a = new GitBranchReceiptStore({ remote, fallbackDir: await tmp("kept") });
    const b = new GitBranchReceiptStore({ remote, fallbackDir: await tmp("kept") });
    expect(a.workingClone).toBe(""); // nothing exists before first use
    await Promise.all([a.write(receipt("pr-1", "r1")), b.write(receipt("pr-2", "r2"))]);
    expect(a.workingClone).not.toBe(b.workingClone);
    expect(a.workingClone.startsWith(join(tmpdir(), "sponson-receipts-"))).toBe(true);
    if (process.platform !== "win32") expect((await stat(a.workingClone)).mode & 0o077).toBe(0); // owner-only
    expect((await a.list("preview")).map((s) => s.scope).sort()).toEqual(["pr-1", "pr-2"]);
    const [firstA, firstB] = [a.workingClone, b.workingClone];
    await Promise.all([a.close(), b.close()]);
    await expect(stat(firstA)).rejects.toThrow();
    await expect(stat(firstB)).rejects.toThrow();
    // A closed store is still usable: it starts a fresh, differently named clone.
    expect((await a.read("preview", "pr-1"))?.runId).toBe("r1");
    expect(a.workingClone).not.toBe(firstA);
    await a.close();
  });

  it("close() keeps a working clone the caller passed in", async () => {
    const store = await gitStore(await bareRemote());
    await store.write(receipt("pr-1", "r1"));
    await store.close();
    expect((await stat(store.workingClone)).isDirectory()).toBe(true);
  });

  it("a receipt the remote keeps rejecting fails with STORE_REJECTED and is kept in the fallback file the error names", async () => {
    const remote = await bareRemote();
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, `#!/bin/sh\nwhile read old new ref; do\n  if git diff --name-only "$old" "$new" 2>/dev/null | grep -q latest.json; then echo "rejected: receipts frozen" >&2; exit 1; fi\ndone\nexit 0\n`);
    await chmod(hook, 0o755);
    const fallbackDir = await tmp("kept");
    const store = await gitStore(remote, { fallbackDir, budgetMs: 5_000 });
    await store.acquireLock("preview", "pr-1", "a", 60_000);
    const err = (await store.write(receipt("pr-1", "run-1"), { holder: "a" }).catch((e) => e)) as Error & { code?: string; details?: { keptAt?: string } };
    expect(err.code).toBe("STORE_REJECTED");
    const keptAt = join(fallbackDir, "preview/pr-1/run-1.json");
    expect(err.message).toContain(`kept locally in ${keptAt}`);
    expect(err.message).toMatch(/receipts frozen/);
    expect(err.details?.keptAt).toBe(keptAt);
    // Releasing the lock re-syncs the clone; the kept receipt must survive it.
    await store.releaseLock("preview", "pr-1", "a");
    expect(await store.readLock("preview", "pr-1")).toBeNull();
    expect(JSON.parse(await readFile(keptAt, "utf8")).runId).toBe("run-1");
  });

  it("removes the fallback copy once the receipt is pushed", async () => {
    const fallbackDir = await tmp("kept");
    const store = await gitStore(await bareRemote(), { fallbackDir });
    await store.write(receipt("pr-1", "run-1"));
    await expect(stat(join(fallbackDir, "preview/pr-1/run-1.json"))).rejects.toThrow();
  });

  it("survives the scope's branch being deleted by a human, and re-asserts a deleted lock only if nobody else wrote the scope", async () => {
    const remote = await bareRemote();
    const store = await gitStore(remote);
    await store.write(receipt("pr-1", "run-1"));
    await store.acquireLock("preview", "pr-1", "a", 60_000);
    await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/sponson-receipts/preview/pr-1"]);
    expect(await store.read("preview", "pr-1")).toBeNull();
    // "a" is still running; its fenced write lands (nobody else can have held the scope) and restores its lock.
    await store.write(receipt("pr-1", "run-2"), { holder: "a" });
    expect((await store.read("preview", "pr-1"))?.runId).toBe("run-2");
    expect((await store.readLock("preview", "pr-1"))?.holder).toBe("a");
    // Deleted again, and this time a newcomer takes the scope: "a" has lost it.
    await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/sponson-receipts/preview/pr-1"]);
    const b = await gitStore(remote);
    await b.acquireLock("preview", "pr-1", "b", 60_000);
    await expect(store.write(receipt("pr-1", "run-3"), { holder: "a" })).rejects.toBeInstanceOf(LockLostError);
    await expect(store.renewLock("preview", "pr-1", "a", 60_000)).rejects.toBeInstanceOf(LockLostError);
  });

  it("a missing branch is 'no receipts yet', a 404 remote is STORE_PERMISSION, and credentials never leak", async () => {
    expect(await (await gitStore(await bareRemote())).read("preview", "pr-1")).toBeNull();
    const server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Repository not found.");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const store = await gitStore(`http://x-access-token:ghs_SECRET404@127.0.0.1:${port}/o/private.git`);
      const err = (await store.read("preview", "pr-1").catch((e) => e)) as Error & { code?: string; details?: unknown };
      expect(err.code).toBe("STORE_PERMISSION");
      expect(err.message).toMatch(/not found/);
      expect(JSON.stringify({ m: err.message, d: err.details, s: err.stack })).not.toContain("ghs_SECRET404");
      const w = (await store.write(receipt("pr-1", "r")).catch((e) => e)) as Error & { code?: string };
      expect(w.code).toBe("STORE_PERMISSION");
      expect(w.message).toMatch(/kept locally/);
      expect(w.message).not.toContain("ghs_SECRET404");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("never echoes credentials embedded in the remote URL", async () => {
    const store = await gitStore("https://x-access-token:ghs_SECRET123@github.invalid/o/r.git");
    const err = await store.read("preview", "pr-1").catch((e: Error & { code?: string; details?: unknown }) => e);
    expect(err).toMatchObject({ code: "STORE_PERMISSION" });
    expect(JSON.stringify({ m: (err as Error).message, d: (err as { details?: unknown }).details })).not.toContain("ghs_SECRET123");
  });

  it("explains an unreachable remote", async () => {
    await expect((await gitStore("/nonexistent/repo.git")).read("preview", "pr-1")).rejects.toMatchObject({ code: "STORE_PERMISSION" });
  });
});

describe("git-branch store: the legacy shared branch (ADR 0016)", () => {
  /** A remote as a pre-0016 Sponson left it: every scope under one `sponson/receipts` branch. */
  async function legacyRemote(files: Record<string, string>): Promise<string> {
    const remote = await bareRemote();
    const dir = await tmp("legacy");
    const git = (...args: string[]) => exec("git", ["-c", "user.name=old", "-c", "user.email=old@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    await git("init", "-q", "--initial-branch=sponson/receipts");
    for (const [path, content] of Object.entries({ "README.md": "old\n", ...files })) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    await git("add", "-A");
    await git("commit", "-qm", "legacy receipts");
    await git("push", "-q", remote, "sponson/receipts");
    return remote;
  }
  const legacyHead = async (remote: string) => (await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/sponson/receipts"])).stdout.trim();

  it("respects a live lock an older Sponson holds on the legacy branch: no takeover, no migration", async () => {
    const live = { holder: "run-old", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const variants: Array<Record<string, string>> = [
      { "preview/pr-1/latest.json": serialize(receipt("pr-1", "old-1")), "preview/pr-1/lock.json": serialize(live) },
      { "preview/pr-1/lock.json": serialize(live) }, // its first run: a lock and no receipt yet
    ];
    for (const files of variants) {
      const remote = await legacyRemote(files);
      const store = await gitStore(remote);
      expect((await store.readLock("preview", "pr-1"))?.holder).toBe("run-old");
      await expect(store.acquireLock("preview", "pr-1", "run-new", 60_000)).rejects.toBeInstanceOf(LockHeldError);
      expect(await refs(remote)).toEqual(["refs/heads/sponson/receipts"]); // the scope was not migrated under it
    }
  });

  it("reads a scope that has no branch of its own from the legacy branch, and the first write migrates it", async () => {
    const remote = await legacyRemote({
      "preview/pr-1/latest.json": serialize(receipt("pr-1", "old-1")),
      "preview/pr-1/old-1.json": serialize(receipt("pr-1", "old-1")),
      "preview/pr-1/lock.json": serialize(expired("old-runner")),
    });
    const before = await legacyHead(remote);
    const store = await gitStore(remote);
    expect((await store.read("preview", "pr-1"))?.runId).toBe("old-1");
    expect(await refs(remote)).toEqual(["refs/heads/sponson/receipts"]); // reading migrates nothing

    // A lock is the first write: the scope's branch is created carrying its legacy receipts (not the legacy lock).
    expect(await store.acquireLock("preview", "pr-1", "a", 60_000)).toBeNull();
    const ref = "sponson-receipts/preview/pr-1";
    const { stdout: tree } = await exec("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", ref]);
    expect(tree.trim().split("\n").sort()).toEqual(["README.md", "preview/pr-1/latest.json", "preview/pr-1/lock.json", "preview/pr-1/old-1.json"]);
    expect(JSON.parse((await exec("git", ["--git-dir", remote, "show", `${ref}:preview/pr-1/lock.json`])).stdout).holder).toBe("a");
    await store.write(receipt("pr-1", "new-1"), { holder: "a" });
    await store.releaseLock("preview", "pr-1", "a");

    expect((await (await gitStore(remote)).read("preview", "pr-1"))?.runId).toBe("new-1");
    expect(await legacyHead(remote)).toBe(before); // the legacy branch is never written
    // Once every scope has migrated, the legacy branch can go: nothing reads it any more.
    await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/sponson/receipts"]);
    expect((await (await gitStore(remote)).read("preview", "pr-1"))?.runId).toBe("new-1");
  });

  it("list() merges scopes on their own branches with legacy scopes that have none yet; an own branch wins", async () => {
    const remote = await legacyRemote({
      "preview/pr-1/latest.json": serialize(receipt("pr-1", "old-1")),
      "preview/pr-2/latest.json": serialize(receipt("pr-2", "old-2")),
      "preview/pr-3/lock.json": serialize(expired("x")), // no latest: not listed
      "production/main/latest.json": serialize({ ...receipt("main", "old-m"), environment: "production" }),
    });
    const store = await gitStore(remote);
    await store.write(receipt("pr-2", "new-2"));
    await store.write(receipt("pr-4", "new-4"));
    await (await gitStore(remote)).write({ ...receipt("main", "new-m"), environment: "staging" });
    const listed = (await store.list("preview")).map((s) => `${s.scope}:${s.receipt.runId}`);
    expect(listed).toEqual(["pr-1:old-1", "pr-2:new-2", "pr-4:new-4"]);
    expect((await store.list("production")).map((s) => `${s.scope}:${s.receipt.runId}`)).toEqual(["main:old-m"]);
    expect((await store.list("staging")).map((s) => `${s.scope}:${s.receipt.runId}`)).toEqual(["main:new-m"]);
    expect(await store.list("nowhere")).toEqual([]);
    // With the fallback turned off, only the scopes' own branches count.
    expect(await (await gitStore(remote, { legacyBranch: null })).read("preview", "pr-1")).toBeNull();
    expect((await (await gitStore(remote, { legacyBranch: null })).list("preview")).map((s) => s.scope)).toEqual(["pr-2", "pr-4"]);
  });

  it("list() sees a scope's branch deleted since the last list", async () => {
    const remote = await bareRemote();
    const store = await gitStore(remote);
    await store.write(receipt("pr-1", "r1"));
    await store.write(receipt("pr-2", "r2"));
    expect((await store.list("preview")).map((s) => s.scope)).toEqual(["pr-1", "pr-2"]);
    await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/sponson-receipts/preview/pr-1"]);
    expect((await store.list("preview")).map((s) => s.scope)).toEqual(["pr-2"]);
  });
});

async function refs(remote: string): Promise<string[]> {
  const { stdout } = await exec("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]);
  return stdout.trim().split("\n").filter(Boolean).sort();
}
