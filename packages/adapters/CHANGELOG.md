# @sponson/adapters

## 0.5.0

### Minor Changes

- 499907c: **Breaking:** a `launchdarkly` provider block that names a production environment now needs `--approved-by`, even
  under `--env preview`: `production: true` in the block, or, without that key, an `environment` key containing `prod`
  in any case. If such a key is not production (`preprod`), add `production: false` to the block before the next apply.
  
  The approval gate sees the provider block: `OpSpec.writesEnvironment(params, ctx, provider)` gets the line's provider
  block as a third argument (optional for callers, so existing adapters and callers keep working). The generic `http`
  adapter takes `production: true` on an API block, making every line through that API need approval.
- c2cf912: New `cloudflare` adapter with one op, `pages_env`, which manages a Cloudflare Pages project's `preview` or `production` variables: plain text under `vars:`, secrets under `secrets:`. It needs `CLOUDFLARE_API_TOKEN` and `providers.cloudflare: { account, project }`. Sponson changes only the keys a line declares and never touches the others. Pages has one set of preview variables shared by every preview deployment, so a key belongs to the first scope that writes it; a second pull request that sets another value is refused with `OWNED_BY_OTHER_SCOPE`. A line's `target` must match the run's `--env`. The environment's variable map is locked as a shared parent object (`cloudflare:<account>:pages:<project>:<target>:env`, ADR 0019), so concurrent pull requests take turns writing it. Cloudflare never returns secret values, so secrets are compared by presence and type only; set `rewrite_secrets: true` to have every apply write them again, which is how a rotated secret gets written. `sponson init` now recognises Cloudflare Pages from `wrangler.toml`, `wrangler.json` or `wrangler.jsonc`, takes the project from its `name` and the account from `account_id` or `CLOUDFLARE_ACCOUNT_ID`, and writes a `pages_env` line instead of listing Cloudflare as not supported. The simulated provider is exported from `@sponson/sim` as `cloudflareSim`.
- 0b197ce: Feature-flag recipes for the generic `http` adapter, each of which manages one per-preview targeting entry and removes it on destroy (docs/recipes.md):
  
  - `posthog.release_condition` adds a release condition on a flag.
  - `statsig.gate_rule` adds a gate rule.
  - `growthbook.force_rule` adds a force rule, through the v2 API.
  - `unleash.flag_strategy` adds a constrained strategy in an environment. Unleash is per-instance, so set `base_url`.
  - `configcat.targeting_rule` adds a targeting rule on a boolean flag.
  - `split.targeting_rule` adds a targeting rule in an environment's definition.
  
  Each recipe lists, as numbered assumptions, which API facts are verified against the provider's docs or source and which are not. Flagsmith is not covered: its Admin API expects an `Api-Key` scheme prefix on the credential, which the adapter's auth forms do not send.
- 77006c1: Add the generic `http` adapter: manage any JSON (or form-encoded) REST API from the plan, without TypeScript. `http.resource` keeps one object per item (a feature flag, a webhook endpoint), located by a path or by a list and the fields that identify it; `http.list_item` keeps one entry in an array, a delimited string or a keyed map on a parent object (an allowed origin, a redirect allow-list entry, a config var) by read-modify-write with re-read verification. Each API is a block under `providers.http.<api>` that names its credential's environment variable (bearer, custom header or Basic). Intents, idempotent apply, drift by hash, destroy of only what Sponson created and secret redaction work as for every other adapter. See ADR 0017 and docs/plan-format.md. `OpSpec` gains two optional hooks, `providerFor` and `outputsFor`; the HTTP client takes static headers, form encoding and a content type; the sim gains a generic REST provider (`rest`).
- f3a532f: Adapter authors: `WriteOptions.contentType` sends a POST or PATCH body with a `Content-Type` other than `application/json` (the body is still JSON), for a JSON dialect such as LaunchDarkly's semantic patch. In `@sponson/sim`, a provider can declare `auth: "raw"` to expect its token as the whole `Authorization` value, and routes receive the request `headers`.
- 0b355f8: The generic `http` adapter takes three more shapes of API (ADR 0020, amendment 1). In `http.resource`, `create.locate: true` is for a create that answers with something other than the object, such as the parent it was added to: Sponson then finds the new object with `find` or `read`. In `http.list_item`, `parent.item_path` reads a parent that comes in an envelope (`{ feature: {...} }`) but is written bare. Also in `http.list_item`, `parent.send` now takes a list of the parent's fields, which are sent back with the collection. That suits a `PUT` that resets whatever it is not sent. Record ids of existing lines are unchanged. Recipes may now leave `base_url` out for a per-account API, giving a `base_url_example` instead. In the sim, the generic REST provider accepts a bare token in `Authorization`, adds creates posted to an alias path (`aliases`) to their collection, and answers an object in the `item_path` envelope of its style.
- 6e53e7d: `http.resource` outputs can be declared once-only (`{ path, sensitive: true, once: true }`): the value is taken only
  from the create that made the object, and later runs treat references to it as ADR 0018 describes. A recipe op can set
  what destroy does by default (`destroy: keep`, or `destroy: never` when the provider cannot delete). The generic REST
  sim ignores trailing slashes, lists a collection under declared `aliases`, and accepts the credential in declared
  `auth_headers`.
- 0c41729: The generic `http` adapter gained recipes: verified specs for one provider operation, shipped in `@sponson/adapters` under `recipes/`. A plan line names one with `recipe: <provider>.<op>` and fills in its typed params (`adapter: http, op: resource, recipe: cloudflare.dns_cname, zone_id: …, name: …, target: …`); the `providers.http.<provider>` block is optional and overrides the recipe's base URL, credential variable, headers or encoding. Params are checked before any request (`PARAM_INVALID` naming the param; an unknown recipe or op lists the known ones). The ledger records the resolved API block and the expanded requests' keys, so a recipe line and the hand-written line it expands into are the same resource. First recipes: `cloudflare.dns_cname` and `turso.database_branch` (docs/recipes.md). The sim's generic REST provider answers per-collection response styles (`RestStyle`: envelopes, cursor, id field, integer ids) and accepts credentials in any `*-Key` or `*-Token` header.
- ae9655e: Added the `launchdarkly` adapter: `launchdarkly.flag_target` serves a flag variation to one context key (a preview URL, or the scope such as `pr-42`) in the environment `providers.launchdarkly` names, and `apply --destroy` removes exactly that target. A target moved to another variation in the LaunchDarkly console is `changed` drift. It needs `LAUNCHDARKLY_ACCESS_TOKEN`. `sponson init` now recognises LaunchDarkly as supported and writes a commented example line for it, and `@sponson/sim` simulates LaunchDarkly's flag targeting.
- cf4be11: `supabase.auth_redirect` and `http.list_item` now lock the object their list lives on (ADR 0019):
  `supabase:<project ref>:auth-uri-allow-list`, and `http:<base_url><parent path>` (never a credential). Pull requests
  and environments adding or removing entries of one list at the same moment no longer lose each other's writes. A line
  whose parent is busy waits with `--wait`, or fails with `LOCK_HELD`. Entries applied by an earlier version carry no
  lock name in their receipts: re-apply once (unchanged lines record it) so that a later destroy of them is locked too.
- aebda52: Added manual steps (ADR 0021) for state no API can manage, such as a Google OAuth client's redirect URIs. A
  `manual.step` line (`title`, `instructions`, optional `undo`, `vars` and a `verify` GET) is shown by `plan` as `todo`
  with its instructions filled in. `apply` leaves it and the lines that depend on it waiting, applies everything else,
  and exits 2 with the new code `MANUAL_STEP_PENDING` and the steps' instructions in `manual`, until a person runs
  `apply --confirm <line>` (or its verify request sees it done); the ledger records who confirmed it (`--approved-by`,
  else the git user) and when. A verified step that stops verifying is `missing` drift. `apply --destroy` shows the
  step's `undo` and waits for the same confirmation. The MCP `sponson_apply` tool takes `confirm`; agents never pass
  it on their own. For adapter authors: `OpSpec.manual`, `PlanLineStatus` `todo`, and `RunOptions.confirm` /
  `confirmedBy`.
- ccef846: New `netlify` adapter (`NETLIFY_AUTH_TOKEN`, `providers.netlify: { site, account? }`). Op `env` owns one deploy context's value of each variable it declares (`production`, `deploy-preview`, `branch-deploy`, `dev`, `dev-server`, or `branch` with a branch name; previews default to the current git branch's value, which Netlify uses for that branch's Deploy Previews, so pull requests never share values). Values others set for other contexts are never changed, and destroy deletes a variable only when nothing is left in it. External outputs `preview_url` (the deploy's permalink), `deploy_id` and `deploy_preview_url` (`https://deploy-preview-<n>--<site>.netlify.app`) wait for a ready deploy of the commit that started after the values changed; an older production or branch deploy is rebuilt, and an older Deploy Preview, which Netlify's API cannot rebuild, is reported as `notes.stale_deploy`. The sim simulates Netlify's env and deploy APIs.
- e303004: New `planetscale` adapter (Vitess / MySQL databases). `planetscale.branch` creates a development branch per scope from a parent (default `main`), waits until PlanetScale reports it ready (`SPONSON_PLANETSCALE_POLL_MS`, `SPONSON_PLANETSCALE_READY_TIMEOUT_MS`), and deletes it on destroy. `planetscale.password` creates a password on that branch; its `connection_string` and `password` outputs exist only in the run that creates it (PlanetScale never shows the plaintext again), so reference them from lines in the same plan, such as a `vercel.env` `DATABASE_URL`. Later runs keep the value those lines hold and write nothing; Sponson never rotates the password on its own. Configure `providers.planetscale: { organization, database }` and set `PLANETSCALE_SERVICE_TOKEN_ID` and `PLANETSCALE_SERVICE_TOKEN`. The sim simulates the same API, with a `planetscale_ready_ms` chaos setting.
- 99dfe1f: New recipes: `github.repo_webhook`, `svix.endpoint`, `resend.api_key` (its token a once-only output),
  `resend.webhook`, `sendgrid.event_webhook`, `sendgrid.parse_setting`, `postmark.server`,
  `postmark_server.webhook`, `sentry.release` and `sentry.deploy` (both left in place on destroy), and
  `honeycomb.marker`. See docs/recipes.md.
- 3920b14: Add the `supabase` adapter (credential `SUPABASE_ACCESS_TOKEN`, Management API). `supabase.branch` creates a Supabase preview branch per scope, waits until it is `ACTIVE_HEALTHY` (`SPONSON_SUPABASE_TIMEOUT_MS`), and outputs its `project_ref`, `api_url`, `db_host` and a sensitive `connection_string`; destroy deletes it. `supabase.auth_redirect` keeps one URL in a project's Auth redirect allow-list (`uri_allow_list`), on the parent project or, with `project: { from: db.project_ref }`, on the branch, never touching entries Sponson did not add. The sim simulates both (chaos `supabase_ready_ms` delays readiness), and `sponson init` now writes Supabase lines when it detects Supabase instead of listing it as not supported.

### Patch Changes

- 0f4aee9: `netlify.env` lines now lock their site's variables (parent object `netlify:<site>:env`, ADR 0019), so pull requests that create the same variable at once, or destroy its last value while another adds one, no longer fail or lose a value.
- d9ab332: Published with npm provenance: each package's `publishConfig` now asks for it. 0.4.0 went out without attestations because `changeset publish` runs `pnpm publish`, which ignores the release workflow's `NPM_CONFIG_PROVENANCE`.
- Updated dependencies [499907c]
- Updated dependencies [77006c1]
- Updated dependencies [aebda52]
- Updated dependencies
- Updated dependencies [e303004]
- Updated dependencies [b645c29]
- Updated dependencies [d9ab332]
  - @sponson/core@0.5.0

## 0.4.0

### Minor Changes

- 8f1b9c2: `ApiClient` gains `put()`, retried after a 502/503/504 or a dropped connection like GET, and `post()`/`patch()` take `{ idempotent: true }` for writes that set state rather than add to it (a PATCH replacing a whole list), so they are retried the same way. `WriteOptions` joins the stable authoring API.

### Patch Changes

- 78eef8a: Security: the `doppler://` and `aws-sm://` secret sources refused nothing that looked like a command-line option, so a reference such as `doppler://p/c/--help` passed `--help` to the CLI. Every CLI-backed source now declares which arguments come from the reference, and one starting with `-` is refused with SECRET_UNRESOLVED before the CLI runs.
- 510ebe8: Internal: the HTTP client's retry loop and response decoding are separate (`decode`); behaviour is unchanged.
- 53e7446: npm metadata: every package has keywords and its homepage is the documentation site (https://sponson.mintlify.site); the package READMEs link to it, and the CLI's README states the Node.js 22 requirement its `engines` already declared.
- Updated dependencies [b028881]
- Updated dependencies [eec4766]
- Updated dependencies [9b6c97a]
- Updated dependencies [53e7446]
  - @sponson/core@0.4.0

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
