# Provider coverage

How much of the per-environment SaaS state a typical US/EU web team touches Sponson can manage today, how that was
measured, and what it takes to cover the rest. Written against Sponson 0.4.0 on 2026-10-11; the built-in adapters it
counts are the ones [listed in docs/plan-format.md](plan-format.md#built-in-ops). API facts come from the providers'
published docs ([Sources](#sources)); a fact marked **(unverified)** comes from memory or a secondary source and needs
checking before an adapter relies on it.

- [Scope: what ships beside the code](#scope-what-ships-beside-the-code)
- [Coverage matrix](#coverage-matrix)
- [Current coverage](#current-coverage)
- [Strategy](#strategy)
- [Sources](#sources)

## Scope: what ships beside the code

A piece of SaaS state is in scope when **all four** hold:

| Test | Meaning | Example in scope | Example out of scope |
|---|---|---|---|
| Keyed to an environment | Its identity derives from the environment and scope (`preview`/`pr-42`, `production`): a name, a URL, a branch, a target. | Neon branch `sponson/preview/pr-42` | The Neon project |
| Lives and dies with it | Created (or changed) when the environment comes up or a release changes it; destroyed (or reverted) when the PR closes. | A preview URL on Auth0's callback list | The Auth0 application itself |
| Tells a service how to treat this deployment | Data (a DB branch), configuration (env vars), trust (callback allow-lists, authorized domains, CORS origins), behaviour (flag targeting), inbound events (webhook endpoints), routing (a branch domain, a DNS record), annotation (a release marker). | Stripe webhook endpoint pointing at the preview URL | The Stripe account's branding |
| Reachable by API with a CI credential | A documented HTTP API or CLI the CI job can call with a token it already holds. | Supabase `uri_allow_list` via the Management API | Google OAuth client redirect URIs (Console only) |

Out of scope, by design (Terraform's or Pulumi's job, see [ROADMAP.md](../ROADMAP.md#not-planned)): the **parent
objects** these hang off (projects, tenants, applications, accounts, zones, buckets, clusters, flag definitions),
organisation, IAM and billing, networking, and anything that outlives every environment. Also out of scope: build
artifacts (source-map uploads), application data (seed rows belong to the app's migration tool) and the deploy itself
beyond triggering and waiting on it (`vercel.deploy`). Production lines are in scope only for the state a release
changes; long-lived production objects enter a plan as `{ keep: true }` adoptions, never as creations.

## Coverage matrix

Columns:

- **Side effect**: what one environment adds, changes or removes.
- **API shape**: endpoint or CLI, auth, and the write model: **object** (one API object per item, created and deleted
  on its own) or **list** (one array or map on a parent object, read-modify-write). For list shapes, concurrent
  writers would lose updates; the op declares the parent object (`lockOn`) and the engine serialises Sponson's writers
  with a lock per object ([ADR 0019](adr/0019-parent-object-locks.md)), on top of any precondition the provider offers.
- **Generic?**: could the declarative HTTP adapter described under [Strategy](#strategy) express it? **Y** yes,
  **P** partly (the lifecycle needs more than request templates, noted), **N** no.
- **Pri**: how often it appears in preview-environment workflows. **P0** most preview setups on that stack hit it;
  **P1** common; **P2** occasional. An estimate from public templates, integrations and docs, not a survey.
- **Now**: **yes** when a built-in op or a shipped [recipe](recipes.md) covers it; **manual step** when no API can
  and a [`manual.step`](plan-format.md#manualstep) line tracks what a person does ([ADR 0021](adr/0021-manual-steps.md)),
  never counted as automated; **no (no API)** when nothing can.

The rows live in [coverage.yaml](coverage.yaml) (`covered_by` names the op or recipe op that manages each one) and
the tables below are generated from it: edit the data, then run `pnpm docs:gen`.

<!-- generated:coverage-matrix:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
### Deploy targets and their environment variables

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Vercel | Env vars per target and git branch; wait for the preview deployment, redeploy if it built before the write | REST `/v10/projects/{id}/env`, bearer; object per variable; deployment barrier | P (barrier, redeploy) | P0 | **yes** (`vercel.env`, `vercel.deploy`) |
| Netlify | Env var values per deploy context (`deploy-preview`, `branch` + `context_parameter`); wait for the deploy of the commit, rebuild if it started before the write | REST `POST /api/v1/accounts/{account}/env?site_id=`, `PATCH .../env/{key}`; bearer; object per key, values list per context; deploys only see values set before they started | P (deploy barrier like Vercel) | P0 | **yes** (`netlify.env`) |
| Cloudflare Pages / Workers | Pages: `deployment_configs.preview.env_vars` (all previews share one set, no per-branch values). Workers: secrets per script / preview version | REST `PATCH /accounts/{a}/pages/projects/{p}`, bearer; **map** merge-patch, `null` deletes; Workers `PUT .../workers/scripts/{s}/secrets` object | Y | P1 | **yes** (`cloudflare.pages_env`: Pages variables; Workers secrets are not covered) |
| Render | Env vars on a preview service / preview environment | REST `PUT /v1/services/{id}/env-vars/{key}`, bearer; object per key; previews created by Render from `render.yaml` | Y | P1 | **yes** (recipe [`render.env_var`](recipes.md#renderenv_var): per variable on a service whose id the plan gives (Render creates previews itself; no lookup of PR N's service); writing does not deploy) |
| Railway | Variables in a PR environment (Railway creates PR environments natively) | GraphQL `variableUpsert(projectId, environmentId, serviceId, name, value)`, bearer; object per name; deployment status for a barrier | Y (GraphQL requests; a deploy barrier is not expressible) | P1 | **yes** (recipe [`railway.variable`](recipes.md#railwayvariable): the PR environment's id is a param; Sponson does not wait for the redeploy a write triggers) |
| Fly.io | Per-PR app (the usual pattern is one app per PR) plus its secrets | Machines API `api.machines.dev/v1/apps/{app}/secrets` (secret writes return a version, changed 2025) and GraphQL `setSecrets`; bearer; object; machines must be updated to see new secrets | Y (the app through the Machines API; secrets through GraphQL requests, presence only: values are never readable) | P1 | **yes** (recipe [`fly_machines.app`](recipes.md#fly_machinesapp), recipe [`fly.secret`](recipes.md#flysecret): secrets before the PR's deploy; a later change needs `fly secrets deploy`) |
| Heroku | Review app per PR; config vars on it | REST `POST /review-apps`, `PATCH /apps/{app}/config-vars`, bearer; **map** merge, `null` deletes; review-app creation async | Y (config vars); P (review app) | P2 | **yes** (recipe [`heroku.config_var`](recipes.md#herokuconfig_var): config vars on an existing app (a review app by name); creating the review app (async, by Heroku's automatic review apps) is not managed) |
| AWS Amplify | Branch (per-PR previews built in); env vars per branch | `UpdateBranch` `environmentVariables`, SigV4; **map** full replace | Y (`aws_sigv4`, the map sent whole) | P2 | **yes** (recipe [`amplify.branch`](recipes.md#amplifybranch), recipe [`amplify.branch_variable`](recipes.md#amplifybranch_variable): variables before the branch's first build (no rebuild)) |
| Google Cloud Run | Tagged revision per PR (`--tag pr-42`), env vars on it | Admin API v2 / `gcloud run deploy --tag --update-env-vars`, Google OAuth; revision = whole service spec | P (the tag: `recipe:cloud_run.traffic_tag`, read-modify-write of `traffic` with the etag; the revision and its env vars are the deploy's) | P2 | no (the tag only: recipe cloud_run.traffic_tag; the revision's env vars are set by the deploy) |
| Azure Static Web Apps | Preview environment per PR (built in); app settings | ARM `PUT .../staticSites/{s}/builds/{env}/config/appsettings`, AAD token; **map** full replace | Y (`command` token from `az`; read with a POST list action, the map written whole) | P2 | **yes** (recipe [`azure_swa.build_app_setting`](recipes.md#azure_swabuild_app_setting): after the PR's first deploy (the environment exists only then)) |
| DigitalOcean App Platform | No native PR previews; app per PR via its GitHub action; envs in the app spec | REST `PUT /v2/apps/{id}` whole spec, bearer; **list** in spec | P (whole-spec writes) | P2 | **yes** (`digitalocean.app`: an app per scope from a whole spec, waited for until deployed (in place of the app DigitalOcean's GitHub action makes); secret values are not compared) |

### Databases with branching or per-PR instances

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Neon | Copy-on-write branch per PR, connection string out | REST `/api/v2/projects/{p}/branches`, bearer; object; async operations, `423` while busy | P (async ops) | P0 | **yes** (`neon.branch`) |
| Supabase | Preview branch per PR (a separate project with its own ref, keys and URL) | Management API `POST /v1/projects/{ref}/branches`, `GET`/`DELETE /v1/branches/{ref}`, bearer PAT; object; async provisioning (`ACTIVE_HEALTHY`), migrations run by Supabase | P (async, outputs from a second project) | P0 | **yes** (`supabase.branch`) |
| PlanetScale | Branch per PR; password (credential) per branch; deploy request on merge | REST `POST /v1/organizations/{o}/databases/{d}/branches`, `.../branches/{b}/passwords`; service token header; object; branch `ready` async; password plaintext returned once | P (async, once-only secret) | P1 | **yes** (`planetscale.branch`, `planetscale.password`: deploy requests on merge are not managed) |
| Turso | Database branched from a parent (`seed: {type: database}`), token per DB | Platform API `POST /v1/organizations/{o}/databases`, `.../databases/{d}/auth/tokens`; bearer; object | Y | P1 | **yes** (recipe [`turso.database_branch`](recipes.md#tursodatabase_branch)) |
| Xata | Copy-on-write Postgres branch | REST `POST https://api.xata.tech/organizations/{o}/projects/{p}/branches` `{mode: inherit, parentID, name}`, `DELETE .../branches/{id}`; bearer API key; object; branch comes up asynchronously (`status.statusType`); credentials from `GET .../branches/{id}/credentials` (OpenAPI at api.xata.tech/openapi.json; re-platformed onto Postgres in 2025) | P (async readiness, credentials in a second request) | P2 | **yes** (`xata.branch`: waits until the branch is healthy; only its existence is compared for drift) |
| MongoDB Atlas | No branching; per-PR database user and database name on a shared cluster (cluster per PR is slow and costly) | Admin API v2 `POST /api/atlas/v2/groups/{g}/databaseUsers`, digest or service-account OAuth; object | Y (`digest` auth and `media_type`; tested against a Digest sim in scenarios/adapters/http-digest.yaml) | P2 | **yes** (recipe [`mongodb_atlas.database_user`](recipes.md#mongodb_atlasdatabase_user): the password is an input (`{ secret }`, or a sensitive output of another line), sent on create only and never compared) |
| CockroachDB Cloud | No branching; per-PR database is SQL (`CREATE DATABASE`), a cluster per PR is infra | Cloud API `POST /api/v1/clusters/{c}/databases` (`{ name }`), `DELETE …/databases/{name}`, listed with `pagination.page`; SQL users at `…/sql-users`; bearer; object | Y (find by name in the list; no SQL needed) | P2 | **yes** (recipe [`cockroachdb.database`](recipes.md#cockroachdbdatabase): the Cloud API creates databases and SQL users (`cockroachdb.sql_user`, which gets the SQL `admin` role by default); grants narrower than that still need SQL) |
| Prisma Postgres | Database per PR in a project, connection string per database | Management API `POST /v1/projects/{id}/databases`, `POST /v1/databases/{id}/connections`; service token; object; connection string returned on create | Y | P2 | **yes** (recipe [`prisma.database`](recipes.md#prismadatabase), recipe [`prisma.database_copy`](recipes.md#prismadatabase_copy): connection strings are once-only outputs (in the create answer only); Sponson does not wait for status ready) |

### Auth callback and redirect allow-lists

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Clerk | Preview URL on the instance's redirect allow-list | Backend API `POST /v1/redirect_urls`, `DELETE /v1/redirect_urls/{id}`, bearer secret key; object | Y | P0 | **yes** (`clerk.redirect_allow`) |
| Auth0 | Preview URL in an application's `callbacks`, `allowed_logout_urls`, `web_origins`, `allowed_origins` | Management API `PATCH /api/v2/clients/{id}`, bearer from client-credentials; **list** (each array replaced whole); no ETag | Y (list mode, token exchange) | P0 | **yes** (recipe [`auth0.callback_url`](recipes.md#auth0callback_url), recipe [`auth0.logout_url`](recipes.md#auth0logout_url), recipe [`auth0.web_origin`](recipes.md#auth0web_origin), recipe [`auth0.allowed_origin`](recipes.md#auth0allowed_origin)) |
| Supabase Auth | Preview URL in "Additional Redirect URLs" | Management API `PATCH /v1/projects/{ref}/config/auth` with `uri_allow_list`, bearer; **list** encoded as one comma-separated string; send only that field; no precondition, so the op locks the list (`lockOn`) | Y (list mode over a delimited string) | P0 | **yes** (`supabase.auth_redirect`) |
| Firebase Auth | Preview domain in `authorizedDomains` | Identity Toolkit `PATCH admin/v2/projects/{p}/config?updateMask=authorizedDomains`, Google OAuth; **list** full replace | Y (list mode, Google token) | P1 | **yes** (recipe [`firebase.authorized_domain`](recipes.md#firebaseauthorized_domain)) |
| WorkOS | Redirect URI for AuthKit | `POST /user_management/redirect_uris`, list via `GET` (cursor `list_metadata.after`), `DELETE /user_management/redirect_uris/{id}`; bearer; object | Y | P1 | **yes** (recipe [`workos.redirect_uri`](recipes.md#workosredirect_uri)) |
| Stytch | Redirect URL per environment | PWA `POST /pwa/v3/projects/{p}/environments/{e}/redirect_urls`, `GET …/redirect_urls/all`, get/update/delete by `?url=`; Basic workspace key; object keyed by its URL | Y | P2 | **yes** (recipe [`stytch.redirect_url`](recipes.md#stytchredirect_url)) |
| Okta | `redirect_uris` on an OIDC app; trusted origin for CORS | `PUT /api/v1/apps/{id}` (**list**, whole app object), `POST /api/v1/trustedOrigins` (object); `SSWS` token or OAuth | Y (list mode; trusted origins object) | P2 | **yes** (recipe [`okta.redirect_uri`](recipes.md#oktaredirect_uri), recipe [`okta.post_logout_redirect_uri`](recipes.md#oktapost_logout_redirect_uri), recipe [`okta.trusted_origin`](recipes.md#oktatrusted_origin)) |
| Kinde | Callback and logout URLs on an application | Management API `GET`/`PUT /api/v1/applications/{id}/auth_redirect_urls` and `…/auth_logout_urls` (read `{ redirect_urls }` / `{ logout_urls }`, replace with `{ urls }`; `POST` adds, `DELETE ?urls=` removes); M2M client-credentials token (audience `https://<business>.kinde.com/api`) | Y (list mode, token exchange; written under another name than read) | P2 | **yes** (recipe [`kinde.callback_url`](recipes.md#kindecallback_url), recipe [`kinde.logout_url`](recipes.md#kindelogout_url)) |
| Google OAuth clients | Preview URL in a web client's authorized redirect URIs | **No public API** for standard OAuth web clients (Console only); only IAM workforce OAuth clients and IAP are programmable | N | P1 | manual step (`manual.step`) |

### Feature flags and targeting

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| LaunchDarkly | Flag on for a preview: target a context key or add a rule on `url`, in a per-PR or shared preview environment | `PATCH /api/v2/flags/{proj}/{flag}` with semantic patch (`Content-Type: application/json; domain-model=launchdarkly.semanticpatch`, instructions `addTargets`/`removeTargets`/`addRule`), API token; instructions are idempotent per target; approvals may gate production | P (instruction-based diff, approvals) | P0 | **yes** (`launchdarkly.flag_target`: context-key targets; `url` rules not yet) |
| PostHog | Release condition matching the preview host on a flag | `PATCH /api/projects/{id}/feature_flags/{id}` `filters.groups`, personal API key bearer; **list** in `filters` | Y (list mode) | P1 | **yes** (recipe [`posthog.release_condition`](recipes.md#posthogrelease_condition): condition on a person or group property; needs the merging `filters` PATCH of current PostHog (PH5)) |
| Statsig | Gate rule for the preview (condition `url` or `environment_tier`) | Console API `POST /console/v1/gates/{id}/rule` (answers the whole gate), `GET .../rules`, `PATCH`/`DELETE .../rules/{ruleID}`, `STATSIG-API-KEY` header; object per rule; reviews may gate changes | Y | P1 | **yes** (recipe [`statsig.gate_rule`](recipes.md#statsiggate_rule): gates requiring reviews: write behaviour undocumented (SG8)) |
| GrowthBook | Force rule in a per-environment feature | REST v2 `POST /api/v2/features/{id}` replacing the top-level `rules` (each rule names its environments; v1's `environments.{env}.rules` is deprecated), bearer; **list** | Y (list mode) | P2 | **yes** (recipe [`growthbook.force_rule`](recipes.md#growthbookforce_rule): v2 API (rules with per-rule environments); approval-gated features refuse the write) |
| Unleash | Strategy (with constraints) on a flag in an environment | Admin API `POST /api/admin/projects/{p}/features/{f}/environments/{env}/strategies`, `DELETE .../{id}`; token header; object | Y | P2 | **yes** (recipe [`unleash.flag_strategy`](recipes.md#unleashflag_strategy): deleting the last strategy turns the flag off in that environment (UN8)) |
| Flagsmith | Segment override or a per-PR environment | `POST /api/v1/environments/`, feature-state endpoints; `Authorization: Api-Key <key>` (organisation key) or `Token <key>`; object | Y (`Authorization: Api-Key <key>` through the header `prefix`) | P2 | **yes** (recipe [`flagsmith.environment`](recipes.md#flagsmithenvironment): a per-PR environment (its client-side key is an output); identity and segment overrides are not recipes: Edge identities are addressed by UUID, and a segment override is two objects created in order) |
| ConfigCat | Targeting rule on a setting in an environment | Management API v2 `PUT /v2/environments/{e}/settings/{s}/value` (replaces `defaultValue`, `targetingRules`, `percentageEvaluationAttribute`; `PATCH` is JSON Patch), Basic; **list** of rules | Y (list mode, PUT with the other fields sent back) | P2 | **yes** (recipe [`configcat.targeting_rule`](recipes.md#configcattargeting_rule): boolean flags; products requiring a change reason or approval refuse the write) |
| Split (Harness FME) | Targeting rule / individual target in an environment | Admin API `PUT /internal/api/v2/splits/ws/{ws}/{split}/environments/{env}` (full definition; `PATCH` is JSON Patch), bearer; **list**; same host and paths after the Harness migration | Y | P2 | **yes** (recipe [`split.targeting_rule`](recipes.md#splittargeting_rule): targeting rule (not individual targets); projects requiring title/comment refuse the write) |

### Webhooks registered per environment

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Stripe | Test-mode webhook endpoint pointing at the preview URL; its signing secret into the app's env | `POST /v1/webhook_endpoints` (form-encoded), `DELETE /v1/webhook_endpoints/{id}`; bearer; object; `Idempotency-Key`; **`secret` returned only on create** | Y (the secret is a `once` output, flowing into an env line in the same run; ADR 0018) | P0 | **yes** (recipe [`stripe.webhook_endpoint`](recipes.md#stripewebhook_endpoint)) |
| GitHub | Repository webhook to the preview URL | `POST /repos/{o}/{r}/hooks`, `DELETE .../hooks/{id}`; bearer; object; secret write-only (caller supplies it) | Y | P2 | **yes** (recipe [`github.repo_webhook`](recipes.md#githubrepo_webhook)) |
| Svix (as a sender) | Endpoint per environment on an application | `POST /api/v1/app/{app}/endpoint` with caller-chosen `uid`; bearer; object, idempotent by `uid`; secret readable via `GET .../secret` | Y | P2 | **yes** (recipe [`svix.endpoint`](recipes.md#svixendpoint)) |
| Clerk webhooks | Preview URL as a webhook endpoint | Clerk's Backend API only creates/deletes the Svix app and a dashboard link; **no endpoint API** through Clerk | N | P1 | manual step (`manual.step`) |

### Email: sending domains, webhooks, test inboxes

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Resend | Restricted API key or webhook per environment (domains are long-lived; test addresses like `delivered@resend.dev` need no API) | `POST /api-keys` (token returned once), `POST /webhooks`; bearer; object | Y | P2 | **yes** (recipe [`resend.api_key`](recipes.md#resendapi_key), recipe [`resend.webhook`](recipes.md#resendwebhook)) |
| Postmark | Server per environment, webhook per server | Account API `POST /servers` (`X-Postmark-Account-Token`), Server API `POST /webhooks` (`X-Postmark-Server-Token`); object | Y (the webhook line takes the server's token with `credential: { from: <server line>.server_token }`) | P2 | **yes** (recipe [`postmark.server`](recipes.md#postmarkserver), recipe [`postmark_server.webhook`](recipes.md#postmark_serverwebhook): chained in one plan by a line credential (ADR 0017, Line credentials): the webhook line says `destroy: keep`, since its webhooks go with the server; scenarios/adapters/http-line-credential.yaml) |
| SendGrid | Event webhook or inbound-parse host per environment | `POST /v3/user/webhooks/event/settings`, `POST /v3/user/webhooks/parse/settings`; bearer; object | Y | P2 | **yes** (recipe [`sendgrid.event_webhook`](recipes.md#sendgridevent_webhook), recipe [`sendgrid.parse_setting`](recipes.md#sendgridparse_setting)) |

### Observability per release

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Sentry | Release for the commit, deploy record for the environment; finalize | `POST /api/0/organizations/{o}/releases/`, `POST .../releases/{v}/deploys/`; bearer; object; environments appear on first event | Y (destroy = leave; history) | P1 | **yes** (recipe [`sentry.release`](recipes.md#sentryrelease), recipe [`sentry.deploy`](recipes.md#sentrydeploy)) |
| Datadog | Deployment marker / synthetic test against the preview URL | `datadog-ci deployment mark`; `POST /api/v1/synthetics/tests/api`; `DD-API-KEY` + `DD-APPLICATION-KEY` headers; object | Y for synthetic tests (`headers` auth; delete by `POST /synthetics/tests/delete` naming the test in its body); N for deployment events (listed by POST over a time window, never deleted) | P2 | **yes** (recipe [`datadog.synthetic_api_test`](recipes.md#datadogsynthetic_api_test): covered by a Synthetic API test against the preview URL; deployment markers stay out of reach (a later run could not find the event it made)) |
| Honeycomb | Marker per deploy in the environment's dataset | `POST /1/markers/{dataset}`, `X-Honeycomb-Team` header; object | Y | P2 | **yes** (recipe [`honeycomb.marker`](recipes.md#honeycombmarker)) |

### DNS and preview domains

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Cloudflare DNS | CNAME `pr-42.preview.example.com` → the preview | `POST /zones/{z}/dns_records`, `DELETE .../{id}`; bearer; object; no idempotency key, find by name+type | Y | P1 | **yes** (recipe [`cloudflare.dns_cname`](recipes.md#cloudflaredns_cname)) |
| Vercel domains | Branch-bound project domain (`gitBranch`) for a stable preview hostname | `POST /v10/projects/{id}/domains` `{name, gitBranch}`, `DELETE`; bearer; object | Y (or a `vercel` op) | P1 | **yes** (recipe [`vercel.project_domain`](recipes.md#vercelproject_domain)) |

### CORS and allowed origins

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Supabase | (none) The Data API and Storage have no per-origin allow-list; Edge Functions set CORS in code | n/a, not counted | n/a | n/a | n/a |
| Firebase Storage (GCS bucket) | Preview origin in the bucket's `cors` | GCS JSON API `PATCH /storage/v1/b/{bucket}?fields=cors`, Google OAuth; **list** full replace; `ifMetagenerationMatch` precondition available | Y (list mode; the precondition is not sent, Sponson's writers are serialised by the parent lock) | P2 | **yes** (recipe [`gcs.bucket_cors`](recipes.md#gcsbucket_cors)) |
| S3 / R2 | Preview origin in the bucket CORS rules | S3 `PutBucketCors` (SigV4, full replace); R2 `PUT /accounts/{a}/r2/buckets/{b}/cors` (bearer, full replace); **list** | Y (S3 API with `aws_sigv4` and `encoding: xml`; R2 through its S3-compatible endpoint) | P2 | **yes** (recipe [`s3.bucket_cors`](recipes.md#s3bucket_cors)) |

### Queues, caches, background jobs

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Upstash Redis | Database per PR, REST URL and token out | Developer API `POST /v2/redis/database`, `DELETE /v2/redis/database/{id}`; Basic (email:key); object | Y | P2 | **yes** (recipe [`upstash.redis_database`](recipes.md#upstashredis_database)) |
| Upstash QStash | Schedule that calls the preview URL | `POST /v2/schedules/{destination}` with `Upstash-Schedule-Id` (idempotent upsert), `DELETE /v2/schedules/{id}`; bearer; object | Y | P2 | **yes** (recipe [`qstash.schedule`](recipes.md#qstashschedule)) |
| Inngest | Sync the preview deployment into its branch environment | `PUT {preview_url}/api/inngest` (the app registers itself) or the Vercel integration; branch env selected by `INNGEST_ENV` var | Y (one call, no destroy; archive via dashboard) | P1 | **yes** (recipe [`inngest.sync`](recipes.md#inngestsync): an `http.action` (ADR 0022): `PUT` to the deployment's serve endpoint once per deployment URL and revision, no Inngest credential; the app must set `INNGEST_ENV` (automatic on Vercel); nothing to undo (branch environments archive themselves); the beta REST v2 sync endpoint is not used (no way to target a branch environment)) |

### Search, payments test mode

| Provider | Side effect | API shape | Generic? | Pri | Now |
|---|---|---|---|---|---|
| Algolia | Index per environment, copied from a template index | `POST /1/indexes/{src}/operation` `{operation: copy, destination}`, `DELETE /1/indexes/{name}`; `X-Algolia-Application-Id` + `X-Algolia-API-Key`; async task to poll | P (async task) | P2 | **yes** (`algolia.index`: copies records, settings, synonyms and rules (or a scope of them) and waits for the copy task; only the index's existence is compared for drift) |
| Stripe test-mode objects | Products / prices / coupons the preview's code expects | `POST /v1/products`, `/v1/prices` (form-encoded, `lookup_key` as identity, `Idempotency-Key`); prices cannot be deleted, only `active=false` | Y (destroy = archive) | P2 | **yes** (recipe [`stripe.product`](recipes.md#stripeproduct), recipe [`stripe.price`](recipes.md#stripeprice), recipe [`stripe.coupon`](recipes.md#stripecoupon)) |
| Stripe sandboxes | A sandbox per PR | No public API for account sandboxes; anonymous "claimable" sandboxes are private preview | N | P2 | manual step (`manual.step`) |
<!-- generated:coverage-matrix:end -->

### Secret managers (read side: secret sources, not side effects)

Secret sources resolve `{ secret }` references; they create nothing, so they are counted separately. The built-in ones
are [listed in docs/plan-format.md](plan-format.md#secret-schemes).

<!-- generated:coverage-secrets:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
| Provider | Read API | Pri | Now |
|---|---|---|---|
| Doppler | CLI / REST, service token | P1 | **yes** (`doppler://`) |
| 1Password (CLI, service accounts) | `op read` | P1 | **yes** (`op://`) |
| AWS Secrets Manager | CLI, SigV4 | P1 | **yes** (`aws-sm://`) |
| Google Secret Manager | CLI, Google OAuth | P2 | **yes** (`gcp-sm://`) |
| HashiCorp Vault | KV v2 `GET /v1/{mount}/data/{path}`, `X-Vault-Token` | P1 | no ([#17](https://github.com/MishaBear94/Sponson/issues/17)) |
| Infisical | CLI or `GET /api/v3/secrets/raw/{name}`, machine identity | P1 | no ([#18](https://github.com/MishaBear94/Sponson/issues/18)) |
| Azure Key Vault | `GET {vault}/secrets/{name}?api-version=7.4`, AAD token, or `az keyvault secret show` | P2 | no |
| 1Password Connect | `GET /v1/vaults/{v}/items/{i}`, bearer | P2 | no |
| Bitwarden Secrets Manager | `bws secret get`, `BWS_ACCESS_TOKEN` | P2 | no |
<!-- generated:coverage-secrets:end -->

The write side (a per-PR Doppler branch config, `POST /v3/configs`) is a side effect; it is P2 and not counted above.

## Current coverage

Every number below is computed from [coverage.yaml](coverage.yaml) by `pnpm docs:gen`; a row counts as covered when
a registered op or a shipped [recipe](recipes.md) manages it.

<!-- generated:coverage-numbers:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
Counted over the 56 side-effect rows of the matrix (rows marked `n/a` have nothing to manage). Weights: P0 = 3, P1 = 2, P2 = 1 (9 P0, 16 P1, 31 P2; total weight 90).

| Measure | Covered | Coverage |
|---|---|---|
| Rows | 52 of 56 | **92.9%** |
| Weighted by priority | 84 of 90 | **93.3%** |
| P0 rows only | 9 of 9 | 100.0% |
| Rows an API reaches (all but `manual`) | 52 of 53 | 98.1% |
| Weighted, rows an API reaches | 84 of 85 | 98.8% |
| Rows, including manual steps (`manual.step`) | 55 of 56 | 98.2% |
| Weighted, including manual steps | 89 of 90 | 98.9% |
| Secret sources (separate) | 4 of 9 vendors; weighted 7 of 14 | 44.4%; 50.0% |

Covered: Vercel (`vercel.env`, `vercel.deploy`); Netlify (`netlify.env`); Cloudflare Pages / Workers (`cloudflare.pages_env`); Render (recipe [`render.env_var`](recipes.md#renderenv_var)); Railway (recipe [`railway.variable`](recipes.md#railwayvariable)); Fly.io (recipe [`fly_machines.app`](recipes.md#fly_machinesapp), recipe [`fly.secret`](recipes.md#flysecret)); Heroku (recipe [`heroku.config_var`](recipes.md#herokuconfig_var)); AWS Amplify (recipe [`amplify.branch`](recipes.md#amplifybranch), recipe [`amplify.branch_variable`](recipes.md#amplifybranch_variable)); Azure Static Web Apps (recipe [`azure_swa.build_app_setting`](recipes.md#azure_swabuild_app_setting)); DigitalOcean App Platform (`digitalocean.app`); Neon (`neon.branch`); Supabase (`supabase.branch`); PlanetScale (`planetscale.branch`, `planetscale.password`); Turso (recipe [`turso.database_branch`](recipes.md#tursodatabase_branch)); Xata (`xata.branch`); MongoDB Atlas (recipe [`mongodb_atlas.database_user`](recipes.md#mongodb_atlasdatabase_user)); CockroachDB Cloud (recipe [`cockroachdb.database`](recipes.md#cockroachdbdatabase)); Prisma Postgres (recipe [`prisma.database`](recipes.md#prismadatabase), recipe [`prisma.database_copy`](recipes.md#prismadatabase_copy)); Clerk (`clerk.redirect_allow`); Auth0 (recipe [`auth0.callback_url`](recipes.md#auth0callback_url), recipe [`auth0.logout_url`](recipes.md#auth0logout_url), recipe [`auth0.web_origin`](recipes.md#auth0web_origin), recipe [`auth0.allowed_origin`](recipes.md#auth0allowed_origin)); Supabase Auth (`supabase.auth_redirect`); Firebase Auth (recipe [`firebase.authorized_domain`](recipes.md#firebaseauthorized_domain)); WorkOS (recipe [`workos.redirect_uri`](recipes.md#workosredirect_uri)); Stytch (recipe [`stytch.redirect_url`](recipes.md#stytchredirect_url)); Okta (recipe [`okta.redirect_uri`](recipes.md#oktaredirect_uri), recipe [`okta.post_logout_redirect_uri`](recipes.md#oktapost_logout_redirect_uri), recipe [`okta.trusted_origin`](recipes.md#oktatrusted_origin)); Kinde (recipe [`kinde.callback_url`](recipes.md#kindecallback_url), recipe [`kinde.logout_url`](recipes.md#kindelogout_url)); LaunchDarkly (`launchdarkly.flag_target`); PostHog (recipe [`posthog.release_condition`](recipes.md#posthogrelease_condition)); Statsig (recipe [`statsig.gate_rule`](recipes.md#statsiggate_rule)); GrowthBook (recipe [`growthbook.force_rule`](recipes.md#growthbookforce_rule)); Unleash (recipe [`unleash.flag_strategy`](recipes.md#unleashflag_strategy)); Flagsmith (recipe [`flagsmith.environment`](recipes.md#flagsmithenvironment)); ConfigCat (recipe [`configcat.targeting_rule`](recipes.md#configcattargeting_rule)); Split (Harness FME) (recipe [`split.targeting_rule`](recipes.md#splittargeting_rule)); Stripe (recipe [`stripe.webhook_endpoint`](recipes.md#stripewebhook_endpoint)); GitHub (recipe [`github.repo_webhook`](recipes.md#githubrepo_webhook)); Svix (as a sender) (recipe [`svix.endpoint`](recipes.md#svixendpoint)); Resend (recipe [`resend.api_key`](recipes.md#resendapi_key), recipe [`resend.webhook`](recipes.md#resendwebhook)); Postmark (recipe [`postmark.server`](recipes.md#postmarkserver), recipe [`postmark_server.webhook`](recipes.md#postmark_serverwebhook)); SendGrid (recipe [`sendgrid.event_webhook`](recipes.md#sendgridevent_webhook), recipe [`sendgrid.parse_setting`](recipes.md#sendgridparse_setting)); Sentry (recipe [`sentry.release`](recipes.md#sentryrelease), recipe [`sentry.deploy`](recipes.md#sentrydeploy)); Datadog (recipe [`datadog.synthetic_api_test`](recipes.md#datadogsynthetic_api_test)); Honeycomb (recipe [`honeycomb.marker`](recipes.md#honeycombmarker)); Cloudflare DNS (recipe [`cloudflare.dns_cname`](recipes.md#cloudflaredns_cname)); Vercel domains (recipe [`vercel.project_domain`](recipes.md#vercelproject_domain)); Firebase Storage (GCS bucket) (recipe [`gcs.bucket_cors`](recipes.md#gcsbucket_cors)); S3 / R2 (recipe [`s3.bucket_cors`](recipes.md#s3bucket_cors)); Upstash Redis (recipe [`upstash.redis_database`](recipes.md#upstashredis_database)); Upstash QStash (recipe [`qstash.schedule`](recipes.md#qstashschedule)); Inngest (recipe [`inngest.sync`](recipes.md#inngestsync)); Algolia (`algolia.index`); Stripe test-mode objects (recipe [`stripe.product`](recipes.md#stripeproduct), recipe [`stripe.price`](recipes.md#stripeprice), recipe [`stripe.coupon`](recipes.md#stripecoupon)).

Automated coverage counts only rows an op manages without a person. Rows no API reaches (`manual`, or a `manual.step` line that records the step a person does; weight 5): Google OAuth clients (no public API for standard OAuth web clients); Clerk webhooks (Clerk's API manages the Svix app, not its endpoints); Stripe sandboxes (no public API for account sandboxes). They cap coverage at 53 rows, 85 of 90 weighted (94.4%).

Recipe candidates, rows the generic adapter can express fully (`Y`) that nothing covers yet: 0 ().
<!-- generated:coverage-numbers:end -->

## Strategy

Two kinds of adapter close the gap.

**First-class adapters** (TypeScript, one sim routes file, scenarios) for rows whose lifecycle is more than
create/read/delete: asynchronous provisioning (branches, Supabase previews), an external event barrier (Netlify and
Railway deploys, like `vercel.env`), outputs that exist only once behind a multi-step lifecycle (PlanetScale
password; a once-only output of a plain object, such as Stripe's webhook secret, is a recipe), instruction-based diffs (LaunchDarkly), GraphQL, or non-bearer signing (SigV4).

**The generic HTTP adapter and its recipes** (`adapter: http`, [ADR 0017](adr/0017-generic-http-adapter.md) and
[ADR 0020](adr/0020-recipes.md)) for the long tail where each item is a URL, a rule or a record and the lifecycle is
plain CRUD. A row counts as covered once a [recipe](recipes.md) for it ships: a verified, tested, documented spec a
plan line names in one line, not a request template every team writes. The rows marked **Y** that no recipe covers
yet are listed under [Current coverage](#current-coverage).

### What `adapter: http` must support to cover the P0/P1 rows

1. **Provider block with credentials by reference**: base URL, auth as bearer, custom header(s) (`STATSIG-API-KEY`,
   Algolia's two headers), Basic, a token from an OAuth2 client-credentials exchange (Auth0, Kinde, Okta), or a token
   from a command (`gcloud auth print-access-token` for Firebase/GCS), SigV4 or Digest. Credentials are environment
   variable names, never values. **Done** ([ADR 0017](adr/0017-generic-http-adapter.md) and its amendment), with
   XML bodies and GraphQL requests.
2. **Two write models**: *object* (create, read by id, update, delete) and *list-on-parent* (read the parent, find the
   item in an array, write the parent back). List mode must handle an array at a JSON path, a **delimited string**
   (Supabase `uri_allow_list`), and a **keyed map** with merge-patch delete-by-null (Cloudflare Pages `env_vars`,
   Heroku config vars).
3. **Request templates** for read, create, update and delete: method, path, query (`updateMask`, `site_id`), body,
   with `${ctx.*}`, params, `{ from }` and `{ secret }` substitution; body encodings JSON, form-encoded (Stripe),
   JSON Patch, merge-patch, and a custom `Content-Type` (LaunchDarkly semantic patch).
4. **Response mapping by JSON path**: the id, the fields compared for drift (hashed in the same canonical form as
   `ResourceRecord.hash`), and named outputs, each markable `sensitive`.
5. **Identity and lost-response recovery**: a resource key template, and a *find* request (list + match predicate on a
   field such as `url` or `name`) so a create whose response was lost is found and claimed instead of duplicated;
   `Idempotency-Key` from the ledger key where the provider honours it (Stripe), client-chosen ids where it takes them
   (Svix `uid`, QStash `Upstash-Schedule-Id`).
6. **Preconditions and serialization for list mode**: send the read version back when the provider has one (ETag /
   `If-Match`, GCS `ifMetagenerationMatch`), re-read after write to confirm the item landed, and declare the parent
   object (`lockOn`) so the engine's per-object lock serialises Sponson's writers
   ([ADR 0019](adr/0019-parent-object-locks.md)). Without this, two PRs editing one Auth0 application lose writes.
7. **Status classification overrides**: which statuses mean "already exists" (re-read and claim), "gone" (success on
   delete), "busy" (retry), on top of `packages/adapters/src/http.ts`'s defaults; plus pagination styles (cursor,
   `next` link, page number).
8. **Destroy modes**: `delete`, `update` to an archived state (Stripe prices `active=false`), remove-from-list, or
   `leave` (Sentry releases are history). `delete` and `leave` exist (`destroy: keep`); a recipe op sets the default
   (`destroy: keep`, or `never` when the provider cannot delete; [ADR 0020](adr/0020-recipes.md), amendment).
9. **Simple polling**: after create, poll a URL until a JSON path equals a value, with a timeout (Algolia tasks, Turso
   or Prisma readiness). Long multi-step lifecycles stay first-class.
10. **Scope listing** for drift and `sponson init`: a list request plus a filter (name prefix, URL host) so unmanaged
    items are reported and adoptable.
11. **Once-only outputs**: an output that is only in the create response must be declared as such, so the engine
    feeds it to dependent lines in the same run and refuses a later run that needs it (instead of reading an empty
    value). Needed for Stripe webhook secrets, API keys and DB passwords even in first-class adapters. The engine
    side exists: `OutputSpec.once` ([ADR 0018](adr/0018-once-only-outputs.md)), first used by `planetscale.password`;
    `http.resource` declares one as `{ path, sensitive: true, once: true }` ([ADR 0020](adr/0020-recipes.md), amendment;
    `stripe.webhook_endpoint`). Archiving destroys (item 8) are `delete: { method: POST, body: … }` (`stripe.price`).
12. **Sim support**: a generic sim route set driven by the same declaration, so every `http` line gets the chaos and
    drift scenarios the built-in adapters get.

### The next eight first-class adapters

Ranked by weighted rows covered, then by how much they need more than `adapter: http`.

| # | Adapter | Rows (Pri) | Why first-class |
|---|---|---|---|
| 1 | `supabase` (done: `supabase.branch`, `supabase.auth_redirect`) | branch (P0), auth redirect URLs (P0) | Two P0 rows with one credential; preview branches are separate projects provisioned asynchronously, and their URL and keys are outputs the env line needs. |
| 2 | `netlify` (done: `netlify.env`) | env per deploy context (P0) | Second most common preview host; needs the same deploy barrier and redeploy-after-write logic as `vercel.env`. Deploy Previews cannot be rebuilt through Netlify's API, so a `deploy-preview` line reports a stale deploy instead of rebuilding it. |
| 3 | `launchdarkly` | flag targeting (P0) | **Shipped** as `launchdarkly.flag_target` ([#15](https://github.com/MishaBear94/Sponson/issues/15)); semantic-patch instructions and approval workflows do not fit a request template. Rules on `url` are not covered yet. |
| 4 | `stripe` | test-mode webhook endpoint (P0), test objects (P2) | Its signing secret exists only in the create response and must flow into the app's env in the same run; form encoding and `Idempotency-Key`. |
| 5 | `auth0` | callbacks / logout URLs / web origins (P0) | Four arrays on one shared application with no precondition: the reference case for the list-mode lock, worth owning before generalising ([#16](https://github.com/MishaBear94/Sponson/issues/16)). |
| 6 | `planetscale` | branch + password (P1) | **Done** (`planetscale.branch`, `planetscale.password`): asynchronous branch readiness, and the password as the first once-only output ([ADR 0018](adr/0018-once-only-outputs.md)). |
| 7 | `railway` | PR-environment variables (P1) | GraphQL, environment-id lookup, and a deploy barrier; Railway creates the PR environment, Sponson fills it. |
| 8 | `cloudflare` | Pages/Workers env (P1), DNS record (P1), R2 CORS (P2) | One token, three rows; Workers secrets and preview versions need script-level handling a template cannot express. |

With these eight plus recipes for the **Y** rows, the remaining rows are
Fly.io, Amplify, Cloud Run, Azure Static Web Apps, DigitalOcean, Xata, Algolia (all P1/P2 with partial generic fit or
SigV4 needs; MongoDB Atlas and CockroachDB turned out to be recipes) and the three rows with no API.

## Sources

The Netlify, Cloudflare Pages, Fly.io, Supabase Auth, Turso, Prisma Postgres, Clerk webhook, Firebase, WorkOS, Stytch, Kinde, Google OAuth, Statsig and Stripe sandbox facts were re-checked against these pages on 2026-10-11. The rest come from the providers' docs as the author knew them and were not re-fetched for this document; treat them like **(unverified)** until an adapter's verification table ([docs/api-verification.md](api-verification.md)) covers them.

- Vercel REST API: [vercel.com](https://vercel.com/docs/rest-api) (env, deployments, project domains)
- Netlify API (OpenAPI): [github.com](https://github.com/netlify/open-api/blob/master/swagger.yml); env vars: [docs.netlify.com](https://docs.netlify.com/build/environment-variables/get-started/)
- Cloudflare Pages project update: [developers.cloudflare.com](https://developers.cloudflare.com/api/operations/pages-project-update-project); DNS records: [developers.cloudflare.com](https://developers.cloudflare.com/api/resources/dns/subresources/records/); R2 CORS: [developers.cloudflare.com](https://developers.cloudflare.com/r2/buckets/cors/)
- Render API: [api-docs.render.com](https://api-docs.render.com/)
- Railway public API: [docs.railway.com](https://docs.railway.com/reference/public-api)
- Fly.io secrets: [fly.io](https://fly.io/docs/apps/secrets/); Machines API secrets change: [community.fly.io](https://community.fly.io/t/a-change-to-the-delete-secret-machine-api-format/25788)
- Heroku Platform API: [devcenter.heroku.com](https://devcenter.heroku.com/articles/platform-api-reference)
- AWS Amplify `UpdateBranch`: [docs.aws.amazon.com](https://docs.aws.amazon.com/amplify/latest/APIReference/API_UpdateBranch.html)
- Cloud Run revision tags: [cloud.google.com](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)
- Azure Static Web Apps app settings: [learn.microsoft.com](https://learn.microsoft.com/en-us/rest/api/appservice/static-sites)
- DigitalOcean App Platform: [docs.digitalocean.com](https://docs.digitalocean.com/reference/api/digitalocean/#tag/Apps)
- Neon API: [api-docs.neon.tech](https://api-docs.neon.tech/reference/getting-started-with-neon-api)
- Supabase Management API: [supabase.com](https://supabase.com/docs/reference/api/introduction); auth config: [supabase.com](https://supabase.com/docs/reference/api/v1-update-auth-service-config); branching: [supabase.com](https://supabase.com/docs/guides/deployment/branching)
- PlanetScale API: [planetscale.com](https://planetscale.com/docs/openapi.yaml) (OpenAPI document; checked call by call for the adapter on 2026-10-11, see [api-verification.md](api-verification.md#planetscale))
- Turso branching: [docs.turso.tech](https://docs.turso.tech/features/branching); create database: [docs.turso.tech](https://docs.turso.tech/api-reference/databases/create)
- Xata branching: [xata.io](https://xata.io/docs/core-concepts/branching)
- MongoDB Atlas Admin API: [mongodb.com](https://www.mongodb.com/docs/atlas/reference/api-resources-spec/v2/)
- CockroachDB Cloud API: [cockroachlabs.com](https://www.cockroachlabs.com/docs/cockroachcloud/cloud-api)
- Prisma Postgres Management API: [prisma.io](https://www.prisma.io/docs/postgres/introduction/management-api); connections: [prisma.io](https://www.prisma.io/docs/rest-api/endpoints/databases-connections/post-databases-by-database-id-connections)
- Clerk Backend API: [clerk.com](https://clerk.com/docs/reference/backend-api); Clerk's Svix operations: [pkg.go.dev](https://pkg.go.dev/github.com/clerk/clerk-sdk-go/v2/svixwebhook)
- Auth0 Management API, update a client: [auth0.com](https://auth0.com/docs/api/management/v2/clients/patch-clients-by-id)
- Firebase / Identity Platform `projects.updateConfig`: [cloud.google.com](https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig)
- WorkOS redirect URIs: [workos.com](https://workos.com/docs/reference/authkit/redirect-uri)
- Stytch PWA redirect URLs: [stytch.com](https://stytch.com/docs/api-reference/pwa/api/v3/redirect-urls/create-redirect-url)
- Okta Apps API: [developer.okta.com](https://developer.okta.com/docs/api/openapi/okta-management/management/tag/Application/); Trusted Origins: [developer.okta.com](https://developer.okta.com/docs/api/openapi/okta-management/management/tag/TrustedOrigin/)
- Kinde callback URLs: [docs.kinde.com](https://docs.kinde.com/get-started/connect/callback-urls/); Management API: [docs.kinde.com](https://docs.kinde.com/kinde-apis/management/)
- Google OAuth clients (no redirect-URI API): [discuss.google.dev](https://discuss.google.dev/t/api-to-add-authorized-javascript-origin-and-redirect-uri-to-oauth2-client-id/167719); IAM OAuth clients: [cloud.google.com](https://cloud.google.com/iam/docs/workforce-manage-oauth-app)
- LaunchDarkly semantic patch: [launchdarkly.com](https://launchdarkly.com/docs/api/feature-flags/patch-feature-flag)
- PostHog feature flags API: [posthog.com](https://posthog.com/docs/api/feature-flags)
- Statsig Console API gate rules: [docs.statsig.com](https://docs.statsig.com/api-reference/gates/add-gate-rule)
- GrowthBook REST API: [docs.growthbook.io](https://docs.growthbook.io/api)
- Unleash Admin API: [docs.getunleash.io](https://docs.getunleash.io/reference/api/unleash)
- Flagsmith Admin API: [docs.flagsmith.com](https://docs.flagsmith.com/integrating-with-flagsmith/flagsmith-api-overview/admin-api)
- ConfigCat Public Management API: [configcat.com](https://configcat.com/docs/api/reference/configcat-public-management-api/)
- Split Admin API: [docs.split.io](https://docs.split.io/reference/introduction)
- Stripe webhook endpoints: [docs.stripe.com](https://docs.stripe.com/api/webhook_endpoints); idempotent requests: [docs.stripe.com](https://docs.stripe.com/api/idempotent_requests); sandboxes: [docs.stripe.com](https://docs.stripe.com/sandboxes)
- GitHub repository webhooks: [docs.github.com](https://docs.github.com/en/rest/repos/webhooks)
- Svix endpoints: [api.svix.com](https://api.svix.com/docs#tag/Endpoint)
- Resend API: [resend.com](https://resend.com/docs/api-reference/introduction)
- Postmark API: [postmarkapp.com](https://postmarkapp.com/developer/api/overview)
- SendGrid webhooks: [twilio.com](https://www.twilio.com/docs/sendgrid/api-reference/webhooks)
- Sentry releases: [docs.sentry.io](https://docs.sentry.io/api/releases/)
- Datadog synthetics API: [docs.datadoghq.com](https://docs.datadoghq.com/api/latest/synthetics/)
- Honeycomb markers: [docs.honeycomb.io](https://docs.honeycomb.io/api/tag/Markers)
- GCS bucket CORS: [cloud.google.com](https://cloud.google.com/storage/docs/using-cors)
- Amazon S3 `PutBucketCors`: [docs.aws.amazon.com](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html)
- Upstash Developer API: [upstash.com](https://upstash.com/docs/devops/developer-api/introduction); QStash schedules: [upstash.com](https://upstash.com/docs/qstash/api/schedules/create)
- Inngest branch environments: [inngest.com](https://www.inngest.com/docs/platform/environments)
- Algolia copy/move index: [algolia.com](https://www.algolia.com/doc/rest-api/search/#tag/Indices/operation/operationIndex)
- HashiCorp Vault KV v2: [developer.hashicorp.com](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2)
- Infisical API: [infisical.com](https://infisical.com/docs/api-reference/overview/introduction)
- Azure Key Vault get secret: [learn.microsoft.com](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret)
- 1Password Connect API: [developer.1password.com](https://developer.1password.com/docs/connect/api-reference/)
- Bitwarden Secrets Manager CLI: [bitwarden.com](https://bitwarden.com/help/secrets-manager-cli/)
- Doppler configs API: [docs.doppler.com](https://docs.doppler.com/reference/configs-create)
