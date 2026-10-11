# Architecture decision records

Each record states one decision: the context that forced it, what was decided, and what follows from it (Michael
Nygard's format). They explain *why* the code is the way it is; [ARCHITECTURE.md](../../ARCHITECTURE.md) explains
*where* it is.

| # | Decision | Status |
|---|---|---|
| [0001](0001-plan-file-is-yaml-not-a-dsl.md) | The plan file is YAML, not a DSL | Accepted |
| [0002](0002-three-commands.md) | Three commands | Accepted |
| [0003](0003-receipts-on-an-orphan-git-branch.md) | Receipts live on an orphan git branch, behind a `ReceiptStore` interface | Accepted; amended by [0016](0016-one-receipts-ref-per-scope.md) |
| [0004](0004-apply-phases-inferred-from-output-availability.md) | Apply phases are inferred from output availability | Accepted |
| [0005](0005-receipts-are-a-ledger-with-write-ahead-intents.md) | Receipts are a ledger keyed by resource identity, with write-ahead intents | Accepted |
| [0006](0006-drift-kinds-and-refusing-changed-values.md) | Four kinds of drift, and apply refuses changed values | Accepted |
| [0007](0007-keep-true-for-adoption.md) | `{ keep: true }` for adopting existing values | Accepted |
| [0008](0008-scopes-succession-and-leases.md) | Scopes, pull request succession, and leases | Accepted |
| [0009](0009-single-point-redaction.md) | Single-point redaction | Accepted |
| [0010](0010-one-json-envelope-and-error-codes-table.md) | One JSON envelope and an `ERROR_CODES` table | Accepted |
| [0011](0011-testing-against-a-local-fake-cloud.md) | Testing against a local fake cloud with chaos, scenarios, journeys and property invariants | Accepted |
| [0012](0012-flat-plan-with-environment-filters.md) | One flat plan with per-line environment filters; production is never inferred | Accepted |
| [0013](0013-rollback-undoes-only-this-run.md) | Rollback undoes only what this run created | Accepted |
| [0014](0014-secrets-are-references.md) | Secrets are references, never values | Accepted |
| [0015](0015-adapters-describe-themselves.md) | Adapters and secret sources describe themselves | Accepted |
| [0016](0016-one-receipts-ref-per-scope.md) | One receipts branch per environment and scope | Accepted |
| [0017](0017-generic-http-adapter.md) | A generic, declarative `http` adapter | Proposed |
| [0018](0018-once-only-outputs.md) | Once-only outputs resolve to `{ keep: true }` after the run that revealed them, when fingerprints prove it | Proposed |
| [0019](0019-parent-object-locks.md) | Locks on shared parent objects | Accepted |
| [0020](0020-recipes.md) | Recipes: verified http specs as one-line building blocks | Proposed |
| [0021](0021-manual-steps.md) | Manual steps for state no API can manage | Proposed |

## Writing a new record

Write one when a change alters something a record describes, or makes a choice a future contributor would otherwise
have to rediscover: a new command, a change to the plan format or the receipt shape, a new invariant, a new
dependency between packages.

1. Copy the structure of an existing record: a numbered title, `Date`, `Status`, `Context`, `Decision`,
   `Consequences`.
2. Use the next free number: `NNNN-short-title.md`.
3. Status is `Proposed` in the pull request and `Accepted` when it merges. Records are not rewritten later; a
   decision that changes gets a new record, and the old one's status becomes `Superseded by NNNN` (or
   `Amended by NNNN` when the new record changes only part of it).
4. Add it to the table above.
