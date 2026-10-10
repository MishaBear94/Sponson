# 5. Receipts are a ledger keyed by resource identity, with write-ahead intents

Date: 2026-10-10

## Status

Accepted. Introduced in v0.2; receipts are version 2, and version 1 receipts are migrated when read.

## Context

In v0.1 a receipt was a snapshot of the last run, organised by plan line and rebuilt on every run. Testing along six
independent dimensions (lifecycle, concurrency, providers, agents, humans, secrets) produced about a hundred
failures, and most of them came from that one shape:

- a failed, skipped or refused line wrote `resources: []`, so the next run forgot what it had created, and a
  resource Sponson created was later treated as adopted and leaked on destroy;
- after a crash, a lost response or a lost lock, a resource that had been created was never recorded at all;
- renaming a line, splitting it, moving a key between lines, or changing a name, target or project lost track of the
  resource or misjudged it;
- a resource a human deleted and re-created under the same name was taken for Sponson's and deleted;
- outputs that arrived later (a preview URL) never reached the receipt.

## Decision

A receipt carries a **ledger**: every resource Sponson knows about in one environment and scope, independent of plan
lines and of any single run (`LedgerEntry` in `packages/core/src/types.ts`, `Ledger` in
`packages/core/src/engine/ledger.ts`).

- **Identity** is adapter + provider block (project, team) + the adapter's key. Keys must include every dimension that
  makes two resources distinct at the provider (Vercel: target, git branch and name).
- Each entry records the provider's id, a keyed hash of the value, the owning line (or `orphan`), the last known
  non-sensitive outputs, and `createdBy`: `sponson`, `adopted` or `intent`.
- **The ledger is carried forward.** A run starts from the previous ledger and changes only entries it observed or
  wrote. Failed, skipped, waiting and refused lines leave their entries as they were.
- **Write-ahead intents.** An adapter calls `actx.intend(keys)` immediately before sending a create. The engine adds
  the keys as `intent` entries and writes a checkpoint receipt before the request is sent. On success they become
  `sponson`; if the outcome is unknown, the next run (or the rollback, or destroy) re-reads the line and claims the
  resource if it exists or drops the intent if it does not.
- **The provider id takes part in drift.** Same key, different id means replaced outside Sponson: reported as
  `changed` with `replaced: true`, and not Sponson's.
- **Destroy works from the ledger**, using the provider block recorded with each entry, not the current plan.
- Value hashes are HMACs keyed with a random per-scope `hashKey`, so a receipt cannot be used to confirm a guessed
  low-entropy secret.

## Consequences

- Nothing Sponson created can be forgotten, whatever crashed, failed or was lost: property invariant I8 checks that
  after a successful destroy nothing Sponson created survives.
- Plan refactors (renamed ids, moved keys) keep ownership, because ownership follows the resource, not the line.
- Every adapter must call `intend` before a create and return `created` keys that are a subset of what it announced;
  CONTRIBUTING.md lists this among the rules the engine relies on.
- A receipt write happens before every create, which costs a store round trip per create.
- The receipt has two views, `lines` (what this run did) and `ledger` (what is managed now), and agents read outputs
  from either.
