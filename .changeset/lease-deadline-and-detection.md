---
"@sponson/core": minor
"sponson": minor
"@sponson/adapters": minor
"@sponson/sim": minor
---

Context detection (`detectCtx`, GitHub Actions and local git/`gh`) moved from `@sponson/core` to `sponson` behind a `CtxSource` seam (breaking for direct users of `@sponson/core`). A lease holder whose renewals stall now stops itself before its lease could be taken over. `ReceiptStore.close()` lets long-running hosts release temporary git clones. Adapters gain `adopt()`; the plan format has a JSON Schema. Adapters declare `about` (credential and base-URL variables) and secret sources declare `form`/`resolvedBy`, read by the generated docs (ADR 0015). Secret-source errors no longer repeat the reference, and a missing CLI is reported as such. `aws-sm://` resolves secrets from AWS Secrets Manager. `pnpm sim` prints a paste-ready environment block.
