# sponson

## 0.8.0

### Minor Changes

- d72de54: `sponson init --setup`: from a plan to the first real apply in one guided run on your own machine. For every
  provider the plan uses (and every value it references with `env://`), it shows the page where the token is created
  and the least it needs, reads the token from the environment or asks for it with hidden input (terminal only, never
  written to disk), and checks it with one read-only request: `ok`, `wrong_scope` (403, or a project the token does
  not reach) or `unauthorized` (401). Then, after a yes per secret (`--yes` for scripted use), it stores each checked
  token as a GitHub Actions secret of the origin repository with your own `gh` (the value on stdin only, never in argv
  or the child's environment), and writes `.github/workflows/sponson.yml` from the action README's preview job with the
  action pinned to the commit of the installed version's release tag, never overwriting an existing file. Works on a
  fresh repository (after writing the starter plan) and on an existing plan. `--json` reports each credential's status,
  the secrets stored and the workflow written, never a value.
  
  Adapters: `about.credentialUrl` and `about.credentialScope` say where a credential is created and what to pick (every
  built-in adapter declares them, checked against the providers' docs), and `ResourceAdapter.verifyCredential(actx)`
  checks one with a single read-only request (Vercel `GET /v9/projects/{id}` or `/v2/user`, Neon `GET /projects/{id}`,
  Clerk `GET /redirect_urls`, …). Recipes gain a `credential` block (`url`, `scope`, `source`, optional `verify`), and
  `verifyRecipeCredential` sends a recipe's check through the same client and authentication as its ops.
  docs/providers.md lists each provider's token page and scope.
- 051c526: The pull request comment is redesigned for the reviewer, and any CI or agent can post it.
  
  - **What the comment says.** A headline ("This preview has its own database branch, 2 variables and 1 auth callback"), the preview URL as a link, then one line per plan line: what it manages (by name; values never shown, inputs only as references), whether it was set up or is unchanged, a link to the provider's console, and what a waiting line waits for. A refusal, a failure or drift is one sentence with the fix (`--reconcile`, `--approved-by`, `--confirm`). On destroy: "Cleaned up", "Kept (adopted, never destroyed)" and "Left for you". Still one comment per environment, updated in place by its `<!-- sponson:<env> -->` marker; a comment that would exceed GitHub's 65,536 characters keeps its headline and says what it left out.
  - **`--format markdown`** on `plan` and `apply` prints that comment (also for errors, with the same exit code); `--format json` is `--json`. The `sponson` package exports the renderer, `renderMarkdown(envelope)`, a pure function of a `--json` envelope.
  - **The GitHub Action** renders its comment with that renderer from the JSON it saves (`action/render-comment.mjs`), so the comment and the CLI never disagree. With `version: <npm version>` the action now installs Sponson with `npm install` into the runner's temporary directory instead of `npx`; a version older than the renderer gets a one-line summary comment.
  - **Receipts** carry `lines[id].consoleUrl` (the provider console page for what a line manages) after apply, and `lines[id].removed` (what destroy deleted, or forgot because it was adopted) after `--destroy`. Ops declare console pages with the new optional `OpSpec.consoleUrl`; Neon links the branch, Vercel the project's Environment Variables page, Clerk the dashboard, and recipes the new optional `console_url: { template, source }` (filled for `stripe.webhook_endpoint`).
  - The GitLab, CircleCI and Bitbucket READMEs (integrations/README.md) show how to post the same comment as a merge request note or pull request comment.

### Patch Changes

- Updated dependencies [d72de54]
- Updated dependencies [051c526]
  - @sponson/adapters@0.8.0
  - @sponson/core@0.8.0

## 0.7.0

### Minor Changes

- ca3714c: `neon.branch` without `parent` now forks from the project's default branch (the one Neon lists with `default: true`),
  whatever it is called, instead of a branch named `main`. A new Neon project calls its default branch `production`
  (checked against the real API on 2026-10-11), so a new user's first apply failed with "parent branch `main` not
  found". An explicit `parent` (name or id) works as before; an unknown one now says which branch omitting it would
  use. `sponson init`, the `sponson-sim --demo` plan, the README and the examples no longer write `parent: main`. The
  sim's default Neon project now has a root branch named `production`, marked default, and answers a duplicate branch
  name with Neon's real `409 BRANCH_ALREADY_EXISTS` body.

### Patch Changes

- Updated dependencies [ca3714c]
- Updated dependencies [ca3714c]
  - @sponson/adapters@0.7.0
  - @sponson/core@0.7.0

## 0.6.1

### Patch Changes

- 25c1dc4: Every package now carries an npm provenance attestation, so you can check it was built from this repository by its release workflow (`npm audit signatures`). 0.4.0 to 0.6.0 were published without one.
- Updated dependencies [25c1dc4]
  - @sponson/core@0.6.1
  - @sponson/adapters@0.6.1

## 0.6.0

### Minor Changes

- 379caf9: New `cloud_run` adapter with one op, `cloud_run.revision`: a revision of an existing Google Cloud Run service per scope, made from the service's template with the line's image and environment variables (`{ from }` and `{ secret }` values included), tagged (`pr-42` by default) with its own URL as the `url` output, and given no traffic; `apply` waits for Cloud Run's operations and for the revision to be ready, drift covers the image and the declared variables, and destroy removes the tag. It authenticates with the token `gcloud auth print-access-token` prints and needs `providers.cloud_run.project` and `.region`; `production: true` in that block makes its lines need approval. Traffic is never moved: when a share of the service's traffic follows LATEST, the line is refused before any write unless it sets `pin_latest: true`, which pins that share to the revision serving it, as `gcloud run deploy --no-traffic` does (see docs/plan-format.md for what that means for later production deploys). `sponson init` detects Cloud Run, `AdapterAbout` gains `credentialCommand` for adapters that take a CLI's token, and the sim gained a Cloud Run provider. Covers the last uncovered row of the coverage matrix, `cloud-run-tag`.

### Patch Changes

- 7a7f598: The GitLab, CircleCI and Bitbucket templates under `integrations/` have now been run end to end in Docker against the fake cloud (`scripts/try-ci-templates.sh`: GitLab's through gitlab-ci-local, CircleCI's and Bitbucket's job by job in their images), which found two bugs. Bitbucket's `branches: main` pipeline started with its manual production step, which Pipelines rejects; it now starts with an automatic step. And in a CircleCI tag build or a Bitbucket tag pipeline, where there is no branch variable and the commit is checked out detached, the run context took the branch from git, so every tag got the scope `branch-HEAD`; the tag (`CIRCLE_TAG`, `BITBUCKET_TAG`) now stands for the branch, as `CI_COMMIT_REF_NAME` and `GITHUB_REF_NAME` already do. The templates now pin `sponson@0.5.0`.
- Updated dependencies [379caf9]
- Updated dependencies [379caf9]
  - @sponson/adapters@0.6.0
  - @sponson/core@0.6.0

## 0.5.0

### Minor Changes

- 728c256: The run context is detected in GitLab CI/CD, CircleCI and Bitbucket Pipelines as it already was in GitHub Actions, so `--pr`, `--branch` and `--sha` are no longer needed there. GitLab: `CI_MERGE_REQUEST_IID`, the merge request's source branch and head commit (`CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` in merged-results pipelines, else `CI_COMMIT_SHA`), `CI_COMMIT_BRANCH`/`CI_COMMIT_REF_NAME` and `CI_DEFAULT_BRANCH`. CircleCI: the number at the end of `CIRCLE_PULL_REQUEST` (or `CIRCLE_PR_NUMBER`), `CIRCLE_BRANCH`, `CIRCLE_SHA1`. Bitbucket: `BITBUCKET_PR_ID`, `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`. Inside one of these hosts, a pipeline without a pull request means "no pull request" and skips the `gh` lookup. The sources are exported as `gitlabCiSource`, `circleCiSource` and `bitbucketPipelinesSource`. Copy-paste CI templates for the three hosts and MCP configurations for agent tools are under `integrations/`.
- c3a65ba: One-off actions (ADR 0022): a new `http.action` op sends one request (or GraphQL request) when its declared `trigger` changes, for side effects with nothing to read back or delete (an Inngest sync, a cache purge, a deploy notification). `plan` shows the new status `run` (symbol `>`) until the current trigger has run in the scope, then `unchanged`; `apply` sends it, checks the answer (status, `ok_status`, `expect`), and records the trigger hash, its outputs and its optional `undo`, which `apply --destroy` sends. Delivery is at least once (nothing is recorded before the request is sent; `request.idempotency_key: true` derives an `Idempotency-Key` from the ledger key and the trigger hash), and rollback never undoes an action. A request may go to an absolute `url` (the app's own endpoint), which never receives an API credential. The engine gained the optional `OpSpec.action` hook, `ActionTrigger`, `LedgerEntry.action`, and `run` in `PlanLineStatus` and `DiffKind`. The REST sim gained logged endpoints (`endpoints`, `calls`; assumption R9).
- 22e83a1: `sponson init` now detects every supported provider, not only the first-class ones: Auth0, Stripe, Sentry, PostHog, Statsig, GrowthBook, Upstash, Resend, Firebase, Railway, Fly.io and the other recipe providers are found from the repository's dependency names, config files and variable names (never their values). For each it writes the recipe's line: ready to apply when every value is known (a Stripe webhook endpoint or an Inngest sync on `{ from: <deploy line>.preview_url }`), otherwise commented out with a `# TODO:` naming where to find each missing value, and listed under "To fill in". Only services nothing manages yet are reported as "Not supported yet". `init --json` marks each provider found with `via: adapter` or `via: recipe`.
- ccef846: `sponson init` writes Netlify lines when it detects Netlify (`netlify.toml`, `.netlify/state.json`, `@netlify/*` or `netlify-cli`, `NETLIFY_*` variables): `providers.netlify.site` from `.netlify/state.json` (`siteId`) or `NETLIFY_SITE_ID`, a `netlify.env` line for the preview variables (the Neon branch's connection string when Neon is detected), and a Clerk callback on its `deploy_preview_url`. Netlify is no longer listed as "not supported yet".
- e303004: `sponson init` no longer reports PlanetScale as not supported. When it detects PlanetScale (an `@planetscale/*` dependency, a `PLANETSCALE_*` variable name, or a `*.psdb.cloud` database host) and not Neon, the starter plan has a `planetscale.branch` line, a `planetscale.password` line on that branch (with `connection_params: "sslaccept=strict"` when Prisma is used) and the Vercel `DATABASE_URL` from the password's connection string, with TODOs for the organization and database names.
- 6027444: `sponson init` now detects the stack from the repository's files (Vercel, Neon, Clerk, Next.js, Remix, SvelteKit,
  Astro, Nuxt, Prisma, Drizzle) and writes a plan with a line only for what it found, the project ids it can find
  (`.vercel/project.json`, `.neon`) and a `TODO` saying where to look for the others. Services Sponson does not manage
  yet (Supabase, PlanetScale, Auth0, Netlify, Cloudflare, LaunchDarkly, PostHog, Stripe, Sentry, …) are reported as
  not supported. It reads variable names from `.env*` files, never their values. `init --json` has a new `detected`
  field (`null` when the plan already existed).
- ae9655e: Added the `launchdarkly` adapter: `launchdarkly.flag_target` serves a flag variation to one context key (a preview URL, or the scope such as `pr-42`) in the environment `providers.launchdarkly` names, and `apply --destroy` removes exactly that target. A target moved to another variation in the LaunchDarkly console is `changed` drift. It needs `LAUNCHDARKLY_ACCESS_TOKEN`. `sponson init` now recognises LaunchDarkly as supported and writes a commented example line for it, and `@sponson/sim` simulates LaunchDarkly's flag targeting.
- aebda52: Added manual steps (ADR 0021) for state no API can manage, such as a Google OAuth client's redirect URIs. A
  `manual.step` line (`title`, `instructions`, optional `undo`, `vars` and a `verify` GET) is shown by `plan` as `todo`
  with its instructions filled in. `apply` leaves it and the lines that depend on it waiting, applies everything else,
  and exits 2 with the new code `MANUAL_STEP_PENDING` and the steps' instructions in `manual`, until a person runs
  `apply --confirm <line>` (or its verify request sees it done); the ledger records who confirmed it (`--approved-by`,
  else the git user) and when. A verified step that stops verifying is `missing` drift. `apply --destroy` shows the
  step's `undo` and waits for the same confirmation. The MCP `sponson_apply` tool takes `confirm`; agents never pass
  it on their own. For adapter authors: `OpSpec.manual`, `PlanLineStatus` `todo`, and `RunOptions.confirm` /
  `confirmedBy`.
- Once-only outputs are now kept only when proven: the ledger records a keyed fingerprint (never the value) of each `once` output on the producer and of the value each dependent was written with, and a later run keeps a dependent as `{ keep: true }` only when they match. A dependent added later, one whose producer was adopted, one edited outside Sponson, or one that must be created again is refused with `OUTPUT_UNAVAILABLE`. New `sponson apply --recreate <line>` (and `recreate` on the MCP apply tool, `RunOptions.recreate`) deletes what that line created and creates it again in the same run, so the new value reaches every dependent. See ADR 0018.
- 3920b14: Add the `supabase` adapter (credential `SUPABASE_ACCESS_TOKEN`, Management API). `supabase.branch` creates a Supabase preview branch per scope, waits until it is `ACTIVE_HEALTHY` (`SPONSON_SUPABASE_TIMEOUT_MS`), and outputs its `project_ref`, `api_url`, `db_host` and a sensitive `connection_string`; destroy deletes it. `supabase.auth_redirect` keeps one URL in a project's Auth redirect allow-list (`uri_allow_list`), on the parent project or, with `project: { from: db.project_ref }`, on the branch, never touching entries Sponson did not add. The sim simulates both (chaos `supabase_ready_ms` delays readiness), and `sponson init` now writes Supabase lines when it detects Supabase instead of listing it as not supported.

### Patch Changes

- d9ab332: Published with npm provenance: each package's `publishConfig` now asks for it. 0.4.0 went out without attestations because `changeset publish` runs `pnpm publish`, which ignores the release workflow's `NPM_CONFIG_PROVENANCE`.
- Updated dependencies [66e68f3]
- Updated dependencies [499907c]
- Updated dependencies [c2cf912]
- Updated dependencies [982d0d7]
- Updated dependencies [2750ee7]
- Updated dependencies [0b197ce]
- Updated dependencies [77006c1]
- Updated dependencies [c3a65ba]
- Updated dependencies [4bd1595]
- Updated dependencies [f3a532f]
- Updated dependencies [0b355f8]
- Updated dependencies [3d579f3]
- Updated dependencies [67f0615]
- Updated dependencies [2b2a04e]
- Updated dependencies [a7d6527]
- Updated dependencies [6e53e7d]
- Updated dependencies [0c41729]
- Updated dependencies [87aa4b0]
- Updated dependencies [3b2dfb2]
- Updated dependencies [ae9655e]
- Updated dependencies [dc73c90]
- Updated dependencies [cf4be11]
- Updated dependencies [aebda52]
- Updated dependencies [4b0ca25]
- Updated dependencies [ccef846]
- Updated dependencies [0f4aee9]
- Updated dependencies
- Updated dependencies [e303004]
- Updated dependencies [b645c29]
- Updated dependencies [e303004]
- Updated dependencies [d9ab332]
- Updated dependencies [22e83a1]
- Updated dependencies [c3a65ba]
- Updated dependencies [4ff44ba]
- Updated dependencies [67f0615]
- Updated dependencies [15b9e62]
- Updated dependencies [99dfe1f]
- Updated dependencies [450470f]
- Updated dependencies [3920b14]
- Updated dependencies [7dc82ef]
  - @sponson/adapters@0.5.0
  - @sponson/core@0.5.0

## 0.4.0

### Patch Changes

- 9b6c97a: Internal: scope drift, destroy, receipt parsing and listing, `init`'s plan editing, the sims' chaos selection and request handling are split into named steps; behaviour is unchanged. Lint caps cyclomatic complexity at 15.
- 53e7446: npm metadata: every package has keywords and its homepage is the documentation site (https://sponson.mintlify.site); the package READMEs link to it, and the CLI's README states the Node.js 22 requirement its `engines` already declared.
- Updated dependencies [78eef8a]
- Updated dependencies [b028881]
- Updated dependencies [eec4766]
- Updated dependencies [510ebe8]
- Updated dependencies [8f1b9c2]
- Updated dependencies [9b6c97a]
- Updated dependencies [53e7446]
  - @sponson/adapters@0.4.0
  - @sponson/core@0.4.0

## 0.3.0

### Minor Changes

- 9813460: The GitHub Action now defaults to `version: source`: it installs and runs Sponson from the action's own checkout — exactly the ref the caller pinned — instead of `npx sponson@latest`, so nothing is fetched from a package registry. Pin the action to a commit SHA. An explicit npm version is still accepted once the package is published from this repository. Node 22 is now the minimum (the versions CI tests).
- 0434a9e: Context detection (`detectCtx`, GitHub Actions and local git/`gh`) moved from `@sponson/core` to `sponson` behind a `CtxSource` seam (breaking for direct users of `@sponson/core`). A lease holder whose renewals stall now stops itself before its lease could be taken over. `ReceiptStore.close()` lets long-running hosts release temporary git clones. Adapters gain `adopt()`; the plan format has a JSON Schema. Adapters declare `about` (credential and base-URL variables) and secret sources declare `form`/`resolvedBy`, read by the generated docs (ADR 0015). Secret-source errors no longer repeat the reference, and a missing CLI is reported as such. `aws-sm://` resolves secrets from AWS Secrets Manager. `pnpm sim` prints a paste-ready environment block.

### Patch Changes

- Updated dependencies [3f2c6e0]
- Updated dependencies [8987603]
- Updated dependencies [4f01efe]
- Updated dependencies [e009218]
- Updated dependencies [0434a9e]
- Updated dependencies [7fc20cf]
- Updated dependencies [1533787]
  - @sponson/adapters@0.3.0
  - @sponson/core@0.3.0
