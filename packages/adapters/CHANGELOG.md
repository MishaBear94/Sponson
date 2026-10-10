# @sponson/adapters

## 0.3.0

### Minor Changes

- 8987603: Added the `aws-sm://` secret source: `{ secret: "aws-sm://<secret-id>" }` reads an AWS Secrets Manager secret through the `aws` CLI (name or ARN; region and credentials from the CLI's usual environment), and `aws-sm://<secret-id>#KEY` picks one key of a JSON key/value secret.
- e009218: Added the `gcp-sm://` secret source: `{ secret: "gcp-sm://<project>/<secret>" }` reads the latest version of a Google Secret Manager secret through the `gcloud` CLI (credentials from `gcloud auth` and the CLI's usual environment); `gcp-sm://<project>/<secret>/<version>` pins a version.
- 0434a9e: Context detection (`detectCtx`, GitHub Actions and local git/`gh`) moved from `@sponson/core` to `sponson` behind a `CtxSource` seam (breaking for direct users of `@sponson/core`). A lease holder whose renewals stall now stops itself before its lease could be taken over. `ReceiptStore.close()` lets long-running hosts release temporary git clones. Adapters gain `adopt()`; the plan format has a JSON Schema. Adapters declare `about` (credential and base-URL variables) and secret sources declare `form`/`resolvedBy`, read by the generated docs (ADR 0015). Secret-source errors no longer repeat the reference, and a missing CLI is reported as such. `aws-sm://` resolves secrets from AWS Secrets Manager. `pnpm sim` prints a paste-ready environment block.

### Patch Changes

- 3f2c6e0: Adapters checked against the providers' published API specifications (see `docs/api-verification.md`), with the mismatches fixed in the adapters and the sim alike:
  
  - `vercel.deploy` and the redeploy after an env write now send a `gitSource` that names the project's connected repository (`repoId`, GitLab `projectId` or Bitbucket `repoUuid`, read from the project's `link`), which `POST /v13/deployments` requires, and pass `forceNew=1` so Vercel builds again instead of answering with an earlier deployment of the commit. A project with no Git connection fails with `PROVIDER_INVALID`.
  - Deployments are looked up with `GET /v7/deployments?sha=` (the version that documents the `sha` filter), read by `readyState`, and tolerated without a `url` while uploading; `BLOCKED` and `DELETED` deployments fail the lines waiting on them like `ERROR` and `CANCELED`.
  - `vercel.env` lists variables with `GET /v10/projects/:id/env`, fetches a value the list does not return decrypted from `GET /v1/projects/:id/env/:id` (so it no longer diffs as changed on every run), ignores repeated records, and names a rejected upsert entry reported as `envVarKey`.
  - `neon.branch` builds the connection string for the branch's own database and its owner role, read from the branch's database list, instead of assuming `neondb` / `neondb_owner`.
  - `clerk.redirect_allow` reads the allow-list with `paginated=true` and explicit `limit`/`offset` (the spec's default page is 10) and, when a create is refused with 400 or 422, checks whether the URL is already listed before failing.
- 4f01efe: Vercel deployments are matched by environment as well as commit: a production line no longer takes the commit's preview build (or the reverse), using the documented `target` filter of `GET /v7/deployments` plus a check of each item's `target`. The `vercel.deploy` resource key is now `deployment:<production|preview>:<sha>`; an existing ledger entry under the old key is reported as an orphan once and is harmless (destroying a deployment is a no-op).
- 1533787: Fixes from an independent review: a live lock an older Sponson holds on the legacy receipts branch is respected during migration (no concurrent apply, no lost receipt); the final receipt is written whenever the store's fencing allows it, even if lease renewals lagged; `list()` no longer drops scopes whose names differ only by case on macOS/Windows; Vercel `target: development` variables never trigger or wait on a deployment. The git store's own working clone is created with `mkdtemp` (owner-only, unpredictable name). A lock that cannot be released is retried and then reported in the run's warnings instead of being left behind silently.
- Updated dependencies [0434a9e]
- Updated dependencies [7fc20cf]
- Updated dependencies [1533787]
  - @sponson/core@0.3.0
