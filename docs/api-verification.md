# API verification against published specifications

Sponson's adapters (`packages/adapters/src/`) and the fake cloud (`packages/sim/src/routes/`) were written
without real provider accounts. This page records what was checked, without an account, against each provider's
published API specification: every HTTP call an adapter makes, and every numbered assumption at the top of a sim
routes file. What a specification cannot settle still needs a live run of `pnpm test:live`
(`scenarios/contract.test.ts`).

Legend: ✅ matches the spec · ⚠️ differed from the spec (fixed in adapter and sim unless noted) · ❓ the spec is
silent; needs a live account.

## Sources

All fetched on 2026-10-10 (LaunchDarkly, PlanetScale, Supabase: 2026-10-11) and treated as data; none is vendored into the repository.

| Provider | Source | Version |
|---|---|---|
| Vercel | OpenAPI document, https://openapi.vercel.sh/ | as served on that date |
| Neon | OpenAPI document, https://neon.tech/api_spec/release/v2.json | `v2` |
| Clerk | Backend API OpenAPI, https://github.com/clerk/openapi-specs `bapi/2026-05-12.yml` (commit `3b078e5`); the `/redirect_urls` section is identical in `bapi/2021-02-05.yml` | `2026-05-12` |
| Clerk | Official SDK sources, for the list envelope the spec does not describe: RedirectUrlApi.ts (backend package) in clerk/javascript, redirecturl/client.go in clerk/clerk-sdk-go (v2) | `main` / `v2` on that date |
| LaunchDarkly | REST API reference: overview (authentication, errors, rate limits, semantic patch) https://launchdarkly.com/docs/api, "Get feature flag" https://launchdarkly.com/docs/api/feature-flags/get-feature-flag, "Update feature flag" https://launchdarkly.com/docs/api/feature-flags/patch-feature-flag | as served on that date (API `v2`) |
| PlanetScale | OpenAPI document, https://planetscale.com/docs/openapi.yaml (fetched 2026-10-11); service tokens, https://planetscale.com/docs/api/reference/service-tokens; CLI references https://planetscale.com/docs/cli/service-tokens.md, https://planetscale.com/docs/cli/branch.md, https://planetscale.com/docs/cli/password.md; Node.js connection string, https://planetscale.com/docs/vitess/tutorials/connect-nodejs-app | `v1` |
| Supabase | Management API OpenAPI document, https://api.supabase.com/api/v1-json (rendered at https://supabase.com/docs/reference/api/introduction) | `1.0.0` as served on that date |
| Supabase | Docs pages, for what the spec does not say: Auth's `URI_ALLOW_LIST` format (https://github.com/supabase/auth, README "General Config"), the direct connection string (https://supabase.com/docs/guides/database/connecting-to-postgres), the project API URL (https://supabase.com/docs/guides/api), Branching (https://supabase.com/docs/guides/deployment/branching), redirect URL wildcards (https://supabase.com/docs/guides/auth/redirect-urls) | as served on that date |

Vercel, Neon and Clerk use bearer authentication (`securitySchemes`), which is what the shared HTTP client sends
by default: ✅. LaunchDarkly takes the access token as the whole `Authorization` value, without `Bearer`; the adapter
sends it that way (`authHeader: "header:authorization"`): ✅. PlanetScale service tokens are not bearer tokens
either; see below. Supabase's Management API uses bearer tokens: ✅.

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

## PlanetScale

Paths are relative to `https://api.planetscale.com/v1` (the spec's `servers`) and, below the first row, to
`/organizations/{organization}/databases/{database}`.

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| every request | `Authorization: <PLANETSCALE_SERVICE_TOKEN_ID>:<PLANETSCALE_SERVICE_TOKEN>` | ✅ | Service tokens page; the spec's `securitySchemes` lists only OAuth. Variable names as in the CLI docs. Accesses needed: `create_branch`, `read_branch`, `delete_branch`, `connect_branch`, `delete_branch_password` (each endpoint's "Service Token Accesses"). |
| `GET /branches` (`list_branches`) | `page` from `next_page`; reads `data[].id`, `name`, `parent_branch`, `production`, `ready` | ✅ | Default `per_page` 25. Used by `listScope` only. |
| `GET /branches/{branch}` (`get_branch`) | by **name**; `404` → absent; reads `id`, `name`, `parent_branch`, `production`, `ready` | ✅ | `state` (`pending` … `ready`) is also returned; the adapter relies on the boolean `ready`. |
| `POST /branches` (`create_branch`) | `{ name, parent_branch }`; `201` | ✅ | `parent_branch` is optional in the spec (defaults to the database's default branch); the adapter always sends it, after checking it exists with `get_branch`. |
| same, duplicate name | any `409` or `422` → `get_branch` by name, claim it if found | ❓ | The spec lists `422` and no `409`; the wording is undocumented (PS5). |
| `DELETE /branches/{branch}` (`delete_branch`) | by name, after `get_branch` confirmed the id the ledger recorded; `404` is success | ✅ path and `204`; ❓ timing | Whether deletion is synchronous needs a live run (PS7). |
| `GET /branches/{branch}/passwords` (`list_passwords`) | `page` from `next_page`; reads `data[].id`, `name`, `role`, `username`, `access_host_url` | ✅ | `plain_text` is "Null except in the response from the create endpoint". The `q` search is not used (its matching rules are undocumented); the adapter filters names itself. |
| `POST /branches/{branch}/passwords` (`create_password`) | `{ name, role }`; reads `id`, `role`, `username`, `access_host_url`, `plain_text` | ✅ | Roles `reader`, `writer`, `admin`, `readwriter`. `name` is "optional"; uniqueness is not documented (PS9). |
| `DELETE /branches/{branch}/passwords/{id}` (`delete_password`) | `404` is success | ✅ | `204`. |
| connection string | `mysql://<username>:<plain_text>@<access_host_url>/<database>?ssl={"rejectUnauthorized":true}` | ✅ | The Node.js tutorial's form; Prisma's `sslaccept=strict` via `connection_params`. |

Not used: `PATCH …/passwords/{id}` takes only `name` and `cidrs` (✅), so a role cannot change in place (PS10), and
the adapter never calls `…/passwords/{id}/renew`, which would rotate the plaintext.

### Sim assumptions (`packages/sim/src/routes/planetscale.ts`)

| Id | Assumption | Status |
|---|---|---|
| PS1 | `Authorization: <id>:<token>`; the sim refuses `Bearer` | verified (pinned by the contract suite) |
| PS2 | paths under organization and database; branches addressed by name | verified |
| PS3 | `{ data, next_page }`, `?page=`, 25 per page | verified |
| PS4 | a created branch is `ready: false` at first and becomes ready later | fields verified; initial state through the CLI's `--wait` only; duration ❓ (pinned) |
| PS5 | a duplicate branch name answers `422` | ❓ (the adapter accepts `409` or `422`) |
| PS6 | an unknown parent answers `404` | ❓ (the adapter checks the parent first) |
| PS7 | branch deletion is synchronous and takes the passwords with it | `204` verified; timing ❓ |
| PS8 | `plain_text` only in the create answer | verified (pinned) |
| PS9 | password names are not unique | ❓ (the adapter refuses two of one name) |
| PS10 | a password's role cannot change in place | verified |
| PS11 | password delete `204`; `404` when gone | `204` verified; `404` ❓ |
| PS12 | a password on a branch that is not ready is refused | ❓ (the adapter waits for `ready` first, so either answer is fine) |
| PS13 | error bodies are `{ code, message }` | ❓ (never read by the adapter) |
| PS14 | branch name characters | ❓ (the default name uses only `a-z`, `0-9`, `-`) |

## The generic `http` adapter

The `http` adapter makes the calls a plan line declares, so there is no provider to verify it against: a line is
checked by running `sponson plan` (it only reads) against the real API before the first `apply`. The plans in
[examples/](../examples/README.md) that use it are illustrative and say so.

### Sim assumptions (`packages/sim/src/routes/rest.ts`)

They describe a conventional JSON REST API, not one provider; the adapter's tests and scenarios run against them.

| Id | Assumption | Status |
|---|---|---|
| R1 | credentials as `Authorization: Bearer`, `Authorization: Basic` or a `*-Api-Key` header | convention |
| R2 | `{ data }` envelopes for collection objects and lists, cursor in `next_cursor`; other objects bare | convention (the plan line names its own envelope with `item_path`, `list_path`, `find.next`) |
| R3 | unknown paths are 404 until seeded or created; client-chosen ids; duplicate `name` → 409 | convention (`exists_status` covers providers that answer otherwise) |
| R4 | PATCH is a JSON merge patch (RFC 7396); PUT replaces; JSON or form bodies; no preconditions | RFC 7396 for PATCH; the rest convention |
| R5 | DELETE answers `{ id, deleted }`; unknown is 404 | convention (`gone_status` covers providers that answer otherwise) |

## Supabase

Written against the spec from the start (the adapter is newer than this page), so there is no ⚠️ column history: every
call below was checked before the first commit. Base URL `https://api.supabase.com/v1`; the spec's paths carry the
`/v1` prefix.

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| `GET /v1/projects/{ref}/branches` | reads `[].name`, `project_ref`, `is_default` | ✅ | `v1-list-all-branches`: a bare array of `BranchResponse`, no page parameters. The default branch is skipped and never managed. |
| `POST /v1/projects/{ref}/branches` | `{ branch_name }`; reads `name`, `project_ref` from the `201` | ✅ | `CreateBranchBody` requires only `branch_name`; `git_branch`, `persistent`, `with_data`, `region` and the rest are optional and not sent. |
| same, refusals | a duplicate name → re-read and claim; any other refusal reported | ❓ | Only `201`, `401`, `403`, `429` and `500` are documented. The adapter checks the list after a `409`, `400` or `422` before reporting (S5). A `500` ("Failed to create database branch") is not retried: the create may have happened, and the intent plus find-by-name recovers it on the next run. |
| `GET /v1/branches/{branch_id_or_ref}` | the branch's ref; reads `status`, `db_host`, `db_port`, `db_user`, `db_pass` | ✅ fields; ❓ readiness | `BranchDetailResponse`. `status` is the project status enum; `ACTIVE_HEALTHY` is taken as ready and `INIT_FAILED`, `REMOVED`, `GOING_DOWN`, `INACTIVE`, `PAUSING`, `PAUSE_FAILED`, `RESTORE_FAILED` as never-ready. `db_user` and `db_pass` are optional in the spec; without them the line fails with `PROVIDER_RESPONSE` rather than outputting a broken URI. A `404` while the branch comes up is treated as "not yet". The ref form of the path parameter is used: the uuid form is marked deprecated. |
| `DELETE /v1/branches/{branch_id_or_ref}` | the branch's ref; `404` is success | ✅ path, `200`; ❓ `404` | "By default, deletes immediately" (`force=false` would schedule it). No `404` is documented; an unknown ref's status needs a live run. The parent project's own ref is never sent. |
| `GET /v1/projects/{ref}/config/auth` | reads `uri_allow_list` (nullable string) | ✅ | `AuthConfigResponse`; `uri_allow_list` is required and nullable. |
| `PATCH /v1/projects/{ref}/config/auth` | `{ uri_allow_list }` alone; retried as idempotent | ✅ | `UpdateAuthConfigBody` has no required field, so a body with one field touches one field. Sending only that field also avoids the reported failure when re-sending a whole config with auth hooks enabled (supabase/supabase#36861). No ETag or version: the write is unconditional, so the adapter re-reads and repeats (three rounds) when a concurrent writer overwrote it. |

Derived outputs: `api_url` is `https://<ref>.supabase.co` (the project URL format in the API docs) and
`connection_string` is `postgresql://<db_user>:<db_pass>@<db_host>:<db_port>/postgres`, matching the documented
direct connection string (`postgres` database; the password percent-encoded). The direct host resolves over IPv6
unless the project has the IPv4 add-on.

### Sim assumptions (`packages/sim/src/routes/supabase.ts`)

| Id | Assumption | Status |
|---|---|---|
| S1 | create takes `{ branch_name }` and answers `201` `BranchResponse` with the branch's own `project_ref` | verified (schema); that `project_ref` is usable before provisioning finishes ❓ (pinned) |
| S2 | the list is a bare unpaged array, and includes the project's own default branch | array verified; the default branch's presence ❓ (pinned; the adapter skips it either way) |
| S3 | the detail answers `200` with `COMING_UP` until ready, then `ACTIVE_HEALTHY` | fields and enum verified; the progression and the `200` while coming up ❓ (pinned) |
| S4 | detail carries `db_user`/`db_pass`; database `postgres`; API URL `https://<ref>.supabase.co` | optional fields verified; that a personal access token gets `db_pass` ❓ (pinned); database name and URL verified in the docs |
| S5 | a duplicate branch name answers `409` | ❓ (pinned; the adapter accepts `400`/`409`/`422`) |
| S6 | delete answers `200 { message: "ok" }`, gone from the list at once; unknown ref `404` | `200` and immediacy of the default verified; list visibility and `404` ❓ (pinned) |
| S7 | `uri_allow_list` nullable string; a one-field PATCH changes one field; no precondition | verified |
| S8 | the allow-list is comma-separated; stored verbatim | format verified (Auth's `URI_ALLOW_LIST`); verbatim storage ❓ (pinned) |
| S9 | a branch has its own Auth config at `/v1/projects/{branch ref}/config/auth` | ❓ |

## What still needs a live account

- Vercel: V1 (propagation of env writes), the deployment list's order, whether `decrypt=true` still decrypts,
  what `created` contains for updated entries and how overlapping target sets are refused, whether the env list
  pages with `until`, branch auto-cancel, and that a `gitSource` deployment from the project's `link` builds.
- Neon: N1 (list visibility during an asynchronous delete), N2 (which requests answer `423`, endpoint readiness),
  N5 (status of a duplicate branch name).
- Clerk: C1 (status and wording of a duplicate), C2 (the envelope, confirmed only through the SDKs).
- LaunchDarkly: LD5 (re-adding a target the variation already serves; the status of a two-variation refusal), LD7
  (read-after-write), LD2 (an unknown environment), LD3 (the `user` placeholders in `contextTargets`).
- PlanetScale: PS4 (a new branch is not ready at first; how long provisioning takes), PS5 (status of a duplicate
  branch name), PS7 (deletion timing), PS9 (duplicate password names), PS12 (a password on a branch still
  provisioning), and PS1 and PS8 end to end.
- Supabase: S1 and S3 (a branch's ref is usable at once; the detail's status while it comes up), S4 (`db_pass` for a
  personal access token), S5 (status of a duplicate name), S6 (`404` for an unknown ref, list visibility after
  delete), S8 (verbatim storage of the list), S9 (a branch's own Auth config through the same endpoint). The
  Supabase block of the contract suite is optional in a live run (branching needs a paid plan).

Run them with `pnpm test:live`; see the header of `scenarios/contract.test.ts`.
