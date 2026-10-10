import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError } from "../errors.js";
import { LockHeldError, LockLostError, type LockInfo, type Receipt, type ReceiptStore } from "../types.js";
import { latestPath, lockExpired, lockPath, parseLock, parseReceipt, receiptDir, runPath, safeSegment, serialize } from "./layout.js";

const exec = promisify(execFile);

const DEFAULT_BUDGET_MS = 60_000;
/** A push the server itself refuses (hook, protection rule) is retried a few times in case it was transient, not for the whole budget. */
const MAX_REMOTE_REJECTIONS = 4;
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 2_000;

/** Namespace of the per-scope receipts branches: `refs/heads/sponson-receipts/<environment>/<scope>`. */
export const RECEIPTS_REF_PREFIX = "sponson-receipts";
/** The single branch every scope shared before ADR 0016. Read as a fallback, never written. */
export const LEGACY_RECEIPTS_BRANCH = "sponson/receipts";

/**
 * The branch (without `refs/heads/`) holding one environment+scope's receipts and lock:
 * `sponson-receipts/<environment>/<scope>`, each segment made safe with the receipt layout's rule. A segment that
 * would still not be a valid git ref component (`.x`, `x.`, `x.lock`, `a..b`) is written as `=` + its hex; `=` never
 * occurs in a safe segment, so the mapping stays one-to-one.
 */
export function receiptsBranch(environment: string, scope: string, prefix = RECEIPTS_REF_PREFIX): string {
  return `${prefix}/${refSegment(environment)}/${refSegment(scope)}`;
}

function refSegment(s: string): string {
  const x = safeSegment(s);
  const valid = x !== "" && !x.startsWith(".") && !x.endsWith(".") && !x.endsWith(".lock") && !x.includes("..");
  return valid ? x : `=${Buffer.from(x, "utf8").toString("hex")}`;
}

/** Inverse of `refSegment`: the safe segment (the scope's directory name in the layout). */
function fromRefSegment(seg: string): string {
  return seg.startsWith("=") ? Buffer.from(seg.slice(1), "hex").toString("utf8") : seg;
}

/** Options for `GitBranchReceiptStore`; only `remote` is required. */
export interface GitBranchStoreOptions {
  /** Remote URL or path. Defaults to the `origin` of `cwd`. */
  remote: string;
  /** Namespace of the per-scope branches. Default `sponson-receipts`. */
  refPrefix?: string;
  /**
   * The pre-0016 shared branch, read (never written) for scopes that have no branch of their own yet.
   * Default `sponson/receipts`; `null` turns the fallback off.
   */
  legacyBranch?: string | null;
  /**
   * Where the working clone lives. When given, it is used as-is (and kept).
   * Default: a fresh directory per store instance (remote hash + pid + random) under `<tmpdir>/sponson-receipts/`,
   * created on first use and removed by `close()`. Processes never share a working clone.
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
 * Receipts on orphan branches of the user's repository, one per environment and scope
 * (`sponson-receipts/<environment>/<scope>`, see `receiptsBranch`; ADR 0016). Unrelated scopes never push to the
 * same ref, so they never race each other.
 *
 * A scope that has no branch yet is read from the legacy shared branch (`sponson/receipts`, same layout); the first
 * write of any kind (lock or receipt) creates the scope's branch seeded with that scope's legacy files, and nothing is
 * ever written to the legacy branch again.
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
  private readonly refPrefix: string;
  private readonly legacyBranch: string | null;
  /** The working clone. When this store owns it, it is created on first use with mkdtemp (owner-only, unpredictable). */
  private workdir: string;
  private readonly ownsWorkdir: boolean;
  private readonly budgetMs: number;
  private readonly fallbackDir: string;
  private readonly remoteForMessages: string;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fences = new Map<string, Fence>();
  /** Where the tree of the last `sync` came from when it was not the scope's own branch (the legacy branch). */
  private source: string | null = null;
  private refRaces = 0;

  constructor(private readonly options: GitBranchStoreOptions) {
    this.refPrefix = options.refPrefix ?? RECEIPTS_REF_PREFIX;
    this.legacyBranch = options.legacyBranch === undefined ? LEGACY_RECEIPTS_BRANCH : options.legacyBranch;
    const envBudget = Number(process.env.SPONSON_STORE_BUDGET_MS);
    this.budgetMs = options.budgetMs ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_BUDGET_MS);
    this.fallbackDir = options.fallbackDir ?? join(process.cwd(), ".sponson", "unpushed");
    this.remoteForMessages = stripCredentials(options.remote);
    this.ownsWorkdir = options.workdir === undefined;
    this.workdir = options.workdir ?? "";
    this.workdirPrefix = `sponson-receipts-${createHash("sha256").update(options.remote).digest("hex").slice(0, 12)}-`;
  }

  private readonly workdirPrefix: string;

  /** How many pushes of this instance lost a race for their ref and were retried (for diagnostics and tests). */
  get refRaceCount(): number {
    return this.refRaces;
  }

  /** The working clone this instance uses (for diagnostics and tests). */
  get workingClone(): string {
    return this.workdir;
  }

  /** The `origin` remote URL of the repository at `cwd`, or null; the CLI's default receipts remote. */
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
      const branch = await this.sync(environment, scope);
      const rel = latestPath(environment, scope);
      try {
        return parseReceipt(await readFile(join(this.workdir, rel), "utf8"), `${this.source ?? branch}:${rel}`);
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
        const retry = this.retrier(`receipt ${environment}/${scope}`, environment, scope);
        for (;;) {
          const branch = await this.sync(environment, scope);
          if (opts.holder !== undefined) await this.assertHolder(environment, scope, opts.holder, null);
          await this.put(runPath(environment, scope, runId), serialize(receipt));
          await this.put(latestPath(environment, scope), serialize(receipt));
          const outcome = await this.tryCommitAndPush(branch, `receipt ${environment}/${scope} ${runId} (${receipt.status})`);
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

  /**
   * Every scope of `environment` with a readable latest receipt: one `ls-remote` to find the scopes' branches (and
   * the legacy branch), one shallow fetch of all of them, one `cat-file` to read them. Scopes that have no branch of
   * their own yet are taken from the legacy branch.
   */
  async list(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>> {
    return this.exclusive(async () => {
      await this.init();
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.listOnce(environment);
        } catch (e) {
          // A branch deleted between ls-remote and fetch: look again (a few times; then report it).
          if (attempt < 3 && e instanceof GitCommandError && /couldn't find remote ref/i.test(e.stderr || e.message)) continue;
          if (e instanceof GitCommandError) throw this.classifyRemoteError(e.stderr || e.message, null);
          throw e;
        }
      }
    });
  }

  async acquireLock(environment: string, scope: string, holder: string, ttlMs: number): Promise<LockInfo | null> {
    return this.exclusive(async () => {
      const retry = this.retrier(`lock ${environment}/${scope}`, environment, scope);
      for (;;) {
        const branch = await this.sync(environment, scope);
        const existing = await this.lockInTree(environment, scope);
        // Seen in the tree we are about to push on top of: if it is live, it really is held by that holder.
        if (existing && !lockExpired(existing)) throw new LockHeldError(existing);
        const now = Date.now();
        await this.put(lockPath(environment, scope), serialize({ holder, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() }));
        const latestRunId = await this.latestRunIdInTree(environment, scope);
        const outcome = await this.tryCommitAndPush(branch, `lock ${environment}/${scope} ${holder}`);
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
      const retry = this.retrier(`renew ${environment}/${scope}`, environment, scope);
      for (;;) {
        const branch = await this.sync(environment, scope);
        const cur = await this.assertHolder(environment, scope, holder, ttlMs);
        if (cur) await this.put(lockPath(environment, scope), serialize({ ...cur, expiresAt: new Date(Date.now() + ttlMs).toISOString() }));
        const outcome = await this.tryCommitAndPush(branch, `renew ${environment}/${scope} ${holder}`);
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
      await this.sync(environment, scope);
      return this.lockInTree(environment, scope);
    });
  }

  async releaseLock(environment: string, scope: string, holder: string): Promise<void> {
    return this.exclusive(async () => {
      const retry = this.retrier(`unlock ${environment}/${scope}`, environment, scope);
      for (;;) {
        // Safe to reset the clone: any receipt this instance failed to push is already in the fallback directory.
        const branch = await this.sync(environment, scope);
        const existing = await this.lockInTree(environment, scope);
        if (!existing || existing.holder !== holder) break; // not ours (any more): nothing to do
        await rm(join(this.workdir, lockPath(environment, scope)), { force: true });
        const outcome = await this.tryCommitAndPush(branch, `unlock ${environment}/${scope} ${holder}`);
        if (outcome === "ok") break;
        await retry.backoff(outcome);
      }
      this.fences.delete(receiptDir(environment, scope));
    });
  }

  /**
   * Remove the working clone this instance created (a `workdir` you passed is kept). Call it when done with the
   * store: an MCP server builds one per tool call. Using the store again afterwards starts a fresh clone.
   */
  async close(): Promise<void> {
    return this.exclusive(async () => {
      if (this.ownsWorkdir && this.workdir) {
        await rm(this.workdir, { recursive: true, force: true });
        this.workdir = ""; // the next use makes a fresh mkdtemp directory, never a recreated, known path
      }
      this.initialized = false;
    });
  }

  // -------------------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private retrier(what: string, environment: string, scope: string): { backoff(outcome: Exclude<PushOutcome, "ok">): Promise<void> } {
    const started = Date.now();
    const branch = receiptsBranch(environment, scope, this.refPrefix);
    let attempts = 0;
    let rejections = 0;
    return {
      backoff: async (outcome) => {
        attempts++;
        if (outcome.kind === "rejected") rejections++;
        else this.refRaces++;
        const delay = BACKOFF_BASE_MS / 2 + Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 16));
        const elapsed = Date.now() - started;
        if (rejections >= MAX_REMOTE_REJECTIONS || elapsed + delay > this.budgetMs) {
          const why =
            outcome.kind === "rejected"
              ? `the remote rejected the push (${outcome.detail})`
              : `lost the race for the branch ref ${attempts} times in ${elapsed}ms (budget ${this.budgetMs}ms, SPONSON_STORE_BUDGET_MS)`;
          // A hook or branch protection refusing the push is a policy decision, not contention.
          throw new SponsonError(outcome.kind === "rejected" ? "STORE_REJECTED" : "STORE_CONTENDED", stripCredentials(`Could not push ${what} to ${branch} at ${this.remoteForMessages}: ${why}.`), {
            branch,
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

  private async git(args: string[], input?: Buffer): Promise<string> {
    return (await this.gitRaw(args, input)).toString("utf8");
  }

  private gitRaw(args: string[], input?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        ["-c", "user.name=sponson", "-c", "user.email=sponson@localhost", "-c", "commit.gpgsign=false", ...args],
        { cwd: this.workdir, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const clean = new GitCommandError(stripCredentials(err.message), stripCredentials(stderr.toString("utf8")));
          clean.stack = stripCredentials(err.stack ?? "");
          reject(clean);
        },
      );
      // git may exit before reading its input (an error): that is reported through the callback, not as EPIPE.
      child.stdin?.on("error", () => {});
      if (input) child.stdin?.end(input);
      else child.stdin?.end();
    });
  }

  private async put(rel: string, content: string): Promise<void> {
    const abs = join(this.workdir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    // A directory under the shared temp dir with a predictable name could be pre-created (or symlinked) by another
    // user; mkdtemp makes a fresh, owner-only directory with an unguessable name.
    if (this.ownsWorkdir && !this.workdir) this.workdir = await mkdtemp(join(tmpdir(), this.workdirPrefix));
    await mkdir(this.workdir, { recursive: true });
    const isRepo = await stat(join(this.workdir, ".git")).then(() => true, () => false);
    if (!isRepo) {
      // reftable stores refs in its own files, so refs that differ only by case (scopes `branch-Feature` and
      // `branch-feature`) coexist even on a case-insensitive filesystem, where recent git otherwise refuses to fetch
      // them at all. Older git (before 2.45) has no reftable — and no such refusal; position-named list refs suffice.
      await this.git(["init", "-q", "--ref-format=reftable"]).catch(() => this.git(["init", "-q"]));
      await this.git(["remote", "add", "origin", this.options.remote]);
    } else {
      await this.git(["remote", "set-url", "origin", this.options.remote]);
    }
    this.initialized = true;
  }

  /**
   * Make the working clone match the scope's remote branch exactly. When the branch does not exist yet, start it
   * locally (seeded from the legacy branch); it reaches the remote with the first push. Returns the branch name.
   */
  private async sync(environment: string, scope: string): Promise<string> {
    await this.init();
    const branch = receiptsBranch(environment, scope, this.refPrefix);
    this.source = null;
    try {
      await this.git(["fetch", "-q", "--depth=1", "origin", `refs/heads/${branch}`]);
    } catch (e) {
      const msg = e instanceof GitCommandError ? e.stderr || e.message : String(e);
      if (/couldn't find remote ref/i.test(msg)) {
        await this.startOrphan(environment, scope, branch);
        return branch;
      }
      throw this.classifyRemoteError(msg, branch);
    }
    await this.git(["checkout", "-q", "-f", "-B", branch, "FETCH_HEAD"]);
    await this.git(["clean", "-qfdx"]);
    return branch;
  }

  /**
   * The scope's branch does not exist on the remote yet: an orphan with a README so humans know what it is, carrying
   * this scope's files from the legacy branch (all but its lock) when there are any. That is the whole migration: the
   * first push for the scope publishes them on its own branch.
   */
  private async startOrphan(environment: string, scope: string, branch: string): Promise<void> {
    await this.git(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    await this.git(["update-ref", "-d", `refs/heads/${branch}`]).catch(() => {});
    await this.git(["rm", "-rfq", "--cached", "--ignore-unmatch", "."]).catch(() => {});
    for (const entry of await readdir(this.workdir)) if (entry !== ".git") await rm(join(this.workdir, entry), { recursive: true, force: true });
    await this.put("README.md", RECEIPTS_README);
    const migrated = await this.seedFromLegacy(environment, scope);
    await this.git(["add", "-A"]);
    await this.git(["commit", "-qm", migrated ? `Start receipts for ${environment}/${scope} (from ${this.legacyBranch})` : `Start receipts for ${environment}/${scope}`]);
  }

  /**
   * Copy `<env>/<scope>/` from the legacy branch into the working tree; false when there is nothing. A live legacy
   * lock is carried over, so acquire/read see it exactly like a lock on the scope's own branch (an older Sponson may
   * be mid-apply at upgrade time); only an expired or unreadable one is dropped.
   */
  private async seedFromLegacy(environment: string, scope: string): Promise<boolean> {
    if (this.legacyBranch === null) return false;
    try {
      await this.git(["fetch", "-q", "--depth=1", "origin", `refs/heads/${this.legacyBranch}`]);
    } catch (e) {
      const msg = e instanceof GitCommandError ? e.stderr || e.message : String(e);
      if (/couldn't find remote ref/i.test(msg)) return false;
      throw this.classifyRemoteError(msg, this.legacyBranch);
    }
    const dir = receiptDir(environment, scope);
    const lockFile = lockPath(environment, scope);
    const files = (await this.git(["ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", `${dir}/`])).split("\n").filter(Boolean);
    if (files.length === 0) return false;
    const legacyLock = files.includes(lockFile) ? parseLock(await this.git(["show", `FETCH_HEAD:${lockFile}`])) : null;
    const liveLock = legacyLock !== null && !lockExpired(legacyLock);
    if (!liveLock && !files.some((f) => f !== lockFile)) return false;
    await this.git(["checkout", "-q", "FETCH_HEAD", "--", `${dir}/`]);
    if (!liveLock) {
      await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", lockFile]);
      await rm(join(this.workdir, lockFile), { force: true });
    }
    this.source = this.legacyBranch;
    return true;
  }

  private async listOnce(environment: string): Promise<Array<{ scope: string; receipt: Receipt }>> {
    const envSeg = refSegment(environment);
    const prefix = `refs/heads/${this.refPrefix}/${envSeg}/`;
    const legacyRef = this.legacyBranch === null ? null : `refs/heads/${this.legacyBranch}`;
    const advertised = (await this.git(["ls-remote", "origin", `${prefix}*`, ...(legacyRef ? [legacyRef] : [])]))
      .split("\n")
      .map((l) => l.split("\t")[1]?.trim())
      .filter((r): r is string => !!r);
    const scopeRefs = advertised.filter((r) => r.startsWith(prefix) && !r.slice(prefix.length).includes("/"));
    const hasLegacy = legacyRef !== null && advertised.includes(legacyRef);
    if (scopeRefs.length === 0 && !hasLegacy) return [];

    // Local names are by position, not by scope name: on a case-insensitive filesystem (macOS, Windows) the loose
    // refs `…/branch-Feature` and `…/branch-feature` would be one file, and one scope would silently vanish.
    const local = (i: number) => `refs/sponson-list/${envSeg}/${i}`;
    const legacyLocal = "refs/sponson-list-legacy";
    await this.git(["update-ref", "-d", legacyLocal]).catch(() => undefined);
    for (const ref of (await this.git(["for-each-ref", "--format=%(refname)", `refs/sponson-list/${envSeg}/`])).split("\n").filter(Boolean)) {
      await this.git(["update-ref", "-d", ref]);
    }
    const refspecs = [...scopeRefs.map((r, i) => `+${r}:${local(i)}`), ...(hasLegacy ? [`+${legacyRef}:${legacyLocal}`] : [])];
    await this.git(["fetch", "-q", "--depth=1", "origin", ...refspecs]);

    const envDir = safeSegment(environment);
    const wanted: Array<{ scope: string; object: string }> = [];
    const own = new Set<string>();
    for (const [i, ref] of scopeRefs.entries()) {
      const scope = fromRefSegment(ref.slice(prefix.length));
      own.add(scope);
      wanted.push({ scope, object: `${local(i)}:${envDir}/${scope}/latest.json` });
    }
    if (hasLegacy) {
      const dirs = (await this.git(["ls-tree", "-d", "--name-only", legacyLocal, "--", `${envDir}/`])).split("\n").filter(Boolean);
      for (const d of dirs) {
        const scope = d.slice(envDir.length + 1);
        if (!own.has(scope)) wanted.push({ scope, object: `${legacyLocal}:${envDir}/${scope}/latest.json` });
      }
    }
    const blobs = await this.catFiles(wanted.map((w) => w.object));
    const out: Array<{ scope: string; receipt: Receipt }> = [];
    for (const [i, w] of wanted.entries()) {
      const text = blobs[i];
      if (text === null || text === undefined) continue;
      try {
        out.push({ scope: w.scope, receipt: parseReceipt(text, w.object) });
      } catch {
        /* skip scopes without a readable latest */
      }
    }
    return out.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  }

  /** Read many blobs in one `git cat-file --batch`; null for each one that does not exist. */
  private async catFiles(objects: string[]): Promise<Array<string | null>> {
    if (objects.length === 0) return [];
    const raw = await this.gitRaw(["cat-file", "--batch"], Buffer.from(objects.map((o) => `${o}\n`).join(""), "utf8"));
    const out: Array<string | null> = [];
    let pos = 0;
    for (let i = 0; i < objects.length; i++) {
      const nl = raw.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = raw.subarray(pos, nl).toString("utf8");
      pos = nl + 1;
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) {
        out.push(null); // "<object> missing" (or ambiguous)
        continue;
      }
      const size = Number(m[2]);
      out.push(m[1] === "blob" ? raw.subarray(pos, pos + size).toString("utf8") : null);
      pos += size + 1;
    }
    return out;
  }

  /** Anything other than "the branch does not exist": the repository is unreachable or we may not read it. */
  private classifyRemoteError(msg: string, branch: string | null): Error {
    const last = stripCredentials(msg.trim().split("\n").filter(Boolean).pop() ?? "");
    const details = { remote: this.remoteForMessages, branch: branch ?? `${this.refPrefix}/*` };
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
  private async tryCommitAndPush(branch: string, message: string): Promise<PushOutcome> {
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain"]);
    if (status.trim() !== "") await this.git(["commit", "-qm", message]);
    try {
      await this.git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
      return "ok";
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      const msg = `${e.stderr}\n${e.message}`;
      if (/\(fetch first\)|non-fast-forward|stale info|cannot lock ref|failed to update ref|incorrect old value|failed to lock|unable to update local ref/i.test(msg)) {
        return { kind: "race", detail: "non-fast-forward" };
      }
      if (/\b40[134]\b|permission to .* denied|access denied|not permitted|authentication failed|could not read username|terminal prompts disabled|repository not found|unable to access/i.test(msg)) {
        throw new SponsonError(
          "STORE_PERMISSION",
          stripCredentials(`Push to ${branch} was denied. In GitHub Actions, add \`permissions: { contents: write }\` to the workflow. (${msg.trim().split("\n").filter(Boolean).pop()})`),
          { branch, remote: this.remoteForMessages },
        );
      }
      if (/remote rejected|hook declined|\[rejected\]|rejected/i.test(msg)) {
        const said = msg
          .split("\n")
          .filter((l) => l.trim().startsWith("remote:") || l.includes("remote rejected"))
          .map((l) => l.trim())
          .join("; ")
          .slice(0, 300);
        return { kind: "rejected", detail: stripCredentials(said || "rejected") };
      }
      throw new Error(stripCredentials(e.message));
    }
  }
}

/** A failed `git` invocation, with credentials already stripped from every field. */
class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
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

/**
 * Written once at the root of every scope's branch. Every copy is the same blob, so git stores it once however many
 * branches there are; it is there because each branch is listed on its own in the hosting UI, and a human who opens
 * one should learn what it is and whether deleting it is safe.
 */
const RECEIPTS_README = `# Sponson receipts

This branch is written by \`sponson apply\`. It holds the receipts of one environment and scope (the
\`<environment>/<scope>/\` directory): what each run actually did, the ledger of resources Sponson manages
there (which resources it created, their value hashes), and whether the run completed. It also holds the
scope's lock while an apply runs. Every scope has its own \`sponson-receipts/<environment>/<scope>\` branch,
so runs for unrelated pull requests never wait on each other.

It is an orphan branch so it never conflicts with your code. Do not merge it.

Deleting it is safe only when no apply is running for this scope (a running apply's lock lives here).
Deleting it makes Sponson forget what it created in this scope: those resources will then be reported as
unmanaged, and destroy will no longer remove them. Sponson recreates the branch on the next run.
`;
