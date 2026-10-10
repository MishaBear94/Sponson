# 16. One receipts branch per environment and scope

Date: 2026-10-10

## Status

Accepted. Amends [ADR 0003](0003-receipts-on-an-orphan-git-branch.md).

## Context

[ADR 0003](0003-receipts-on-an-orphan-git-branch.md) put every scope's receipts and locks on one orphan branch,
`sponson/receipts`. Each run adds its own files, so scopes never conflict on content, but every push is a
compare-and-swap on the same ref. An apply pushes at least three times (lock, write-ahead checkpoint and final
receipt, unlock) plus a lease renewal every TTL/3, and every push that loses a race fetches, re-checks and tries
again. With eight pull requests applying at once, 24 or more pushes serialize on that one ref; on a loaded machine
the store legitimately ran out of its budget and reported `STORE_CONTENDED` for runs that had nothing to do with
each other. The stress tests (`stores.test.ts` "eight scopes …", `journeys/concurrency/push-contention`) failed for
that reason alone.

The contention is not a property of the problem. Fencing needs the lock check and the receipt write of *one scope*
to land atomically; nothing needs two scopes to share a ref. The coupling came from the storage layout.

Options considered:

| Option | Why not |
|---|---|
| keep one branch, raise the budget | hides the coupling; total time still grows with the number of concurrent scopes |
| one branch per scope as `sponson/receipts/<env>/<scope>` | a ref cannot be both a file and a directory: it collides with the existing `sponson/receipts` branch, so no repository could hold both during migration |
| refs outside `refs/heads/` (`refs/sponson/...`) | not shown by hosting UIs, not covered by every host's token permissions and branch rules in the same way as branches; `contents: write` is known to cover branches |
| one branch per environment | still couples every pull request of `preview`, which is where the concurrency is |

## Decision

- Every environment and scope gets its own orphan branch, `refs/heads/sponson-receipts/<env>/<scope>`
  (`receiptsBranch()` in `packages/core/src/receipts/git.ts`). The namespace `sponson-receipts/` is separate from the
  legacy branch name, so both can exist at once. Segments are made safe with the receipt layout's rule
  (`safeSegment()`: runs of characters outside `[a-zA-Z0-9._-]` become `-`); a segment that would still be an invalid
  ref component (`.x`, `x.`, `x.lock`, `a..b`) is written as `=` followed by its hex, which no safe segment contains,
  so the mapping stays one-to-one and reversible.
- Inside the branch the layout is unchanged (`<env>/<scope>/latest.json`, `<runId>.json`, `lock.json`), so the
  layout helpers, the fallback directory for unpushed receipts and the local store stay as they are, and a checkout of
  one branch is self-describing.
- Each branch holds that scope's lock and receipts, so fencing (lock check and receipt in the same push) works per
  scope exactly as before. Budgeted backoff, the `STORE_CONTENDED` / `STORE_REJECTED` / `STORE_PERMISSION`
  classification, credential stripping, the per-process working clone, the durable fallback and `close()` are
  unchanged; a working clone checks out whichever scope branch the current operation needs.
- Each new branch starts with the same `README.md`. It is one blob shared by every branch, so it costs nothing after
  the first; it is there because a hosting UI lists every branch on its own and a human who opens one should learn
  what it is and when deleting it is safe.
- `list(environment)` runs one `git ls-remote origin 'refs/heads/sponson-receipts/<env>/*' refs/heads/sponson/receipts`,
  one shallow fetch of everything it found (a glob refspec with `--prune`), and one `git cat-file --batch` to read
  every `latest.json`.

Migration from the shared branch is automatic and per scope:

- When a scope has no branch of its own, `read`, `readLock` and `list` fall back to the legacy branch's
  `<env>/<scope>/` directory.
- The first write of any kind for that scope (usually the lock of the next apply) creates the scope's branch,
  seeded with that scope's legacy files except its `lock.json`. From then on the scope's own branch is the only
  source; a scope that has its own branch is never read from the legacy branch, and `list` takes legacy entries only
  for scopes without one.
- Nothing is ever written to the legacy branch again. Once no scope reads from it (every scope with receipts there
  has run since the upgrade, or was destroyed), it can be deleted. `GitBranchStoreOptions.legacyBranch: null` turns
  the fallback off.

## Consequences

- Unrelated scopes never push to the same ref, so they never retry against each other: the stress tests now show no
  ref race at all between scopes, and each scope's branch history contains only that scope's commits. Contention
  remains only where it is real, between runs of the same scope, and the lock decides those.
- A repository gets one branch per environment and scope ever applied, listed in the hosting UI. Nothing prunes the
  branches of destroyed scopes yet: their last receipt is the record that the scope was destroyed, and deleting the
  branch would make a later run forget it. A cleanup command is left for later.
- Workflows and branch rules that named `sponson/receipts` (for example an `on: push` filter that ignores it) must use
  the pattern `sponson-receipts/**` instead. The example workflow filters `push` to `main`, so it needs no change.
- Mixing Sponson versions on one repository is not supported across this change: an older Sponson reads and writes
  only `sponson/receipts`, so it would not see receipts written to a scope's own branch. Upgrade every runner.
- Deleting a scope's branch while the legacy branch still has that scope makes Sponson fall back to the legacy copy,
  which is older. Delete the legacy branch once migration is done.
- `GitBranchStoreOptions.branch` is replaced by `refPrefix` (default `sponson-receipts`) and `legacyBranch`
  (default `sponson/receipts`).
