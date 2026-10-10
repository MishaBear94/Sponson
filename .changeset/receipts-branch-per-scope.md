---
"@sponson/core": minor
---

The `git-branch` receipt store now keeps each environment and scope on its own orphan branch, `sponson-receipts/<env>/<scope>`, instead of one shared `sponson/receipts` branch, so pull requests applying at the same time no longer race each other for one ref (and no longer run out of the store budget with `STORE_CONTENDED` under load). Migration is automatic: a scope without its own branch is read from `sponson/receipts`, its first write moves it to its own branch, and `sponson/receipts` is never written again; delete it once every scope has run. Workflow or branch-protection filters that named `sponson/receipts` should use `sponson-receipts/**`. **Breaking** (library only): `GitBranchStoreOptions.branch` is replaced by `refPrefix` and `legacyBranch`.
