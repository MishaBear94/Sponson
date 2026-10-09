/**
 * Many PRs apply at the same moment (a dependabot batch, a rebase of a stack), each on its own CI runner with its
 * own clone, all pushing to the one `sponson/receipts` branch.
 * Design: concurrent PRs have no content conflicts, only a race for the ref; a rejected push fetches, rebases and
 * pushes again — distinct
 * scopes are independent; a ref race must never fail a run or lose a receipt.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { applyRun, GitBranchReceiptStore } from "@sponson/core";
import { bareRemote, checkout, ctxArgs, engineOpts, neonBranches, remoteFile, spawnCli, tmp } from "./helpers.js";
import { cliEnv } from "../../support.js";

let sim: SimHandle;
afterEach(async () => sim?.close());

describe("push contention across scopes", () => {
  it("eight PRs on eight runners apply at once: every run completes and every scope has its receipt and no stale lock", async () => {
    sim = await startSim();
    const remote = await bareRemote();
    const prs = [101, 102, 103, 104, 105, 106, 107, 108];
    const runs = await Promise.all(
      prs.map(async (pr) => {
        const cwd = await checkout();
        return spawnCli(["apply", "--json", "--receipts", "git-branch", "--receipts-remote", remote, ...ctxArgs(pr)], cwd, cliEnv(sim, { TMPDIR: await tmp(`ci-${pr}`) })).done;
      }),
    );
    const summary: Record<number, string> = {};
    for (const [i, r] of runs.entries()) summary[prs[i]!] = r.code === 0 ? "ok" : `exit ${r.code}: ${r.json?.error?.code ?? ""} ${r.json?.error?.message ?? r.stderr.trim().split("\n").pop()}`;
    expect(summary).toEqual(Object.fromEntries(prs.map((p) => [p, "ok"])));
    for (const pr of prs) {
      const latest = await remoteFile(remote, `preview/pr-${pr}/latest.json`);
      expect(latest, `receipt for pr-${pr}`).not.toBeNull();
      expect(await remoteFile(remote, `preview/pr-${pr}/lock.json`), `stale lock for pr-${pr}`).toBeNull();
    }
    expect(neonBranches(sim).filter((n) => n.startsWith("sponson/")).sort()).toEqual(prs.map((p) => `sponson/preview/pr-${p}`).sort());
  });

  it("when the receipt push keeps failing, the receipt really is 'kept locally' as the error says, and the error names what was created", async () => {
    // Error text in git.ts: "Could not push to … Receipt kept locally in <workdir>." A user (or agent) will go look there.
    sim = await startSim();
    const remote = await bareRemote();
    // Server-side hook: accept lock/unlock pushes, reject any push that adds a receipt (a branch-protection rule,
    // a pre-receive size check, or simply losing the ref race five times in a row all look like this to the client).
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, `#!/bin/sh\nwhile read old new ref; do\n  if git diff --name-only "$old" "$new" 2>/dev/null | grep -q latest.json; then echo "rejected: receipts frozen" >&2; exit 1; fi\ndone\nexit 0\n`);
    await chmod(hook, 0o755);
    const workdir = await tmp("kept-wd");
    const fallbackDir = await tmp("kept-fallback");
    const cwd = await checkout();
    const err = await applyRun(await engineOpts(cwd, cliEnv(sim), 120, new GitBranchReceiptStore({ remote, workdir, fallbackDir }))).then(
      () => null,
      (e: Error & { code?: string; details?: Record<string, unknown> }) => e,
    );
    expect(err, "apply should fail to write its receipt").not.toBeNull();
    expect(err!.message).toMatch(/kept locally/);
    // v2: the unpushed receipt is kept at `<fallbackDir>/<env>/<scope>/<runId>.json`, named in
    // `details.keptAt` and the message. The checkpoint receipt is written *before* every create, so a receipt push that
    // can never land stops the run before the cloud is touched: nothing exists without a record.
    const keptAt = (err as { details?: { keptAt?: string } }).details?.keptAt;
    expect(keptAt, "error.details.keptAt").toEqual(expect.stringContaining(join(fallbackDir, "preview", "pr-120")));
    expect(err!.message).toContain(keptAt!);
    const kept = await readFile(keptAt!, "utf8").catch(() => null);
    expect(kept, `receipt promised in ${keptAt} is gone`).not.toBeNull();
    expect(JSON.parse(kept!)).toMatchObject({ version: 2, scope: "pr-120" });
    if (neonBranches(sim).includes("sponson/preview/pr-120")) {
      // If anything was created anyway, the failure must say which cloud resource now exists without a pushed receipt.
      expect(`${err!.message} ${JSON.stringify((err as { details?: unknown }).details ?? {})}`).toMatch(/sponson\/preview\/pr-120|Neon branch/);
      expect(kept).toContain("sponson/preview/pr-120");
    }
  });
});
