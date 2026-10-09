import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SponsonError } from "../errors.js";
import { LockHeldError, type LockInfo, type Receipt, type ReceiptStore } from "../types.js";
import { latestPath, lockExpired, lockPath, parseLock, parseReceipt, runPath, serialize } from "./layout.js";

const exec = promisify(execFile);

export interface GitBranchStoreOptions {
  /** Remote URL or path. Defaults to the `origin` of `cwd`. */
  remote: string;
  branch?: string;
  /** Where the working clone lives. Defaults to a per-remote directory under the OS temp dir. */
  workdir?: string;
  /** Push retry attempts on ref races. */
  attempts?: number;
}

/**
 * Receipts on an orphan branch (`sponson/receipts`) of the user's repository.
 *
 * Every write is "fetch, mutate, commit, push". Git's non-fast-forward rejection is the
 * compare-and-swap; on rejection we fetch and try again. Writes touch disjoint files
 * (one per run), so retries never conflict on content, only on the ref.
 */
export class GitBranchReceiptStore implements ReceiptStore {
  readonly kind = "git-branch";
  private readonly branch: string;
  private readonly workdir: string;
  private readonly attempts: number;
  private initialized = false;

  constructor(private readonly options: GitBranchStoreOptions) {
    this.branch = options.branch ?? "sponson/receipts";
    this.attempts = options.attempts ?? 5;
    this.workdir =
      options.workdir ?? join(tmpdir(), "sponson-receipts", createHash("sha256").update(options.remote).digest("hex").slice(0, 16));
  }

  static async originOf(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async read(environment: string, scope: string): Promise<Receipt | null> {
    await this.sync();
    const path = join(this.workdir, latestPath(environment, scope));
    try {
      return parseReceipt(await readFile(path, "utf8"), `${this.branch}:${latestPath(environment, scope)}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async write(receipt: Receipt): Promise<void> {
    await this.commitAndPush(`receipt ${receipt.environment}/${receipt.scope} ${receipt.runId} (${receipt.status})`, async () => {
      await this.put(runPath(receipt.environment, receipt.scope, receipt.runId), serialize(receipt));
      await this.put(latestPath(receipt.environment, receipt.scope), serialize(receipt));
    });
  }

  async list(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>> {
    await this.sync();
    let scopes: string[];
    try {
      scopes = await readdir(join(this.workdir, environment));
    } catch {
      return [];
    }
    const out: Array<{ scope: string; receipt: Receipt }> = [];
    for (const scope of scopes) {
      try {
        const text = await readFile(join(this.workdir, latestPath(environment, scope)), "utf8");
        out.push({ scope, receipt: parseReceipt(text, scope) });
      } catch {
        /* skip scopes without a readable latest */
      }
    }
    return out;
  }

  async acquireLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<LockInfo | null> {
    let preempted: LockInfo | null = null;
    let lastHeld: LockInfo | null = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await this.sync();
      const path = join(this.workdir, lockPath(environment, scope));
      const existing = parseLock(await readFile(path, "utf8").catch(() => ""));
      const now = Date.now();
      if (existing && !lockExpired(existing, now)) throw new LockHeldError(existing);
      preempted = existing;
      const mine: LockInfo = { holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
      await this.put(lockPath(environment, scope), serialize(mine));
      const pushed = await this.tryCommitAndPush(`lock ${environment}/${scope} ${holder}`);
      if (pushed) return preempted;
      lastHeld = existing;
    }
    throw new LockHeldError(lastHeld ?? { holder: "unknown", acquiredAt: "", expiresAt: "" });
  }

  async releaseLock(environment: string, scope: string, holder: string): Promise<void> {
    await this.commitAndPush(`unlock ${environment}/${scope} ${holder}`, async () => {
      const path = join(this.workdir, lockPath(environment, scope));
      const existing = parseLock(await readFile(path, "utf8").catch(() => ""));
      if (existing && existing.holder === holder) await rm(path, { force: true });
    });
  }

  // -------------------------------------------------------------------------

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-c", "user.name=sponson", "-c", "user.email=sponson@localhost", ...args], {
      cwd: this.workdir,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  private async put(rel: string, content: string): Promise<void> {
    const abs = join(this.workdir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  /** Make the working clone match the remote branch exactly, creating the branch if it does not exist. */
  private async sync(): Promise<void> {
    await mkdir(this.workdir, { recursive: true });
    if (!this.initialized) {
      const isRepo = await stat(join(this.workdir, ".git")).then(() => true, () => false);
      if (!isRepo) {
        await this.git(["init", "-q"]);
        await this.git(["remote", "add", "origin", this.options.remote]);
      } else {
        await this.git(["remote", "set-url", "origin", this.options.remote]);
      }
      this.initialized = true;
    }
    try {
      await this.git(["fetch", "-q", "origin", this.branch]);
      await this.git(["checkout", "-q", "-B", this.branch, "FETCH_HEAD"]);
      await this.git(["clean", "-qfd"]);
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      if (/unable to access|Could not resolve host|Authentication failed/i.test(msg)) {
        throw new SponsonError("STORE_PERMISSION", stripCredentials(`Cannot reach receipts remote ${this.options.remote}: ${msg.trim().split("\n").pop()}`), { remote: stripCredentials(this.options.remote) });
      }
      if (/couldn't find remote ref|Could not read from remote|does not appear to be a git repository|not found/i.test(msg)) {
        if (/Could not read from remote|does not appear to be a git repository/i.test(msg) && !/couldn't find remote ref/i.test(msg)) {
          throw new SponsonError("STORE_PERMISSION", stripCredentials(`Cannot reach receipts remote ${this.options.remote}: ${msg.trim()}`), { remote: stripCredentials(this.options.remote) });
        }
        // Branch does not exist yet: start an orphan with a README so humans know what it is.
        await this.git(["checkout", "-q", "--orphan", this.branch]).catch(() => {});
        await this.git(["rm", "-rfq", "--cached", "."]).catch(() => {});
        for (const entry of await readdir(this.workdir)) if (entry !== ".git") await rm(join(this.workdir, entry), { recursive: true, force: true });
        await this.put("README.md", RECEIPTS_README);
        await this.git(["add", "-A"]);
        // A second sync before the first push finds the README already committed: nothing to do.
        if ((await this.git(["status", "--porcelain"])).trim() !== "") await this.git(["commit", "-qm", "Initialize Sponson receipts branch"]);
        return;
      }
      throw e;
    }
  }

  private async commitAndPush(message: string, mutate: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await this.sync();
      await mutate();
      if (await this.tryCommitAndPush(message)) return;
    }
    throw new SponsonError("STORE_PERMISSION", `Could not push to ${this.branch} after ${this.attempts} attempts (concurrent writers?). Receipt kept locally in ${this.workdir}.`, {
      branch: this.branch,
      workdir: this.workdir,
    });
  }

  /** Commit the working tree and push. Returns false on a ref race (caller re-syncs and retries). */
  private async tryCommitAndPush(message: string): Promise<boolean> {
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain"]);
    if (status.trim() !== "") await this.git(["commit", "-qm", message]);
    try {
      await this.git(["push", "-q", "origin", `${this.branch}:${this.branch}`]);
      return true;
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      if (/rejected|fetch first|non-fast-forward|failed to push|cannot lock ref/i.test(msg)) return false;
      if (/403|denied|permission|not permitted|authentication/i.test(msg)) {
        throw new SponsonError(
          "STORE_PERMISSION",
          stripCredentials(`Push to ${this.branch} was denied. In GitHub Actions, add \`permissions: { contents: write }\` to the workflow. (${msg.trim().split("\n").pop()})`),
          { branch: this.branch },
        );
      }
      throw new Error(stripCredentials((e as Error).message));
    }
  }
}

/** Remote URLs may carry a token (`https://x-access-token:...@github.com/...`); never let one into an error message. */
function stripCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//[REDACTED]@");
}

const RECEIPTS_README = `# Sponson receipts

This branch is written by \`sponson apply\`. It records what each run actually did:
which resources were created, their value hashes, and whether the run completed.

It is an orphan branch so it never conflicts with your code. Do not merge it.
Deleting it is safe: Sponson will treat every resource as unmanaged and recreate the branch on the next run.
`;
