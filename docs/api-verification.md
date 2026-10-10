# API verification against published specifications

Sponson's adapters (`packages/adapters/src/`) and the fake cloud (`packages/sim/src/routes/`) were written
without real provider accounts. This page records what was checked, without an account, against each provider's
published API specification: every HTTP call an adapter makes, and every numbered assumption at the top of a sim
routes file. What a specification cannot settle still needs a live run of `pnpm test:live`
(`scenarios/contract.test.ts`).

Legend: ✅ matches the spec · ⚠️ differed from the spec (fixed in adapter and sim unless noted) · ❓ the spec is
silent; needs a live account.

## Sources

All fetched on 2026-10-10 (LaunchDarkly: 2026-10-11) and treated as data; none is vendored into the repository.

| Provider | Source | Version |
|---|---|---|
| Vercel | OpenAPI document, https://openapi.vercel.sh/ | as served on that date |
| Neon | OpenAPI document, https://neon.tech/api_spec/release/v2.json | `v2` |
| Clerk | Backend API OpenAPI, https://github.com/clerk/openapi-specs `bapi/2026-05-12.yml` (commit `3b078e5`); the `/redirect_urls` section is identical in `bapi/2021-02-05.yml` | `2026-05-12` |
| Clerk | Official SDK sources, for the list envelope the spec does not describe: RedirectUrlApi.ts (backend package) in clerk/javascript, redirecturl/client.go in clerk/clerk-sdk-go (v2) | `main` / `v2` on that date |
| LaunchDarkly | REST API reference: overview (authentication, errors, rate limits, semantic patch) https://launchdarkly.com/docs/api, "Get feature flag" https://launchdarkly.com/docs/api/feature-flags/get-feature-flag, "Update feature flag" https://launchdarkly.com/docs/api/feature-flags/patch-feature-flag | as served on that date (API `v2`) |

Vercel, Neon and Clerk use bearer authentication (`securitySchemes`), which is what the shared HTTP client sends
by default: ✅. LaunchDarkly takes the access token as the whole `Authorization` value, without `Bearer`; the adapter
sends it that way (`authHeader: "header:authorization"`): ✅.

## Vercel

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| `GET /v10/projects/{idOrName}/env` | `decrypt=true`, `teamId`; reads `envs[].id`, `key`, `value`, `target` (string or list), `gitBranch`, `type`, `decrypted` | ⚠️ → ✅ | Was `/v9/…`, which the spec no longer lists. `decrypt` is listed but deprecated, so a value with `decrypted` not `true` is fetched from the call below instead of being hashed as ciphertext. |
| same, pagination | follows `pagination.next` as `?until=` | ❓ | The response has the spec's `Pagination` object (`count`, `next`, `prev`), but this endpoint documents no page parameter. The adapter drops repeated records, so an API that ignores `until` costs one request, not duplicates. |
| `GET /v1/projects/{idOrName}/env/{id}` | `teamId`; reads `value`, `decrypted`, `type` | ✅ | New. "Retrieve the decrypted value of an environment variable". A `sensitive` value is never returned (the response variant without `value`). |
| `POST /v10/projects/{idOrName}/env` | `upsert=true`, `teamId`; body: list of `{ key, value, type: "encrypted", target: [t], gitBranch? }` | ✅ | Body matches the array form of the request schema. |
| same, answer | `201 { created, failed }`; `created` one object or a list; `failed[].error` | ⚠️ → ✅ | The failure names the variable as `key` or `envVarKey`; the adapter read only `key`. The sim answered `200`; the spec says `201`. |
| same, conflicts | an overlapping target set refused with `400 ENV_CONFLICT` | ❓ | Not described. Without `upsert`, a duplicate is documented as `403` ("cannot be created because it already exists"); the sim now answers that. A `400` for "an ongoing env update is already happening" is documented; it is reported as `PROVIDER_INVALID`, not retried. |
| `DELETE /v9/projects/{idOrName}/env/{id}` | `teamId`; `404` is success | ✅ | `409` (project being transferred) surfaces as `PROVIDER_CONFLICT`. |
| `GET /v7/deployments` | `projectId`, `sha`, `target`, `limit=20`, `teamId`; reads `uid`, `url`, `readyState`, `createdAt`, `target` | ⚠️ → ✅ | Was `/v6/deployments?sha=`: `sha` is a documented filter of `/v7` only, and v6 is not in the spec. The adapter required `state`, which is optional; `readyState` is the required field. `url` is null until an upload completes, which made the whole list a shape error. Lookups were also by commit only, so a production line could take the commit's preview build; they now pass the documented `target` filter and re-check each item's `target` (null = preview), see V8. |
| deployment states | `READY` done; `ERROR`, `CANCELED` failed; others in progress | ⚠️ → ✅ | The spec's states add `INITIALIZING` (in progress), `BLOCKED` and `DELETED`; the last two never become ready by themselves and now fail the waiting lines. |
| `GET /v9/projects/{idOrName}` | `teamId`; reads `link.type`, `link.repoId` / `projectId` / `uuid`, `workspaceUuid` | ✅ | New, to build `gitSource` (next row). |
| `POST /v13/deployments` | `forceNew=1`, `teamId`; body `{ name, project, gitSource, target? }` | ⚠️ → ✅ | `gitSource` was `{ type: "github", ref, sha }`; every GitHub variant of the schema also requires `repoId` (or `org` and `repo`), so the call would have been refused. It now carries the connected repository from the project's `link` (GitHub, GitLab, Bitbucket); a project with no Git connection is `PROVIDER_INVALID`. `project` overriding `name` matches the spec. `forceNew=1` because Vercel may otherwise answer with an earlier deployment of the same commit, which defeats a redeploy. |
| same, answer | reads `id`, `readyState`, `url`, `createdAt` | ⚠️ → ✅ | One documented answer variant has no `url`; the adapter now polls until `url` is set. |
| `GET /v13/deployments/{idOrUrl}` | `teamId`; reads `id`, `url`, `readyState` | ✅ | |

### Sim assumptions (`packages/sim/src/routes/vercel.ts`)

| Id | Assumption | Status |
|---|---|---|
| V1 | env writes visible to the next deployment and list at once | ❓ needs a live account (pinned by the contract suite) |
| V2 | `GET /v7/deployments?sha=` filters by commit, newest first | `sha` filter verified; order ❓ (the adapter sorts anyway) |
| V8 | `GET /v7/deployments?target=` filters by environment; items carry `target` (`production`, a custom environment, or null for previews) | ✅ verified (parameter and item schema) |
| V3 | list decrypts with `decrypt=true`; `sensitive` values never returned | parameters and per-variable GET verified; whether the deprecated parameter still decrypts ❓ (handled either way) |
| V4 | upsert answer `{ created, failed }`; `ENV_CONFLICT` on overlapping targets | answer shape and status verified; `created` listing updates, and `ENV_CONFLICT` ❓ |
| V5 | `project` overrides `name`; `gitSource` identity; states; one URL per deployment | verified, except auto-cancel of a branch's older builds ❓ |
| V6 | `{ envs, pagination: { count, next, prev } }`, `?until=` | envelope verified; the page parameter ❓ |
| V7 | `GET /v9/projects/{id}` carries `link` | verified |

## Neon

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| `GET /projects/{project_id}/branches` | `cursor` from `pagination.next`; reads `branches[].id`, `name`, `parent_id`, `default` (and the deprecated `primary`) | ✅ | `CursorParam`, `CursorPagination`. A paged read starts with `limit`; the adapter sends none and follows `next` if present. |
| `POST /projects/{project_id}/branches` | `{ branch: { name, parent_id }, endpoints: [{ type: "read_write" }] }` | ✅ | Matches the spec's own `branch_with_endpoint` example. |
| same, answer | `201`; reads `branch`, `endpoints[].host`, `connection_uris[].connection_uri` | ✅ | `connection_uris` is absent when the parent has several databases or roles; the adapter then reads them with the calls below. |
| same, refusals | `409` duplicate name → re-read and claim; `423` retried | `423` ✅, `409` ❓ | The generic error says `423 Locked` is always safe to retry. Which status a duplicate name gets is not documented. |
| `GET /projects/{project_id}/branches/{branch_id}/endpoints` | reads `endpoints[].host`, preferring `type: read_write` | ✅ | |
| `GET /projects/{project_id}/branches/{branch_id}/databases` | reads `databases[].name`, `owner_name` | ✅ | New (next row). |
| `GET /projects/{project_id}/connection_uri` | `branch_id`, `database_name`, `role_name`; reads `uri` | ⚠️ → ✅ | Both names are required parameters. They were hard-coded to `neondb` / `neondb_owner`, a new project's defaults, so any other project failed to read. They now come from the branch's database list (`neondb` if present, else the first; its owner is the role). |
| `DELETE /projects/{project_id}/branches/{branch_id}` | `404` is success | ✅ path and status; ⚠️ timing | "The deletion completes after all operations finish": not synchronous (N1). Not changed: whether a branch being deleted still lists needs a live run. |

The spec also says a `503` is always safe to retry; the shared HTTP client retries `5xx` only for idempotent
methods, which is more cautious than needed but not wrong.

### Sim assumptions (`packages/sim/src/routes/neon.ts`)

| Id | Assumption | Status |
|---|---|---|
| N1 | branch deletion is synchronous | contradicted in part (the spec describes asynchronous completion); list visibility meanwhile ❓ (pinned by the contract suite) |
| N2 | a create runs operations; `423` while they run; endpoint usable at once | operations and `423` retry-safety verified; which requests lock, and endpoint readiness ❓ (pinned) |
| N3 | `neondb` / `neondb_owner`; `default: true` on the root branch | the adapter no longer depends on the names (verified calls above); `default` verified |
| N4 | `{ branches, pagination: { next } }`, `?cursor=` | verified |
| N5 | a duplicate branch name answers `409` | ❓ |

## Clerk

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| `GET /redirect_urls` | `paginated=true`, `limit=100`, `offset`; reads `data[].id`, `url`, `total_count` (a bare array also accepted) | ⚠️ → ✅ | The adapter sent no parameters. `limit` defaults to 10 (maximum 500), and the documented answer is a bare array with no way to tell it was cut short. The adapter now asks for pages the way Clerk's own SDKs do; the `{ data, total_count }` envelope is not in the spec but is what both SDKs decode. |
| `POST /redirect_urls` | `{ url }`; reads `id`, `url` | ✅ | Answer is the spec's `RedirectURL` (`object`, `id`, `url`, `created_at`, `updated_at`). |
| same, refusals | duplicate → re-read and claim | ❓ → hardened | The spec documents `400` and `422` (`ClerkErrors`) without saying which a duplicate gets or how it is worded. The adapter now checks the list after any `400`/`422`, not only one whose body says "exists". |
| `DELETE /redirect_urls/{id}` | `404` is success | ✅ | `200` answers a `DeletedObject`; `404` is documented. |

### Sim assumptions (`packages/sim/src/routes/clerk.ts`)

| Id | Assumption | Status |
|---|---|---|
| C1 | a duplicate answers `422` | ❓ (the adapter no longer depends on it) |
| C2 | bare array; with `paginated=true`, `{ data, total_count }` by `offset`/`limit` | array and parameters verified; envelope from the SDK sources (pinned by the contract suite) |
| C3 | `RedirectURL` and `DeletedObject` shapes | verified |

## LaunchDarkly

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| `GET /api/v2/flags/{projectKey}/{featureFlagKey}` | `env=<environment key>`; reads `variations[]._id`, `value`, `name`, and `environments.<key>.targets[]` / `contextTargets[]` (`contextKind`, `values`, `variation` index) | ✅ | `env` restricts the answer to one environment, as the reference recommends. `targets` holds kind `user`, `contextTargets` the other kinds; the adapter reads both and defaults a missing `contextKind` to `user`. `404` (unknown project or flag) fails the line; destroy treats it as already gone. |
| same, unknown environment | an environment the answer lacks is `PROVIDER_NOT_FOUND` naming it | ❓ | Whether LaunchDarkly answers `404` or omits the environment is not stated; the adapter reports either as not found. |
| `PATCH /api/v2/flags/{projectKey}/{featureFlagKey}` | `Content-Type: application/json; domain-model=launchdarkly.semanticpatch`; body `{ environmentKey, comment, instructions }` with `addTargets` and/or `removeTargets` `{ contextKind, values: [key], variationId }` | ✅ | Without the `domain-model` parameter the body is read as a JSON patch and refused with `400`. Moving a target sends `removeTargets` (old variation) and `addTargets` (new) in one patch: instructions are all or nothing, and `addTargets` is an error when the key would be targeted by two variations. The shared client gained `WriteOptions.contentType` for this. |
| same, answer | `200` with the whole flag; the adapter re-reads the target from it | ✅ | A target not served the wanted variation afterwards is `PROVIDER_RESPONSE`. |
| same, refusals | `405` (environment requires approvals) → `PROVIDER_INVALID` saying so; `409` (concurrent change) → re-read and retry, up to 3 times; `429` retried by the client | ✅ | Sponson does not open approval requests; use a preview or test environment without required approvals. `400` for a conflict with a pending scheduled change or approval is reported, not bypassed with `ignoreConflicts`. |

The PATCH is sent as idempotent (a 502/503/504 or dropped connection is retried): adding and removing an individual
target are set operations, so repeating one changes nothing more.

### Sim assumptions (`packages/sim/src/routes/launchdarkly.ts`)

| Id | Assumption | Status |
|---|---|---|
| LD1 | the access token is the whole `Authorization` value; base URL `https://app.launchdarkly.com/api/v2` | verified (the base URL from the OpenAPI document's location) |
| LD2 | `GET /flags/{p}/{f}?env=` answers `variations` and `environments` restricted to that environment; unknown project or flag `404` | verified, except how an unknown environment is answered ❓ |
| LD3 | `targets` (kind `user`) and `contextTargets` (other kinds), items `{ contextKind, values, variation }`; `contextTargets` also carries empty `user` placeholders | lists and items verified; the placeholders ❓ (the adapter ignores empty entries either way) |
| LD4 | semantic patch media type; `{ environmentKey, instructions, comment }`; `200` with the flag; all or nothing | verified |
| LD5 | `addTargets` refused when the key would be in two variations; re-adding a key to the variation that already serves it succeeds and changes nothing; `removeTargets` of an absent key does nothing | refusal verified (its status ❓); re-adding ❓ (pinned by the contract suite); removal verified |
| LD6 | `405` when approvals are required; `409` for a concurrent change; error body `{ code, message }` | verified |
| LD7 | a patch is visible to the next GET | ❓ (pinned by the contract suite) |

## What still needs a live account

- Vercel: V1 (propagation of env writes), the deployment list's order, whether `decrypt=true` still decrypts,
  what `created` contains for updated entries and how overlapping target sets are refused, whether the env list
  pages with `until`, branch auto-cancel, and that a `gitSource` deployment from the project's `link` builds.
- Neon: N1 (list visibility during an asynchronous delete), N2 (which requests answer `423`, endpoint readiness),
  N5 (status of a duplicate branch name).
- Clerk: C1 (status and wording of a duplicate), C2 (the envelope, confirmed only through the SDKs).
- LaunchDarkly: LD5 (re-adding a target the variation already serves; the status of a two-variation refusal), LD7
  (read-after-write), LD2 (an unknown environment), LD3 (the `user` placeholders in `contextTargets`).

Run them with `pnpm test:live`; see the header of `scenarios/contract.test.ts`.
