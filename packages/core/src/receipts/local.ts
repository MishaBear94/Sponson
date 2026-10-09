import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LockHeldError, type LockInfo, type Receipt, type ReceiptStore } from "../types.js";
import { latestPath, lockExpired, lockPath, parseLock, parseReceipt, runPath, serialize } from "./layout.js";

/**
 * Receipts on the local filesystem (default `.sponson/receipts/`).
 * Used when there is no git remote, and by tests.
 */
export class LocalReceiptStore implements ReceiptStore {
  readonly kind = "local";

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

  async write(receipt: Receipt): Promise<void> {
    const run = join(this.root, runPath(receipt.environment, receipt.scope, receipt.runId));
    const latest = join(this.root, latestPath(receipt.environment, receipt.scope));
    await mkdir(dirname(run), { recursive: true });
    // Atomic: write to a temp file, then rename. A crash leaves the previous latest intact.
    await atomicWrite(run, serialize(receipt));
    await atomicWrite(latest, serialize(receipt));
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
    const now = Date.now();
    const mine: LockInfo = { holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // `wx` fails if the file exists: the filesystem is the compare-and-swap.
        await writeFile(path, serialize(mine), { flag: "wx" });
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const existing = parseLock(await readFile(path, "utf8").catch(() => ""));
      if (existing && !lockExpired(existing, now)) throw new LockHeldError(existing);
      // Expired or unreadable: preempt by removing and retrying the exclusive create.
      await rm(path, { force: true });
      if (existing) {
        try {
          await writeFile(path, serialize(mine), { flag: "wx" });
          return existing;
        } catch {
          /* lost the race to another preemptor; loop */
        }
      }
    }
    throw new LockHeldError(parseLock(await readFile(path, "utf8").catch(() => "")) ?? mine);
  }

  async releaseLock(environment: string, scope: string, holder: string): Promise<void> {
    const path = join(this.root, lockPath(environment, scope));
    const existing = parseLock(await readFile(path, "utf8").catch(() => ""));
    if (existing && existing.holder === holder) await rm(path, { force: true });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
