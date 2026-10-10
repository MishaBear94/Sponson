---
"@sponson/adapters": patch
"@sponson/sim": patch
---

Adapters checked against the providers' published API specifications (see `docs/api-verification.md`), with the mismatches fixed in the adapters and the sim alike:

- `vercel.deploy` and the redeploy after an env write now send a `gitSource` that names the project's connected repository (`repoId`, GitLab `projectId` or Bitbucket `repoUuid`, read from the project's `link`), which `POST /v13/deployments` requires, and pass `forceNew=1` so Vercel builds again instead of answering with an earlier deployment of the commit. A project with no Git connection fails with `PROVIDER_INVALID`.
- Deployments are looked up with `GET /v7/deployments?sha=` (the version that documents the `sha` filter), read by `readyState`, and tolerated without a `url` while uploading; `BLOCKED` and `DELETED` deployments fail the lines waiting on them like `ERROR` and `CANCELED`.
- `vercel.env` lists variables with `GET /v10/projects/:id/env`, fetches a value the list does not return decrypted from `GET /v1/projects/:id/env/:id` (so it no longer diffs as changed on every run), ignores repeated records, and names a rejected upsert entry reported as `envVarKey`.
- `neon.branch` builds the connection string for the branch's own database and its owner role, read from the branch's database list, instead of assuming `neondb` / `neondb_owner`.
- `clerk.redirect_allow` reads the allow-list with `paginated=true` and explicit `limit`/`offset` (the spec's default page is 10) and, when a create is refused with 400 or 422, checks whether the URL is already listed before failing.
