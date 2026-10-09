import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SponsonError } from "../errors.js";
import { LockHeldError, LockLostError, type LockInfo, type Receipt, type ReceiptStore } from "../types.js";
import { latestPath, lockExpired, lockPath, parseLock, parseReceipt, receiptDir, runPath, serialize } from "./layout.js";

const exec = promisify(execFile);

const DEFAULT_BUDGET_MS = 60_000;
/** A push the server itself refuses (hook, protection rule) is retried a few times in case it was transient, not for the whole budget. */
const MAX_REMOTE_REJECTIONS = 4;
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 2_000;

export interface GitBranchStoreOptions {
  /** Remote URL or path. Defaults to the `origin` of `cwd`. */
  remote: string;
  branch?: string;
  /**
   * Where the working clone lives. When given, it is used as-is (and kept).
   * Default: a fresh directory per store instance (remote hash + pid + random) under `<tmpdir>/sponson-receipts/`,
   * created on first use and removed when the process exits. Processes never share a working clone.
   */
  workdir?: string;
  /** Time budget for one store operation's retries on ref races. Default `SPONSON_STORE_BUDGET_MS`, else 60000. */
  budgetMs?: number;
  /**
   * Where a receipt is kept when it cannot be pushed: `<fallbackDir>/<env>/<scope>/<runId>.json`.
   * Written before the first push attempt and removed once the push lands. Default `.sponson/unpushed` under process.cwd().
   */
  fallbackDir?: string;
}

type PushOutcome = "ok" | { kind: "race" | "rejected"; detail: string };

interface Fence {
  holder: string;
  ttlMs: number;
  /** runId of latest.json when we took the lock (or after our last write); null when there was none. */
  latestRunId: string | null;
}

/**
 * Receipts on an orphan branch (`sponson/receipts`) of the user's repository.
 *
 * Every mutation is "fetch, check, mutate, commit, push". Git's non-fast-forward rejection is the compare-and-swap:
 * a check made against the fetched tree (who holds the lock) holds for the commit that is pushed on top of it, so the
 * lock check and the receipt write land in the same commit or not at all. On a ref race we back off (exponential,
 * full jitter) and redo the whole cycle, within a time budget.
 *
 * One instance serializes its own operations (a lease renewal timer and a receipt write must not interleave in the
 * working clone).
 */
export class GitBranchReceiptStore implements ReceiptStore {
  readonly kind = "git-branch";
  private readonly branch: string;
  private readonly workdir: string;
  private readonly ownsWorkdir: boolean;
  private readonly budgetMs: number;
  private readonly fallbackDir: string;
  private readonly remoteForMessages: string;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fences = new Map<string, Fence>();

  constructor(private readonly options: GitBranchStoreOptions) {
    this.branch = options.branch ?? "sponson/receipts";
    const envBudget = Number(process.env.SPONSON_STORE_BUDGET_MS);
    this.budgetMs = options.budgetMs ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_BUDGET_MS);
    this.fallbackDir = options.fallbackDir ?? join(process.cwd(), ".sponson", "unpushed");
    this.remoteForMessages = stripCredentials(options.remote);
    this.ownsWorkdir = options.workdir === undefined;
    this.workdir =
      options.workdir ??
      join(
        tmpdir(),
        "sponson-receipts",
        `${createHash("sha256").update(options.remote).digest("hex").slice(0, 12)}-${process.pid}-${randomBytes(4).toString("hex")}`,
      );
  }

  /** The working clone this instance uses (for diagnostics and tests). */
  get workingClone(): string {
    return this.workdir;
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
    return this.exclusive(async () => {
      await this.sync();
      const rel = latestPath(environment, scope);
      try {
        return parseReceipt(await readFile(join(this.workdir, rel), "utf8"), `${this.branch}:${rel}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    });
  }

  async write(receipt: Receipt, opts: { holder?: string } = {}): Promise<void> {
    const { environment, scope, runId } = receipt;
    // Write-ahead: the receipt is durable on this machine before anything can fail or be reset.
    const keptAt = join(this.fallbackDir, runPath(environment, scope, runId));
    await mkdir(dirname(keptAt), { recursive: true });
    await writeFile(keptAt, serialize(receipt), "utf8");
    try {
      await this.exclusive(async () => {
        const retry = this.retrier(`receipt ${environment}/${scope}`);
        for (;;) {
          await this.sync();
          if (opts.holder !== undefined) await this.assertHolder(environment, scope, opts.holder, null);
          await this.put(runPath(environment, scope, runId), serialize(receipt));
          await this.put(latestPath(environment, scope), serialize(receipt));
          const outcome = await this.tryCommitAndPush(`receipt ${environment}/${scope} ${runId} (${receipt.status})`);
          if (outcome === "ok") break;
          await retry.backoff(outcome);
        }
        const fence = this.fences.get(receiptDir(environment, scope));
        if (fence && fence.holder === opts.holder) fence.latestRunId = runId;
      });
    } catch (e) {
      throw keptError(e, keptAt);
    }
    await rm(keptAt, { force: true }).catch(() => {});
    await pruneEmpty(dirname(keptAt), this.fallbackDir);
  }

  async list(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>> {
    return this.exclusive(async () => {
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
    });
  }

  async acquireLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<LockInfo | null> {
    return this.exclusive(async () => {
      const retry = this.retrier(`lock ${environment}/${scope}`);
      for (;;) {
        await this.sync();
        const existing = await this.lockInTree(environment, scope);
        // Seen in the tree we are about to push on top of: if it is live, it really is held by that holder.
        if (existing && !lockExpired(existing)) throw new LockHeldError(existing);
        const now = Date.now();
        await this.put(lockPath(environment, scope), serialize({ holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() }));
        const latestRunId = await this.latestRunIdInTree(environment, scope);
        const outcome = await this.tryCommitAndPush(`lock ${environment}/${scope} ${holder}`);
        if (outcome === "ok") {
          this.fences.set(receiptDir(environment, scope), { holder, ttlMs, latestRunId });
          return existing;
        }
        await retry.backoff(outcome); // lost a ref race: re-fetch; the winner's lock (if any) is then seen above
      }
    });
  }

  async renewLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<void> {
    return this.exclusive(async () => {
      const retry = this.retrier(`renew ${environment}/${scope}`);
      for (;;) {
        await this.sync();
        const cur = await this.assertHolder(environment, scope, holder, ttlMs);
        if (cur) await this.put(lockPath(environment, scope), serialize({ ...cur, expiresAt: new Date(Date.now() + ttlMs).toISOString() }));
        const outcome = await this.tryCommitAndPush(`renew ${environment}/${scope} ${holder}`);
        if (outcome === "ok") {
          const fence = this.fences.get(receiptDir(environment, scope));
          if (fence && fence.holder === holder) fence.ttlMs = ttlMs;
          return;
        }
        await retry.backoff(outcome);
      }
    });
  }

  async readLock(environment: string, scope: string): Promise<LockInfo | null> {
    return this.exclusive(async () => {
      await this.sync();
      return this.lockInTree(environment, scope);
    });
  }

  async releaseLock(environment: string, scope: string, holder: string): Promise<void> {
    return this.exclusive(async () => {
      const retry = this.retrier(`unlock ${environment}/${scope}`);
      for (;;) {
        // Safe to reset the clone: any receipt this instance failed to push is already in the fallback directory.
        await this.sync();
        const existing = await this.lockInTree(environment, scope);
        if (!existing || existing.holder !== holder) break; // not ours (any more): nothing to do
        await rm(join(this.workdir, lockPath(environment, scope)), { force: true });
        const outcome = await this.tryCommitAndPush(`unlock ${environment}/${scope} ${holder}`);
        if (outcome === "ok") break;
        await retry.backoff(outcome);
      }
      this.fences.delete(receiptDir(environment, scope));
    });
  }

  // -------------------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private retrier(what: string): { backoff(outcome: Exclude<PushOutcome, "ok">): Promise<void> } {
    const started = Date.now();
    let attempts = 0;
    let rejections = 0;
    return {
      backoff: async (outcome) => {
        attempts++;
        if (outcome.kind === "rejected") rejections++;
        const delay = BACKOFF_BASE_MS / 2 + Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 16));
        const elapsed = Date.now() - started;
        if (rejections >= MAX_REMOTE_REJECTIONS || elapsed + delay > this.budgetMs) {
          const why =
            outcome.kind === "rejected"
              ? `the remote rejected the push (${outcome.detail})`
              : `lost the race for the branch ref ${attempts} times in ${elapsed}ms (budget ${this.budgetMs}ms, SPONSON_STORE_BUDGET_MS)`;
          // A hook or branch protection refusing the push is a policy decision, not contention.
          throw new SponsonError(outcome.kind === "rejected" ? "STORE_REJECTED" : "STORE_CONTENDED", stripCredentials(`Could not push ${what} to ${this.branch} at ${this.remoteForMessages}: ${why}.`), {
            branch: this.branch,
            remote: this.remoteForMessages,
            attempts,
            elapsedMs: elapsed,
            budgetMs: this.budgetMs,
          });
        }
        await sleep(delay);
      },
    };
  }

  private async lockInTree(environment: string, scope: string): Promise<LockInfo | null> {
    return parseLock(await readFile(join(this.workdir, lockPath(environment, scope)), "utf8").catch(() => ""));
  }

  private async latestRunIdInTree(environment: string, scope: string): Promise<string | null> {
    try {
      const r = JSON.parse(await readFile(join(this.workdir, latestPath(environment, scope)), "utf8")) as { runId?: unknown };
      return typeof r.runId === "string" ? r.runId : "?";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "?";
    }
  }

  /**
   * Fencing check against the freshly fetched tree. Returns the lock when `holder` holds it.
   * When the lock is gone (branch deleted or rewound by a human) and this scope's latest receipt is unchanged since we
   * took the lock (or gone with it), nobody else can have completed a run in between: re-assert it in the tree (it is pushed in the same commit,
   * so the CAS still decides) and return null. Otherwise throw LockLostError without pushing anything.
   */
  private async assertHolder(environment: string, scope: string, holder: string, ttlMs: number | null): Promise<LockInfo | null> {
    const rel = lockPath(environment, scope);
    const exists = await stat(join(this.workdir, rel)).then(() => true, () => false);
    const cur = await this.lockInTree(environment, scope);
    if (cur && cur.holder === holder) return cur;
    const fence = this.fences.get(receiptDir(environment, scope));
    if (!exists && fence && fence.holder === holder && [fence.latestRunId, null].includes(await this.latestRunIdInTree(environment, scope))) {
      const now = Date.now();
      await this.put(rel, serialize({ holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + (ttlMs ?? fence.ttlMs)).toISOString() }));
      return null;
    }
    throw new LockLostError(holder, cur);
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec("git", ["-c", "user.name=sponson", "-c", "user.email=sponson@localhost", "-c", "commit.gpgsign=false", ...args], {
        cwd: this.workdir,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    } catch (e) {
      const err = e as Error & { stderr?: string };
      const clean = new Error(stripCredentials(err.message)) as Error & { stderr?: string };
      clean.stderr = stripCredentials(String(err.stderr ?? ""));
      clean.stack = stripCredentials(String(err.stack ?? ""));
      throw clean;
    }
  }

  private async put(rel: string, content: string): Promise<void> {
    const abs = join(this.workdir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  /** Make the working clone match the remote branch exactly, creating the branch locally if it does not exist yet. */
  private async sync(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.workdir, { recursive: true });
      if (this.ownsWorkdir) removeOnExit(this.workdir);
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
      await this.git(["fetch", "-q", "--depth=1", "origin", this.branch]);
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr || (e as Error).message);
      if (/couldn't find remote ref/i.test(msg)) return this.startOrphan();
      throw this.classifyRemoteError(msg);
    }
    await this.git(["checkout", "-q", "-f", "-B", this.branch, "FETCH_HEAD"]);
    await this.git(["clean", "-qfdx"]);
  }

  /** The branch does not exist on the remote yet: an orphan with a README so humans know what it is. */
  private async startOrphan(): Promise<void> {
    await this.git(["symbolic-ref", "HEAD", `refs/heads/${this.branch}`]);
    await this.git(["update-ref", "-d", `refs/heads/${this.branch}`]).catch(() => {});
    await this.git(["rm", "-rfq", "--cached", "--ignore-unmatch", "."]).catch(() => {});
    for (const entry of await readdir(this.workdir)) if (entry !== ".git") await rm(join(this.workdir, entry), { recursive: true, force: true });
    await this.put("README.md", RECEIPTS_README);
    await this.git(["add", "-A"]);
    await this.git(["commit", "-qm", "Initialize Sponson receipts branch"]);
  }

  /** Anything other than "the branch does not exist": the repository is unreachable or we may not read it. */
  private classifyRemoteError(msg: string): Error {
    const last = stripCredentials(msg.trim().split("\n").filter(Boolean).pop() ?? "");
    const details = { remote: this.remoteForMessages, branch: this.branch };
    if (/repository not found|not found|\b404\b/i.test(msg)) {
      return new SponsonError(
        "STORE_PERMISSION",
        `Receipts remote ${this.remoteForMessages} was not found, or these credentials cannot see it (GitHub answers 404 for a private repository the token has no access to). (${last})`,
        details,
      );
    }
    if (/unable to access|could not resolve host|authentication failed|could not read username|terminal prompts disabled|\b40[13]\b|denied|does not appear to be a git repository|could not read from remote/i.test(msg)) {
      return new SponsonError("STORE_PERMISSION", `Cannot reach receipts remote ${this.remoteForMessages}: ${last}`, details);
    }
    return new Error(stripCredentials(msg));
  }

  /** Commit the working tree and push. A ref race or a server-side rejection is returned for the caller to retry. */
  private async tryCommitAndPush(message: string): Promise<PushOutcome> {
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain"]);
    if (status.trim() !== "") await this.git(["commit", "-qm", message]);
    try {
      await this.git(["push", "-q", "origin", `${this.branch}:${this.branch}`]);
      return "ok";
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      const msg = `${err.stderr ?? ""}\n${err.message}`;
      if (/\(fetch first\)|non-fast-forward|stale info|cannot lock ref|failed to update ref|incorrect old value|failed to lock|unable to update local ref/i.test(msg)) {
        return { kind: "race", detail: "non-fast-forward" };
      }
      if (/\b40[134]\b|permission to .* denied|access denied|not permitted|authentication failed|could not read username|terminal prompts disabled|repository not found|unable to access/i.test(msg)) {
        throw new SponsonError(
          "STORE_PERMISSION",
          stripCredentials(`Push to ${this.branch} was denied. In GitHub Actions, add \`permissions: { contents: write }\` to the workflow. (${msg.trim().split("\n").filter(Boolean).pop()})`),
          { branch: this.branch, remote: this.remoteForMessages },
        );
      }
      if (/remote rejected|hook declined|\[rejected\]|rejected/i.test(msg)) {
        const said = msg
          .split("\n")
          .filter((l) => /^remote:|remote rejected/.test(l.trim()))
          .map((l) => l.trim())
          .join("; ")
          .slice(0, 300);
        return { kind: "rejected", detail: stripCredentials(said || "rejected") };
      }
      throw new Error(stripCredentials(err.message));
    }
  }
}

/** Remote URLs may carry a token (`https://x-access-token:...@github.com/...`); never let one into an error message. */
function stripCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//[REDACTED]@");
}

/** Name the kept receipt in whatever error ended the write. */
function keptError(e: unknown, keptAt: string): unknown {
  const note = (msg: string) => `${/[.!?)]$/.test(msg.trim()) ? "" : "."} Receipt kept locally in ${keptAt}.`;
  if (e instanceof SponsonError) return new SponsonError(e.code, e.message + note(e.message), { ...e.details, keptAt });
  if (e instanceof LockLostError) {
    e.message += note(e.message);
    Object.assign(e, { keptAt });
    return e;
  }
  if (e instanceof Error) {
    e.message = stripCredentials(e.message) + note(e.message);
    Object.assign(e, { keptAt });
  }
  return e;
}

async function pruneEmpty(dir: string, stopAt: string): Promise<void> {
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

const ownedWorkdirs = new Set<string>();
let exitHookInstalled = false;

function removeOnExit(dir: string): void {
  ownedWorkdirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const d of ownedWorkdirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RECEIPTS_README = `# Sponson receipts

This branch is written by \`sponson apply\`. It records what each run actually did and the ledger of
resources Sponson manages per environment and scope: which resources it created, their value hashes,
and whether the run completed. It also holds each scope's lock while an apply runs.

It is an orphan branch so it never conflicts with your code. Do not merge it.

Deleting it is safe only when no apply is running (a running apply's lock lives here). Deleting it makes
Sponson forget what it created: those resources will then be reported as unmanaged, and destroy will
no longer remove them. Sponson recreates the branch on the next run.
`;
