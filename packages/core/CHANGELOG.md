# @sponson/core

## 0.3.0

### Minor Changes

- 0434a9e: Context detection (`detectCtx`, GitHub Actions and local git/`gh`) moved from `@sponson/core` to `sponson` behind a `CtxSource` seam (breaking for direct users of `@sponson/core`). A lease holder whose renewals stall now stops itself before its lease could be taken over. `ReceiptStore.close()` lets long-running hosts release temporary git clones. Adapters gain `adopt()`; the plan format has a JSON Schema. Adapters declare `about` (credential and base-URL variables) and secret sources declare `form`/`resolvedBy`, read by the generated docs (ADR 0015). Secret-source errors no longer repeat the reference, and a missing CLI is reported as such. `aws-sm://` resolves secrets from AWS Secrets Manager. `pnpm sim` prints a paste-ready environment block.
- 7fc20cf: The `git-branch` receipt store now keeps each environment and scope on its own orphan branch, `sponson-receipts/<env>/<scope>`, instead of one shared `sponson/receipts` branch, so pull requests applying at the same time no longer race each other for one ref (and no longer run out of the store budget with `STORE_CONTENDED` under load). Migration is automatic: a scope without its own branch is read from `sponson/receipts`, its first write moves it to its own branch, and `sponson/receipts` is never written again; delete it once every scope has run. Workflow or branch-protection filters that named `sponson/receipts` should use `sponson-receipts/**`. **Breaking** (library only): `GitBranchStoreOptions.branch` is replaced by `refPrefix` and `legacyBranch`.

### Patch Changes

- 1533787: Fixes from an independent review: a live lock an older Sponson holds on the legacy receipts branch is respected during migration (no concurrent apply, no lost receipt); the final receipt is written whenever the store's fencing allows it, even if lease renewals lagged; `list()` no longer drops scopes whose names differ only by case on macOS/Windows; Vercel `target: development` variables never trigger or wait on a deployment. The git store's own working clone is created with `mkdtemp` (owner-only, unpredictable name). A lock that cannot be released is retried and then reported in the run's warnings instead of being left behind silently.
