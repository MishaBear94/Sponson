# sponson

## 0.5.0

### Minor Changes

- 728c256: The run context is detected in GitLab CI/CD, CircleCI and Bitbucket Pipelines as it already was in GitHub Actions, so `--pr`, `--branch` and `--sha` are no longer needed there. GitLab: `CI_MERGE_REQUEST_IID`, the merge request's source branch and head commit (`CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` in merged-results pipelines, else `CI_COMMIT_SHA`), `CI_COMMIT_BRANCH`/`CI_COMMIT_REF_NAME` and `CI_DEFAULT_BRANCH`. CircleCI: the number at the end of `CIRCLE_PULL_REQUEST` (or `CIRCLE_PR_NUMBER`), `CIRCLE_BRANCH`, `CIRCLE_SHA1`. Bitbucket: `BITBUCKET_PR_ID`, `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`. Inside one of these hosts, a pipeline without a pull request means "no pull request" and skips the `gh` lookup. The sources are exported as `gitlabCiSource`, `circleCiSource` and `bitbucketPipelinesSource`. Copy-paste CI templates for the three hosts and MCP configurations for agent tools are under `integrations/`.
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
- Updated dependencies [499907c]
- Updated dependencies [c2cf912]
- Updated dependencies [0b197ce]
- Updated dependencies [77006c1]
- Updated dependencies [f3a532f]
- Updated dependencies [0b355f8]
- Updated dependencies [6e53e7d]
- Updated dependencies [0c41729]
- Updated dependencies [ae9655e]
- Updated dependencies [cf4be11]
- Updated dependencies [aebda52]
- Updated dependencies [ccef846]
- Updated dependencies [0f4aee9]
- Updated dependencies
- Updated dependencies [e303004]
- Updated dependencies [b645c29]
- Updated dependencies [e303004]
- Updated dependencies [d9ab332]
- Updated dependencies [99dfe1f]
- Updated dependencies [3920b14]
  - @sponson/core@0.5.0
  - @sponson/adapters@0.5.0

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
