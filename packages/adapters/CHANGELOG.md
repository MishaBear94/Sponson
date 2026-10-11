# @sponson/adapters

## 0.6.1

### Patch Changes

- 25c1dc4: Every package now carries an npm provenance attestation, so you can check it was built from this repository by its release workflow (`npm audit signatures`). 0.4.0 to 0.6.0 were published without one.
- Updated dependencies [25c1dc4]
  - @sponson/core@0.6.1

## 0.6.0

### Minor Changes

- 379caf9: New `cloud_run` adapter with one op, `cloud_run.revision`: a revision of an existing Google Cloud Run service per scope, made from the service's template with the line's image and environment variables (`{ from }` and `{ secret }` values included), tagged (`pr-42` by default) with its own URL as the `url` output, and given no traffic; `apply` waits for Cloud Run's operations and for the revision to be ready, drift covers the image and the declared variables, and destroy removes the tag. It authenticates with the token `gcloud auth print-access-token` prints and needs `providers.cloud_run.project` and `.region`; `production: true` in that block makes its lines need approval. Traffic is never moved: when a share of the service's traffic follows LATEST, the line is refused before any write unless it sets `pin_latest: true`, which pins that share to the revision serving it, as `gcloud run deploy --no-traffic` does (see docs/plan-format.md for what that means for later production deploys). `sponson init` detects Cloud Run, `AdapterAbout` gains `credentialCommand` for adapters that take a CLI's token, and the sim gained a Cloud Run provider. Covers the last uncovered row of the coverage matrix, `cloud-run-tag`.
- 379caf9: **Breaking:** the `cloud_run.traffic_tag` recipe is removed; `cloud_run.revision` makes the revision and its tag (ADR 0023). Before upgrading, run `sponson apply --destroy` for every open scope with a `recipe: cloud_run.traffic_tag` line (or remove those tags with `gcloud run services update-traffic <service> --remove-tags <tag>`), then replace the line with `adapter: cloud_run`, `op: revision` and the image and variables your deploy used to set.

### Patch Changes

- Updated dependencies [379caf9]
  - @sponson/core@0.6.0

## 0.5.0

### Minor Changes

- 66e68f3: New `algolia` adapter with one op, `algolia.index`: an index per scope copied from a template index, waiting for Algolia's copy task to be published before the line counts as applied; destroy deletes the copy, never the template. Needs `ALGOLIA_API_KEY` and `providers.algolia.application_id`. The sim gained an Algolia provider.
- 499907c: **Breaking:** a `launchdarkly` provider block that names a production environment now needs `--approved-by`, even
  under `--env preview`: `production: true` in the block, or, without that key, an `environment` key containing `prod`
  in any case. If such a key is not production (`preprod`), add `production: false` to the block before the next apply.
  
  The approval gate sees the provider block: `OpSpec.writesEnvironment(params, ctx, provider)` gets the line's provider
  block as a third argument (optional for callers, so existing adapters and callers keep working). The generic `http`
  adapter takes `production: true` on an API block, making every line through that API need approval.
- c2cf912: New `cloudflare` adapter with one op, `pages_env`, which manages a Cloudflare Pages project's `preview` or `production` variables: plain text under `vars:`, secrets under `secrets:`. It needs `CLOUDFLARE_API_TOKEN` and `providers.cloudflare: { account, project }`. Sponson changes only the keys a line declares and never touches the others. Pages has one set of preview variables shared by every preview deployment, so a key belongs to the first scope that writes it; a second pull request that sets another value is refused with `OWNED_BY_OTHER_SCOPE`. A line's `target` must match the run's `--env`. The environment's variable map is locked as a shared parent object (`cloudflare:<account>:pages:<project>:<target>:env`, ADR 0019), so concurrent pull requests take turns writing it. Cloudflare never returns secret values, so secrets are compared by presence and type only; set `rewrite_secrets: true` to have every apply write them again, which is how a rotated secret gets written. `sponson init` now recognises Cloudflare Pages from `wrangler.toml`, `wrangler.json` or `wrangler.jsonc`, takes the project from its `name` and the account from `account_id` or `CLOUDFLARE_ACCOUNT_ID`, and writes a `pages_env` line instead of listing Cloudflare as not supported. The simulated provider is exported from `@sponson/sim` as `cloudflareSim`.
- 982d0d7: Added recipes for deploy targets: `railway.variable` (a variable in a PR environment, GraphQL), `fly_machines.app` and
  `fly.secret` (a per-PR Fly app and its secrets, compared by presence only), `amplify.branch` and
  `amplify.branch_variable` (SigV4), `cloud_run.traffic_tag` (a per-PR revision tag, written with the service's etag) and
  `azure_swa.build_app_setting` (an app setting of a preview environment).
- 2750ee7: New `digitalocean` adapter with one op, `digitalocean.app`: a DigitalOcean App Platform app per scope from a whole app spec (environment variables included), waited for until its deployment is live; drift covers the declared fields of the spec (platform defaults and encrypted secret values ignored). Needs `DIGITALOCEAN_ACCESS_TOKEN`. The sim gained an App Platform provider.
- 0b197ce: Feature-flag recipes for the generic `http` adapter, each of which manages one per-preview targeting entry and removes it on destroy (docs/recipes.md):
  
  - `posthog.release_condition` adds a release condition on a flag.
  - `statsig.gate_rule` adds a gate rule.
  - `growthbook.force_rule` adds a force rule, through the v2 API.
  - `unleash.flag_strategy` adds a constrained strategy in an environment. Unleash is per-instance, so set `base_url`.
  - `configcat.targeting_rule` adds a targeting rule on a boolean flag.
  - `split.targeting_rule` adds a targeting rule in an environment's definition.
  
  Each recipe lists, as numbered assumptions, which API facts are verified against the provider's docs or source and which are not. Flagsmith is not covered: its Admin API expects an `Api-Key` scheme prefix on the credential, which the adapter's auth forms do not send.
- 77006c1: Add the generic `http` adapter: manage any JSON (or form-encoded) REST API from the plan, without TypeScript. `http.resource` keeps one object per item (a feature flag, a webhook endpoint), located by a path or by a list and the fields that identify it; `http.list_item` keeps one entry in an array, a delimited string or a keyed map on a parent object (an allowed origin, a redirect allow-list entry, a config var) by read-modify-write with re-read verification. Each API is a block under `providers.http.<api>` that names its credential's environment variable (bearer, custom header or Basic). Intents, idempotent apply, drift by hash, destroy of only what Sponson created and secret redaction work as for every other adapter. See ADR 0017 and docs/plan-format.md. `OpSpec` gains two optional hooks, `providerFor` and `outputsFor`; the HTTP client takes static headers, form encoding and a content type; the sim gains a generic REST provider (`rest`).
- c3a65ba: One-off actions (ADR 0022): a new `http.action` op sends one request (or GraphQL request) when its declared `trigger` changes, for side effects with nothing to read back or delete (an Inngest sync, a cache purge, a deploy notification). `plan` shows the new status `run` (symbol `>`) until the current trigger has run in the scope, then `unchanged`; `apply` sends it, checks the answer (status, `ok_status`, `expect`), and records the trigger hash, its outputs and its optional `undo`, which `apply --destroy` sends. Delivery is at least once (nothing is recorded before the request is sent; `request.idempotency_key: true` derives an `Idempotency-Key` from the ledger key and the trigger hash), and rollback never undoes an action. A request may go to an absolute `url` (the app's own endpoint), which never receives an API credential. The engine gained the optional `OpSpec.action` hook, `ActionTrigger`, `LedgerEntry.action`, and `run` in `PlanLineStatus` and `DiffKind`. The REST sim gained logged endpoints (`endpoints`, `calls`; assumption R9).
- 4bd1595: The generic `http` adapter authenticates with a header credential behind a literal `prefix` (`Authorization: Api-Key <key>`), several credential headers at once (`auth: { headers: [...] }`), an OAuth2 client-credentials token (`auth: { oauth2_client_credentials }`: Auth0, Kinde, Okta custom servers), a token a CLI prints (`auth: { command: [gcloud, auth, print-access-token] }`), AWS SigV4 (`auth: { aws_sigv4 }`) and HTTP Digest (`auth: { digest }`: MongoDB Atlas), speaks XML (`encoding: xml`, S3 bucket CORS) and GraphQL (`{ graphql: { query, variables, data_path } }` in place of any request of `http.resource`: Railway variables, Fly.io secrets). Tokens obtained at run time are registered with the redactor through the new optional `AdapterContext.secret`. `http.list_item` gains `parent.if_missing`, `parent.when_empty`, `send: collection`, and API blocks a versioned `media_type`. The sim checks each scheme for real (an OAuth2 token endpoint, Digest challenges, SigV4 verification) and adds `aws`, `railway` and `fly` providers.
- f3a532f: Adapter authors: `WriteOptions.contentType` sends a POST or PATCH body with a `Content-Type` other than `application/json` (the body is still JSON), for a JSON dialect such as LaunchDarkly's semantic patch. In `@sponson/sim`, a provider can declare `auth: "raw"` to expect its token as the whole `Authorization` value, and routes receive the request `headers`.
- 0b355f8: The generic `http` adapter takes three more shapes of API (ADR 0020, amendment 1). In `http.resource`, `create.locate: true` is for a create that answers with something other than the object, such as the parent it was added to: Sponson then finds the new object with `find` or `read`. In `http.list_item`, `parent.item_path` reads a parent that comes in an envelope (`{ feature: {...} }`) but is written bare. Also in `http.list_item`, `parent.send` now takes a list of the parent's fields, which are sent back with the collection. That suits a `PUT` that resets whatever it is not sent. Record ids of existing lines are unchanged. Recipes may now leave `base_url` out for a per-account API, giving a `base_url_example` instead. In the sim, the generic REST provider accepts a bare token in `Authorization`, adds creates posted to an alias path (`aliases`) to their collection, and answers an object in the `item_path` envelope of its style.
- 67f0615: `http` lines may take their credential from another line: `credential: { from: <line>.<output> }` (a sensitive output that is not once-only) or `credential: { secret: … }` replaces the API block's variable for that line, never part of its identity; the line must say `destroy: keep`. The engine checks such params before any request through the new optional `OpSpec.credentialInputs` hook (a literal, a non-sensitive or a once-only output is `PARAM_INVALID`). A `POST` delete's body may name the object with `{id}` (Datadog's `{ public_ids: ["{id}"] }`), and `http.list_item` over XML reads a lone element as a list of one where the item declares a list. The REST sim gained stored generated fields with a header that accepts them, and bulk deletes by body.
- 2b2a04e: `http` API blocks: an OAuth2 `token_url` or `audience` written as a path (`/oauth/token`, `/api/v2/`) is resolved against the origin of the block's `base_url`, so a per-account API names its account once. `http.list_item`: `parent.write_list_path` writes the collection under another name than it is read (Kinde reads `{ redirect_urls }`, replaces with `{ urls }`). Recipes may declare `oauth2_client_credentials`, `command` and header-`prefix` credentials. The REST sim stores an object's `write_fields` under their read names.
- a7d6527: The generic `http` adapter can now declare an output the provider shows only when it creates the object (`outputs.<name>: { path, sensitive: true, once: true }`, such as a webhook signing secret: it reaches dependent lines in the same run, and later runs keep what they hold, ADR 0018), archive instead of delete (`delete: { method: POST, body: { active: false } }`), and refuse credentials by prefix (`refuse_credential: { prefixes: [sk_live_], unless_env: NAME }` on an API block). Recipes gain a `{ join: [...] }` template form for values such as a preview URL plus a path. The REST sim types form values, shows once-only fields only in the create's answer, accepts POST updates to objects, and can list under a suffix and name objects by a query parameter.
- 6e53e7d: `http.resource` outputs can be declared once-only (`{ path, sensitive: true, once: true }`): the value is taken only
  from the create that made the object, and later runs treat references to it as ADR 0018 describes. A recipe op can set
  what destroy does by default (`destroy: keep`, or `destroy: never` when the provider cannot delete). The generic REST
  sim ignores trailing slashes, lists a collection under declared `aliases`, and accepts the credential in declared
  `auth_headers`.
- 0c41729: The generic `http` adapter gained recipes: verified specs for one provider operation, shipped in `@sponson/adapters` under `recipes/`. A plan line names one with `recipe: <provider>.<op>` and fills in its typed params (`adapter: http, op: resource, recipe: cloudflare.dns_cname, zone_id: …, name: …, target: …`); the `providers.http.<provider>` block is optional and overrides the recipe's base URL, credential variable, headers or encoding. Params are checked before any request (`PARAM_INVALID` naming the param; an unknown recipe or op lists the known ones). The ledger records the resolved API block and the expanded requests' keys, so a recipe line and the hand-written line it expands into are the same resource. First recipes: `cloudflare.dns_cname` and `turso.database_branch` (docs/recipes.md). The sim's generic REST provider answers per-collection response styles (`RestStyle`: envelopes, cursor, id field, integer ids) and accepts credentials in any `*-Key` or `*-Token` header.
- 87aa4b0: `http.resource` requests take per-request `headers` (values may be references) and `send_fields: false` (the declared fields are compared but carried in headers, not the body), and a path placeholder written `{+name}` keeps a URL as it is (RFC 6570 reserved expansion). Together they express APIs such as QStash's schedules (`POST /v2/schedules/<destination URL>` with `Upstash-Cron`). The REST sim's styles gained `header_fields` and `suffix_field` to stand in for them.
- 3b2dfb2: Recipes for identity providers' preview URLs: `auth0.callback_url`, `auth0.logout_url`, `auth0.web_origin` and `auth0.allowed_origin` (Management API, client-credentials token), `firebase.authorized_domain` (Identity Toolkit, `gcloud auth print-access-token`), `okta.redirect_uri`, `okta.post_logout_redirect_uri` and `okta.trusted_origin` (`SSWS` API token), and `kinde.callback_url` and `kinde.logout_url` (Management API, client-credentials token).
- ae9655e: Added the `launchdarkly` adapter: `launchdarkly.flag_target` serves a flag variation to one context key (a preview URL, or the scope such as `pr-42`) in the environment `providers.launchdarkly` names, and `apply --destroy` removes exactly that target. A target moved to another variation in the LaunchDarkly console is `changed` drift. It needs `LAUNCHDARKLY_ACCESS_TOKEN`. `sponson init` now recognises LaunchDarkly as supported and writes a commented example line for it, and `@sponson/sim` simulates LaunchDarkly's flag targeting.
- dc73c90: `http.list_item` reads a parent with a POST when `parent.read_method: POST` (an Azure Resource Manager list action
  such as `listAppSettings`), and recipes may take a `command` or `aws_sigv4` credential and be tested against a
  first-class sim (`sim.provider`). The REST sim answers seeded `reads` POSTs without logging a write, and
  `ProviderSim.isWrite` receives the provider's state.
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
- 4b0ca25: Five more built-in secret schemes: `vault://mount/path#KEY` (HashiCorp Vault KV v2 over HTTP, `VAULT_ADDR`, `VAULT_TOKEN`, optional `VAULT_NAMESPACE`), `infisical://projectId/env/[folder/…/]NAME` (Infisical CLI; an unknown name is `SECRET_UNRESOLVED`, never the CLI's `*not found*` placeholder), `azure-kv://vault/name[/version]` (Azure CLI), `op-connect://vault/item/[section/]field` (a 1Password Connect server, `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`) and `bws://secret-id` (Bitwarden Secrets Manager CLI, `BWS_ACCESS_TOKEN`). See docs/plan-format.md#secret-schemes.
- ccef846: New `netlify` adapter (`NETLIFY_AUTH_TOKEN`, `providers.netlify: { site, account? }`). Op `env` owns one deploy context's value of each variable it declares (`production`, `deploy-preview`, `branch-deploy`, `dev`, `dev-server`, or `branch` with a branch name; previews default to the current git branch's value, which Netlify uses for that branch's Deploy Previews, so pull requests never share values). Values others set for other contexts are never changed, and destroy deletes a variable only when nothing is left in it. External outputs `preview_url` (the deploy's permalink), `deploy_id` and `deploy_preview_url` (`https://deploy-preview-<n>--<site>.netlify.app`) wait for a ready deploy of the commit that started after the values changed; an older production or branch deploy is rebuilt, and an older Deploy Preview, which Netlify's API cannot rebuild, is reported as `notes.stale_deploy`. The sim simulates Netlify's env and deploy APIs.
- e303004: New `planetscale` adapter (Vitess / MySQL databases). `planetscale.branch` creates a development branch per scope from a parent (default `main`), waits until PlanetScale reports it ready (`SPONSON_PLANETSCALE_POLL_MS`, `SPONSON_PLANETSCALE_READY_TIMEOUT_MS`), and deletes it on destroy. `planetscale.password` creates a password on that branch; its `connection_string` and `password` outputs exist only in the run that creates it (PlanetScale never shows the plaintext again), so reference them from lines in the same plan, such as a `vercel.env` `DATABASE_URL`. Later runs keep the value those lines hold and write nothing; Sponson never rotates the password on its own. Configure `providers.planetscale: { organization, database }` and set `PLANETSCALE_SERVICE_TOKEN_ID` and `PLANETSCALE_SERVICE_TOKEN`. The sim simulates the same API, with a `planetscale_ready_ms` chaos setting.
- 22e83a1: Provider detection is data: a recipe file's new `detect` block (package names, config files, variable names, database URL hosts, the `starter` lines and `where` to find each param) and an adapter's `about.title`, `about.category` and `about.detect` tell `sponson init` how to find the provider and what to write, so adding a recipe makes `init` detect it with no CLI change. New exports: `detectableProviders(registry)` and `recipeCredentialEnv(recipe)`. The new generated catalog, [docs/providers.md](https://github.com/MishaBear94/Sponson/blob/main/docs/providers.md), lists every supported provider by category with its ops, credential, detection signals and a line to start from.
- c3a65ba: New recipe `inngest.sync` (coverage row `inngest-sync`): syncs a preview deployment into its Inngest branch environment by sending `PUT` to the app's serve endpoint (`/api/inngest` by default) once per deployment URL and revision. The app's SDK registers itself with its own signing key into the environment `INNGEST_ENV` names, so the line needs no Inngest credential; extra `headers` (such as a Vercel deployment protection bypass, as a secret) are passed on. Recipes may now be `kind: action`, and a recipe whose ops are all actions sent to the app's own URL has no `api` block.
- 4ff44ba: New recipe `qstash.schedule`: an Upstash QStash cron schedule that calls a preview's URL, under a schedule id per scope (created and updated by QStash's upsert; cron, destination and method compared for drift).
- 67f0615: New recipes: `mongodb_atlas.database_user` (Digest, versioned media type, password as a reference), `cockroachdb.database` and `cockroachdb.sql_user` (Cloud API), `gcs.bucket_cors` (Firebase Storage / GCS bucket CORS through `gcloud auth print-access-token`), `s3.bucket_cors` (S3 and R2 bucket CORS, SigV4 and XML), `flagsmith.environment` (`Authorization: Api-Key`), and `datadog.synthetic_api_test` (API and application keys). `postmark_server.webhook` now chains with `postmark.server` in one plan through `credential: { from: <server line>.server_token }`. Recipe files may use every credential form of the `http` adapter and `encoding: xml`.
- 15b9e62: New recipes: `render.env_var` (a Render service's environment variable), `heroku.config_var` (one config var on a Heroku app, merge-patched), `vercel.project_domain` (a branch-bound domain on a Vercel project), `upstash.redis_database` (an Upstash Redis database with its credentials as outputs), and `prisma.database` / `prisma.database_copy` (a Prisma Postgres database, its connection strings as once-only outputs).
- 99dfe1f: New recipes: `github.repo_webhook`, `svix.endpoint`, `resend.api_key` (its token a once-only output),
  `resend.webhook`, `sendgrid.event_webhook`, `sendgrid.parse_setting`, `postmark.server`,
  `postmark_server.webhook`, `sentry.release` and `sentry.deploy` (both left in place on destroy), and
  `honeycomb.marker`. See docs/recipes.md.
- 450470f: New recipes: `stripe.webhook_endpoint` (a test-mode webhook endpoint per preview at the preview's URL, whose signing secret reaches an env line such as `STRIPE_WEBHOOK_SECRET` in the same run; live-mode keys are refused unless `SPONSON_STRIPE_ALLOW_LIVE=1`), `stripe.product`, `stripe.price` and `stripe.coupon` (test-mode catalog objects; products and prices are archived on destroy), `workos.redirect_uri` (an AuthKit redirect URI) and `stytch.redirect_url` (a redirect URL of a Stytch project environment). See docs/recipes.md.
- 3920b14: Add the `supabase` adapter (credential `SUPABASE_ACCESS_TOKEN`, Management API). `supabase.branch` creates a Supabase preview branch per scope, waits until it is `ACTIVE_HEALTHY` (`SPONSON_SUPABASE_TIMEOUT_MS`), and outputs its `project_ref`, `api_url`, `db_host` and a sensitive `connection_string`; destroy deletes it. `supabase.auth_redirect` keeps one URL in a project's Auth redirect allow-list (`uri_allow_list`), on the parent project or, with `project: { from: db.project_ref }`, on the branch, never touching entries Sponson did not add. The sim simulates both (chaos `supabase_ready_ms` delays readiness), and `sponson init` now writes Supabase lines when it detects Supabase instead of listing it as not supported.
- 7dc82ef: New `xata` adapter with one op, `xata.branch`: a copy-on-write Postgres branch per scope on the Xata platform, waited for until healthy, with its connection string as a sensitive output (readable on every run). Needs `XATA_API_KEY` and `providers.xata.organization` and `.project`. The sim gained a Xata provider.

### Patch Changes

- 3d579f3: `http.resource` destroy accepts any 2xx answer to its delete request, even one that is not JSON (Upstash answers `OK`), instead of failing after the object was deleted.
- 0f4aee9: `netlify.env` lines now lock their site's variables (parent object `netlify:<site>:env`, ADR 0019), so pull requests that create the same variable at once, or destroy its last value while another adds one, no longer fail or lose a value.
- d9ab332: Published with npm provenance: each package's `publishConfig` now asks for it. 0.4.0 went out without attestations because `changeset publish` runs `pnpm publish`, which ignores the release workflow's `NPM_CONFIG_PROVENANCE`.
- Updated dependencies [499907c]
- Updated dependencies [77006c1]
- Updated dependencies [c3a65ba]
- Updated dependencies [4bd1595]
- Updated dependencies [67f0615]
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
