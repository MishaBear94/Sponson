/**
 * The git plumbing under `GitBranchReceiptStore`: one working clone of the receipts remote, git invocations with
 * credentials stripped from every error, and what the remote's answers mean. Receipts, locks and fencing are the
 * store's business; nothing here knows about them.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SponsonError } from "../errors.js";

/** How a push ended: done, lost the race for the ref (retry on a fresh fetch), or refused by the remote. */
export type PushOutcome = "ok" | { kind: "race" | "rejected"; detail: string };

/** A failed `git` invocation, with credentials already stripped from every field. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Remote URLs may carry a token (`https://x-access-token:...@github.com/...`); never let one into an error message. */
export function stripCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//[REDACTED]@");
}

/** True when git's error says the remote has no such ref. */
export function isMissingRef(e: unknown): boolean {
  return e instanceof GitCommandError && /couldn't find remote ref/i.test(e.stderr || e.message);
}

export class GitWorkdir {
  /** The remote as error messages show it: without credentials. */
  readonly remoteForMessages: string;
  private dir: string;
  private readonly owned: boolean;
  private readonly prefix: string;
  private initialized = false;

  /** `dir` undefined: this instance creates (with mkdtemp) and removes its own clone. */
  constructor(
    private readonly remote: string,
    dir: string | undefined,
  ) {
    this.remoteForMessages = stripCredentials(remote);
    this.owned = dir === undefined;
    this.dir = dir ?? "";
    this.prefix = `sponson-receipts-${createHash("sha256").update(remote).digest("hex").slice(0, 12)}-`;
  }

  /** The clone's directory ("" until first use when this instance owns it). */
  get path(): string {
    return this.dir;
  }

  /** Absolute path of a file in the working tree. */
  file(rel: string): string {
    return join(this.dir, rel);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    // A directory under the shared temp dir with a predictable name could be pre-created (or symlinked) by another
    // user; mkdtemp makes a fresh, owner-only directory with an unguessable name.
    if (this.owned && !this.dir) this.dir = await mkdtemp(join(tmpdir(), this.prefix));
    await mkdir(this.dir, { recursive: true });
    const isRepo = await stat(join(this.dir, ".git")).then(() => true, () => false);
    if (!isRepo) {
      // reftable stores refs in its own files, so refs that differ only by case (scopes `branch-Feature` and
      // `branch-feature`) coexist even on a case-insensitive filesystem, where recent git otherwise refuses to fetch
      // them at all. Older git (before 2.45) has no reftable — and no such refusal; position-named list refs suffice.
      await this.git(["init", "-q", "--ref-format=reftable"]).catch(() => this.git(["init", "-q"]));
      await this.git(["remote", "add", "origin", this.remote]);
    } else {
      await this.git(["remote", "set-url", "origin", this.remote]);
    }
    this.initialized = true;
  }

  /** Remove the clone when this instance created it; the next use makes a fresh mkdtemp directory. */
  async close(): Promise<void> {
    if (this.owned && this.dir) {
      await rm(this.dir, { recursive: true, force: true });
      this.dir = ""; // never a recreated, known path
    }
    this.initialized = false;
  }

  async git(args: string[], input?: Buffer): Promise<string> {
    return (await this.gitRaw(args, input)).toString("utf8");
  }

  gitRaw(args: string[], input?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        ["-c", "user.name=sponson", "-c", "user.email=sponson@localhost", "-c", "commit.gpgsign=false", ...args],
        { cwd: this.dir, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
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

  /** Write a file of the working tree, creating its directories. */
  async put(rel: string, content: string): Promise<void> {
    const abs = this.file(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  /** Shallow-fetch `refs/heads/<branch>` into FETCH_HEAD; false when the remote has no such branch. */
  async fetchBranch(branch: string): Promise<boolean> {
    try {
      await this.git(["fetch", "-q", "--depth=1", "origin", `refs/heads/${branch}`]);
      return true;
    } catch (e) {
      if (isMissingRef(e)) return false;
      throw this.remoteError(e instanceof GitCommandError ? e.stderr || e.message : String(e), branch);
    }
  }

  /** Read many blobs in one `git cat-file --batch`; null for each one that does not exist. */
  async catFiles(objects: string[]): Promise<Array<string | null>> {
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
  remoteError(msg: string, branch: string): Error {
    const last = stripCredentials(msg.trim().split("\n").filter(Boolean).pop() ?? "");
    const details = { remote: this.remoteForMessages, branch };
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
  async commitAndPush(branch: string, message: string): Promise<PushOutcome> {
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain"]);
    if (status.trim() !== "") await this.git(["commit", "-qm", message]);
    try {
      await this.git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
      return "ok";
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      return this.pushOutcome(`${e.stderr}\n${e.message}`, branch, e);
    }
  }

  /** What a failed push means: retry (race, rejection) or stop (no permission, anything else). */
  private pushOutcome(msg: string, branch: string, e: GitCommandError): PushOutcome {
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
