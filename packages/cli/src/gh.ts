/**
 * GitHub Actions secrets through the user's own `gh` CLI, for `sponson init --setup`. Sponson holds no GitHub
 * credential: `gh` uses the login its owner already has.
 *
 * The value goes to `gh secret set NAME --repo OWNER/REPO` on stdin, and nowhere else: never in argv (which `ps` and
 * shell history show), never in the child's environment (the variables the setup collected are removed from it, so a
 * token that arrived in this process's environment does not travel on), never in what is printed or logged.
 */
import { spawn } from "node:child_process";

/** `owner/repo` of a GitHub remote URL (https, ssh or scp-like), or null for any other host. */
export function githubRepoOf(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]!}/${m[2]!}` : null;
}

/** How one `gh secret set` ended. */
export type GhOutcome = { ok: true } | { ok: false; reason: "gh-missing" | "failed"; message: string };

/**
 * Store `value` as the Actions secret `name` of `repo` with `gh secret set`, the value on stdin. `env` is the
 * environment the child gets, already without the collected credentials (see `childEnv`). gh's own output is
 * returned only on failure, and the caller redacts it like everything else.
 */
export function ghSecretSet(name: string, value: string, repo: string, env: NodeJS.ProcessEnv, cwd: string): Promise<GhOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", ["secret", "set", name, "--repo", repo], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, reason: "gh-missing", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out = (out + c.toString()).slice(-2000)));
    child.stderr.on("data", (c: Buffer) => (out = (out + c.toString()).slice(-2000)));
    child.on("error", (e: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: e.code === "ENOENT" ? "gh-missing" : "failed", message: e.code === "ENOENT" ? "the `gh` CLI is not installed or not on PATH (https://cli.github.com)" : e.message });
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: "failed", message: `gh exited with ${String(code)}: ${out.trim().split("\n").slice(-3).join(" ")}` });
    });
    // gh reads the secret's value from stdin when it is not a terminal and no --body is given.
    child.stdin.on("error", () => {});
    child.stdin.end(value);
  });
}

/** `env` without `names`: what a child process gets, so a collected credential never travels in its environment. */
export function childEnv(env: NodeJS.ProcessEnv, names: Iterable<string>): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const n of names) delete out[n];
  return out;
}
