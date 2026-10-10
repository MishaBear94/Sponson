# API verification against published specifications

Sponson's adapters (`packages/adapters/src/`) and the fake cloud (`packages/sim/src/routes/`) were written
without real provider accounts. This page records what was checked, without an account, against each provider's
published API specification: every HTTP call an adapter makes, and every numbered assumption at the top of a sim
routes file. What a specification cannot settle still needs a live run of `pnpm test:live`
(`scenarios/contract.test.ts`).

Legend: ✅ matches the spec · ⚠️ differed from the spec (fixed in adapter and sim unless noted) · ❓ the spec is
silent; needs a live account.

## Sources

All fetched on 2026-10-10 and treated as data; none is vendored into the repository.

| Provider | Source | Version |
|---|---|---|
| Vercel | OpenAPI document, https://openapi.vercel.sh/ | as served on that date |
| Neon | OpenAPI document, https://neon.tech/api_spec/release/v2.json | `v2` |
| Clerk | Backend API OpenAPI, https://github.com/clerk/openapi-specs `bapi/2026-05-12.yml` (commit `3b078e5`); the `/redirect_urls` section is identical in `bapi/2021-02-05.yml` | `2026-05-12` |
| Clerk | Official SDK sources, for the list envelope the spec does not describe: RedirectUrlApi.ts (backend package) in clerk/javascript, redirecturl/client.go in clerk/clerk-sdk-go (v2) | `main` / `v2` on that date |

| Cloudflare | OpenAPI document, https://github.com/cloudflare/api-schemas (`openapi.json`); API reference https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/ and [`…/methods/edit/`](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/); the Pages and fundamentals pages cited below | fetched 2026-10-11 |

Vercel, Neon and Clerk use bearer authentication (`securitySchemes`), which is what the shared HTTP client sends: ✅.
So does Cloudflare's API token ("The preferred authorization scheme"): ✅.

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

## Cloudflare

### Calls the adapter makes

| Call | What the adapter sends and reads | Spec | Notes |
|---|---|---|---|
| base URL and auth | `https://api.cloudflare.com/client/v4`, `Authorization: Bearer <CLOUDFLARE_API_TOKEN>` | ✅ | [Make API calls](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/). The token needs the account permission "Cloudflare Pages Edit" ([permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/); schema token groups `Pages Read`/`Pages Write`). |
| `GET /accounts/{account_id}/pages/projects/{project_name}` | reads `success`, `result.deployment_configs.{preview,production}.env_vars`: NAME → `{ type, value }` | ✅ | Schema `pages_project` (required `deployment_configs`, each with `env_vars`, a nullable map of `pages_plain_text_env_var` / `pages_secret_text_env_var`). A null `env_vars` or entry is read as empty / absent. |
| same, secrets | a `secret_text` value is never used, whatever the answer holds | ❓ → hardened | The docs say a secret cannot be seen after it is set ([bindings](https://developers.cloudflare.com/pages/functions/bindings/)); the schema's example is `{"type":"secret_text","value":""}` (marked `x-sensitive`). Not stated whether `value` is `""`, null or absent; the adapter ignores it in every case (CF3). |
| `PATCH` of the same path | body `{ deployment_configs: { <target>: { env_vars: { NAME: { type, value } \| null } } } }`, sent as idempotent | ✅ `null`, ❓ merge | "To delete an environment variable, set its key to `null`" (schema and edit reference). That keys not in the body are kept is implied (the rule, and no required body field) but not stated; the adapter re-reads after every write and fails with `PROVIDER_RESPONSE` naming any key it did not send that disappeared (CF4, pinned). Answer `200` with the project: ✅. |
| same, concurrency | none | ✅ (none exists) | No `If-Match`/ETag parameter and no `412` on this operation (CF5). Two writers of one key: last write wins. |
| failures | `4XX { success: false, errors: [{ code, message }] }`; unknown project → `404` | ✅ shape, ❓ `404` | Schema `pages_api-response-common-failure`; it declares only `4XX`. `404` with code `8000007` comes from Wrangler's error reports, not the spec (CF6). The shared client classifies by status. |
| rate limit | `429` retried, honouring `Retry-After` | ✅ | "1,200 requests per five minute period per user"; `Retry-After` in seconds ([limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)). |

### Sim assumptions (`packages/sim/src/routes/cloudflare.ts`)

| Id | Assumption | Status |
|---|---|---|
| CF1 | base URL, bearer token, "Pages Edit" permission | ✅ verified |
| CF2 | GET envelope and `deployment_configs.<env>.env_vars` shape | ✅ verified |
| CF3 | a secret's value is never returned; the entry keeps its type | partly verified (docs and schema example); exact form ❓ (pinned by the contract suite) |
| CF4 | PATCH merges the map; `null` deletes; `200` with the project | `null` and `200` ✅; merge ❓ (pinned) |
| CF5 | no precondition on the PATCH | ✅ verified |
| CF6 | failure envelope; unknown project `404` / `8000007` | envelope ✅; status and code ❓ |
| CF7 | a write is visible to the next GET | ❓ (pinned) |
| CF8 | one set of preview variables for every preview deployment | ✅ verified: "This will set the configuration for all preview deployments, not just the deployments from a specific branch" ([Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)) |
| CF9 | no documented pattern for variable names | ✅ (schema map keys are free-form) |
| CF10 | a variable reaches only later deployments | indirectly documented ("Redeploy your project for the binding to take effect", [bindings](https://developers.cloudflare.com/pages/functions/bindings/)); the adapter does not redeploy |

### Not built, and why

- **Preview URL output.** [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
  documents the branch alias `<alias>.<project>.pages.dev` and that "Branch name aliases are lowercased and
  non-alphanumeric characters are replaced with a hyphen", but not the shortening of long names (a 28-character
  limit appears only in community answers) or what happens on collisions, and the host is the project's `subdomain`,
  which may differ from its name. Computing it from the branch would sometimes be wrong, so `pages_env` has no
  outputs. The deployment object's documented `aliases` list is the reliable source, for a later deployment op.

## What still needs a live account

- Vercel: V1 (propagation of env writes), the deployment list's order, whether `decrypt=true` still decrypts,
  what `created` contains for updated entries and how overlapping target sets are refused, whether the env list
  pages with `until`, branch auto-cancel, and that a `gitSource` deployment from the project's `link` builds.
- Neon: N1 (list visibility during an asynchronous delete), N2 (which requests answer `423`, endpoint readiness),
  N5 (status of a duplicate branch name).
- Clerk: C1 (status and wording of a duplicate), C2 (the envelope, confirmed only through the SDKs).
- Cloudflare: CF3 (what a secret's `value` looks like in GET), CF4 (that PATCH merges the map), CF6 (status of an
  unknown project), CF7 (a write is readable at once).

Run them with `pnpm test:live`; see the header of `scenarios/contract.test.ts`.
