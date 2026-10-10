import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError } from "../errors.js";
import { LockHeldError, LockLostError, type LockInfo, type Receipt, type ReceiptStore } from "../types.js";
import { latestPath, lockExpired, lockPath, PARENT_LOCKS_ENVIRONMENT, parentLockScope, parseLock, parseReceipt, receiptDir, runPath, serialize } from "./layout.js";

/** A mutex file older than this belongs to a process that died while holding it. Every critical section is a few file ops. */
const MUTEX_STALE_MS = 10_000;
/** How long to wait for the per-scope mutex before reporting contention. */
const MUTEX_WAIT_MS = 30_000;

/**
 * Receipts on the local filesystem (default `.sponson/receipts/`).
 * Used when there is no git remote, and by tests.
 *
 * Locking, per scope directory:
 *   lock.json   the lease. Created only with link(2) from a fully written temp file, so it is never seen half-written
 *               and creation is an atomic "create if absent".
 *   lock.mutex  a short-lived mutex (same link(2) creation) held around every operation that REPLACES or REMOVES
 *               lock.json: expired-lock takeover, renew, release and fenced receipt writes. Plain creation of an absent
 *               lock needs no mutex: link(2) cannot overwrite, so the filesystem decides. Because only mutex holders
 *               ever remove lock.json, "read, check, remove" under the mutex cannot remove a lock someone else just
 *               took (no ABA), and exactly one of many successors wins an expired lock.
 */
export class LocalReceiptStore implements ReceiptStore {
  readonly kind = "local";
  /** What we knew about each scope when we took its lock: lets a fenced write re-assert a lock a human deleted. */
  private readonly fences = new Map<string, { holder: string; latestRunId: string | null }>();

  constructor(private readonly root: string) {}

  async read(environment: string, scope: string): Promise<Receipt | null> {
    const path = join(this.root, latestPath(environment, scope));
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return parseReceipt(text, path);
  }

  async write(receipt: Receipt, opts: { holder?: string } = {}): Promise<void> {
    const { environment, scope } = receipt;
    await mkdir(join(this.root, receiptDir(environment, scope)), { recursive: true });
    const doWrite = async () => {
      // Atomic: write to a temp file, then rename. A crash leaves the previous latest intact.
      await atomicWrite(join(this.root, runPath(environment, scope, receipt.runId)), serialize(receipt));
      await atomicWrite(join(this.root, latestPath(environment, scope)), serialize(receipt));
    };
    if (opts.holder === undefined) return doWrite();
    const holder = opts.holder;
    await this.withMutex(environment, scope, async () => {
      await this.assertHolder(environment, scope, holder, null);
      await doWrite();
      const fence = this.fences.get(fenceKey(environment, scope));
      if (fence && fence.holder === holder) fence.latestRunId = receipt.runId;
    });
  }

  async list(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>> {
    const dir = join(this.root, environment);
    let scopes: string[];
    try {
      scopes = await readdir(dir);
    } catch {
      return [];
    }
    const out: Array<{ scope: string; receipt: Receipt }> = [];
    for (const scope of scopes) {
      const r = await this.read(environment, scope).catch(() => null);
      if (r) out.push({ scope, receipt: r });
    }
    return out;
  }

  async acquireLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<LockInfo | null> {
    const path = join(this.root, lockPath(environment, scope));
    await mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      const now = Date.now();
      const mine: LockInfo = { holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
      if (await createExclusive(path, serialize(mine))) {
        await this.recordFence(environment, scope, holder);
        return null;
      }
      const seen = await readLockFile(path);
      if (seen.lock && !lockExpired(seen.lock)) throw new LockHeldError(seen.lock);
      // Expired, unreadable, or released a moment ago: decide under the mutex.
      const outcome = await this.withMutex(environment, scope, async (): Promise<{ preempted: LockInfo | null } | "retry"> => {
        const cur = await readLockFile(path);
        if (!cur.exists) return "retry"; // released meanwhile: go back to the plain exclusive create
        if (cur.lock && !lockExpired(cur.lock)) throw new LockHeldError(cur.lock);
        // Only mutex holders remove lock.json, so what we just read is what we remove.
        await removeVia(path);
        const at = Date.now();
        const fresh: LockInfo = { holder, acquiredAt: new Date(at).toISOString(), expiresAt: new Date(at + ttlMs).toISOString() };
        // A plain creator may slip in between removal and this create; then it holds a live lock and we lose.
        if (await createExclusive(path, serialize(fresh))) return { preempted: cur.lock };
        return "retry";
      });
      if (outcome !== "retry") {
        await this.recordFence(environment, scope, holder);
        return outcome.preempted;
      }
    }
    throw new SponsonError("STORE_CONTENDED", `Could not settle the lock for ${environment}/${scope}: too many concurrent contenders.`, { environment, scope });
  }

  async renewLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<void> {
    await this.withMutex(environment, scope, async () => {
      const cur = await this.assertHolder(environment, scope, holder, ttlMs);
      if (!cur) return; // re-asserted with the new expiry
      const renewed: LockInfo = { ...cur, holder, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
      await atomicWrite(join(this.root, lockPath(environment, scope)), serialize(renewed));
    });
  }

  async readLock(environment: string, scope: string): Promise<LockInfo | null> {
    return (await readLockFile(join(this.root, lockPath(environment, scope)))).lock;
  }

  async releaseLock(environment: string, scope: string, holder: string): Promise<void> {
    const path = join(this.root, lockPath(environment, scope));
    const seen = await readLockFile(path);
    if (!seen.lock || seen.lock.holder !== holder) return;
    await this.withMutex(environment, scope, async () => {
      const cur = await readLockFile(path);
      if (cur.lock && cur.lock.holder === holder) await removeVia(path);
    });
    this.fences.delete(fenceKey(environment, scope));
  }

  // Parent-object locks (ADR 0019) are lock-only directories, `_locks/<hash>/lock.json`, with the scope lock's
  // machinery: link(2) creation, the mutex around takeover, renew and release.

  async acquireParentLock(parent: string, holder: string, ttlMs: number): Promise<LockInfo | null> {
    return this.acquireLock(PARENT_LOCKS_ENVIRONMENT, parentLockScope(parent), holder, ttlMs);
  }

  async renewParentLock(parent: string, holder: string, ttlMs: number): Promise<void> {
    return this.renewLock(PARENT_LOCKS_ENVIRONMENT, parentLockScope(parent), holder, ttlMs);
  }

  async readParentLock(parent: string): Promise<LockInfo | null> {
    return this.readLock(PARENT_LOCKS_ENVIRONMENT, parentLockScope(parent));
  }

  async releaseParentLock(parent: string, holder: string): Promise<void> {
    return this.releaseLock(PARENT_LOCKS_ENVIRONMENT, parentLockScope(parent), holder);
  }

  // -------------------------------------------------------------------------

  private async recordFence(environment: string, scope: string, holder: string): Promise<void> {
    this.fences.set(fenceKey(environment, scope), { holder, latestRunId: await this.latestRunId(environment, scope) });
  }

  private async latestRunId(environment: string, scope: string): Promise<string | null> {
    try {
      const r = JSON.parse(await readFile(join(this.root, latestPath(environment, scope)), "utf8")) as { runId?: unknown };
      return typeof r.runId === "string" ? r.runId : "?";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "?";
    }
  }

  /**
   * Must be called under the mutex. Returns the current lock when `holder` holds it.
   * When the lock is gone (deleted by a human) and nobody has written this scope since we took it, nobody else can
   * have held it in between: re-assert it (with `ttlMs`, or a short lease when null) and return null.
   * Otherwise throw LockLostError.
   */
  private async assertHolder(environment: string, scope: string, holder: string, ttlMs: number | null): Promise<LockInfo | null> {
    const path = join(this.root, lockPath(environment, scope));
    const cur = await readLockFile(path);
    if (cur.lock && cur.lock.holder === holder) return cur.lock;
    const fence = this.fences.get(fenceKey(environment, scope));
    if (!cur.exists && fence && fence.holder === holder && [fence.latestRunId, null].includes(await this.latestRunId(environment, scope))) {
      const now = Date.now();
      const lease: LockInfo = { holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + (ttlMs ?? 60_000)).toISOString() };
      if (await createExclusive(path, serialize(lease))) return null;
      throw new LockLostError(holder, (await readLockFile(path)).lock);
    }
    throw new LockLostError(holder, cur.lock);
  }

  private async withMutex<T>(environment: string, scope: string, fn: () => Promise<T>): Promise<T> {
    const dir = join(this.root, receiptDir(environment, scope));
    await mkdir(dir, { recursive: true });
    const path = join(dir, "lock.mutex");
    const token = randomBytes(8).toString("hex");
    const content = JSON.stringify({ pid: process.pid, token, at: Date.now() });
    const deadline = Date.now() + MUTEX_WAIT_MS;
    for (let spins = 0; ; spins++) {
      if (await createExclusive(path, content)) break;
      const text = await readFile(path, "utf8").catch(() => null);
      if (text !== null) {
        let at = NaN;
        try {
          at = Number((JSON.parse(text) as { at?: unknown }).at);
        } catch {
          /* unreadable: link(2) never leaves half-written files, so this is debris */
        }
        if (!(at > Date.now() - MUTEX_STALE_MS)) await breakStale(path, text);
      }
      if (Date.now() > deadline) {
        throw new SponsonError("STORE_CONTENDED", `Timed out waiting for the receipts mutex for ${environment}/${scope} (${path}).`, { environment, scope, path });
      }
      await sleep(Math.min(2 + spins, 25) * (0.5 + Math.random()));
    }
    try {
      return await fn();
    } finally {
      // Remove the mutex only if it is still ours (it may have been broken as stale after a very long pause).
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === content) await unlink(path).catch(() => {});
    }
  }
}

function fenceKey(environment: string, scope: string): string {
  return receiptDir(environment, scope);
}

async function readLockFile(path: string): Promise<{ exists: boolean; lock: LockInfo | null }> {
  try {
    return { exists: true, lock: parseLock(await readFile(path, "utf8")) };
  } catch (e) {
    return { exists: (e as NodeJS.ErrnoException).code !== "ENOENT", lock: null };
  }
}

function tmpName(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/** Create `path` with `content` only if it does not exist. The file appears complete or not at all. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  const tmp = tmpName(path);
  await writeFile(tmp, content, "utf8");
  try {
    await link(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      // Filesystems without hard links: fall back to O_EXCL (may be observed half-written; readers treat that as unreadable).
      try {
        await writeFile(path, content, { flag: "wx" });
        return true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e2;
      }
    }
    throw e;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Remove a file by renaming it to a unique tomb first (so a concurrent reader never sees a half-deleted state), then unlinking. */
async function removeVia(path: string): Promise<void> {
  const tomb = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tomb`;
  try {
    await rename(path, tomb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  await unlink(tomb).catch(() => {});
}

/** Break a stale mutex: rename it away, and if what we moved is not what we judged stale, put it back. */
async function breakStale(path: string, staleText: string): Promise<void> {
  const tomb = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tomb`;
  try {
    await rename(path, tomb);
  } catch {
    return;
  }
  const moved = await readFile(tomb, "utf8").catch(() => null);
  if (moved !== staleText) await link(tomb, path).catch(() => {});
  await unlink(tomb).catch(() => {});
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = tmpName(path);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

