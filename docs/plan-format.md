# The plan format: `release.plan.yaml`

This is the reference for the file. For a guided introduction read the [README](../README.md); for worked plans see
[examples/](../examples/README.md). The parser is `packages/core/src/plan.ts`; where this page and the parser
disagree, the parser is right and this page has a bug.

- [Editor support](#editor-support)
- [Top-level keys](#top-level-keys)
- [Change keys](#change-keys)
- [Values](#values)
- [Context interpolation: `${ctx.*}`](#context-interpolation-ctx)
- [Environments](#environments)
- [Ordering: references and `depends_on`](#ordering-references-and-depends_on)
- [Built-in ops](#built-in-ops)
- [What is checked when](#what-is-checked-when)

## Editor support

[`schema/release.plan.schema.json`](../schema/release.plan.schema.json) is a JSON Schema (draft 2020-12) for the
file. Editors with the YAML language server (VS Code's YAML extension, Neovim's yamlls, JetBrains IDEs) pick it up
from a comment on the first line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/MishaBear94/Sponson/main/schema/release.plan.schema.json
```

Inside this repository you can point at the file instead: `$schema=../schema/release.plan.schema.json` (relative to
the plan). The schema gives completion and hover text for every key below and flags most mistakes as you type. It
cannot check rules that compare one part of the file with another; see
[What the schema does not check](#what-the-schema-does-not-check).

## Top-level keys

```yaml
version: 1                                # required
environments: [preview, production]       # optional
providers:                                # optional
  vercel: { project: prj_xxx, team: team_xxx }
  neon: { project: proj_xxx }
receipts: git-branch                      # optional
changes: []                               # required
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | (required) | Format version. Anything else is `PLAN_INVALID`. |
| `environments` | non-empty list of names | `preview`, `production`, plus every name a line's `environments:` uses | The environments `--env` may name. An unknown `--env` is `ENV_UNKNOWN`; a line naming an undeclared environment is `PLAN_INVALID`. |
| `providers` | map: adapter name → map | `{}` | Static configuration per adapter, handed to the adapter as `providers.<adapter>`. Built-in: `vercel.project` (required by the Vercel ops), `vercel.team` (optional), `neon.project` (required by the Neon op). Clerk needs none. `http.<api>` holds one block per API (see [the generic `http` adapter](#the-generic-http-adapter)). A missing required key fails the line with `PLAN_INVALID` when the adapter runs. |
| `receipts` | `git-branch` \| `local` | `git-branch` | Where receipts are stored. `git-branch`: orphan branches `sponson-receipts/<env>/<scope>` (one per environment and scope) on the `origin` remote (override with `--receipts-remote` or `SPONSON_RECEIPTS_REMOTE`); with no remote, Sponson warns and uses `local`. `local`: `.sponson/receipts/` (override with `--receipts-dir` or `SPONSON_RECEIPTS_DIR`). The `--receipts` flag overrides this key. |
| `changes` | list of changes | (required) | The plan lines. Order in the file does not matter. |

The parser ignores top-level keys it does not know; the schema reports them, because they are almost always typos.

## Change keys

Each change ("line") is one adapter op:

```yaml
- id: env                      # required
  adapter: vercel              # required
  op: env                      # required
  environments: [preview]      # optional
  depends_on: [db]             # optional
  target: preview              # every other key is a parameter of the op
  values:
    DATABASE_URL: { from: db.connection_string }
```

| Key | Type | Meaning |
|---|---|---|
| `id` | string matching `^[a-z][a-z0-9_-]*$` | Unique within the plan. Other lines refer to it in `from:` and `depends_on`. Receipts key line results by it. |
| `adapter` | non-empty string | `neon`, `vercel`, `clerk`, `http`, or one added by a plugin (`SPONSON_PLUGINS`). Unknown: `ADAPTER_UNKNOWN`. |
| `op` | non-empty string | An op of that adapter. Unknown: `OP_UNKNOWN`. |
| `environments` | non-empty list of declared environment names | The line applies only in these environments. Absent: every environment. |
| `depends_on` | list of ids | Run after these lines although no value flows between them. Prefer `from:` references, which imply the order. |
| anything else | see [Values](#values) | A parameter of the op. The built-in ops' parameters are listed under [Built-in ops](#built-in-ops). |

## Values

Every parameter, at any depth (inside maps and lists too), takes one of these forms:

| Form | Example | Meaning |
|---|---|---|
| literal | `preview`, `3`, `true` | A string, number or boolean written in the file. |
| `{ from: <id>.<output> }` | `{ from: db.connection_string }` | Another line's output. Implies that this line runs after `<id>`. |
| `{ secret: "<scheme>://<ref>" }` | `{ secret: "env://STRIPE_SECRET_KEY" }` | A secret, resolved by Sponson at run time and never written anywhere. |
| `{ keep: true }` | `SENTRY_DSN: { keep: true }` | Whatever value the resource has live. Sponson manages that it exists and who owns it, not its value. |

### `{ from }` references

- The part before the first `.` must be the id of another line; the rest must be an output that line's op declares
  (see [the outputs table](#outputs)). An unknown id is `REF_UNKNOWN` at parse time; an unknown output is
  `REF_OUTPUT_UNKNOWN` when the plan is prepared, before any provider is called, and the message lists the valid
  outputs.
- A reference is the whole value. `{ from: env.preview_url }` cannot be combined with other text.
- Until the referenced output exists, the value is `pending`: `plan` shows the line as `pending` with `waitingOn`
  (and `waitingFor`, such as `deploy`, when the output depends on an external event). `apply` never sends a pending
  value to a provider.
- A sensitive output (for example `neon.branch`'s `connection_string`) can be referenced like any other, but its value
  is never displayed, logged or written to a receipt.

### `{ secret }` references

#### Secret schemes

The schemes that ship with Sponson (`createRegistry()` in `@sponson/adapters`):

<!-- generated:secret-schemes:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
| Scheme | Form | Resolved by |
|---|---|---|
| `env` | `env://NAME` | the process environment; unset or empty is `SECRET_UNRESOLVED` |
| `doppler` | `doppler://project/config/NAME` | `doppler secrets get NAME --project project --config config --plain` (Doppler CLI) |
| `op` | `op://vault/item/field` | `op read op://vault/item/field --no-newline` (1Password CLI) |
| `aws-sm` | `aws-sm://secret-id` or `aws-sm://secret-id#KEY` | `aws secretsmanager get-secret-value --secret-id secret-id --query SecretString --output json` (AWS CLI; region and credentials from `AWS_REGION`, `AWS_PROFILE` and the CLI's other conventions). `secret-id` is a name or an ARN; `#KEY` picks one key of a JSON key/value secret. Binary secrets are not supported. |
| `gcp-sm` | `gcp-sm://project/secret` or `gcp-sm://project/secret/version` | `gcloud secrets versions access version --secret=secret --project=project --format=json` (Google Cloud CLI; credentials from `gcloud auth` and the CLI's other conventions). `version` is a number or `latest` (the default). The payload must be UTF-8 text. |
<!-- generated:secret-schemes:end -->

Plugins can add schemes. A `secret:` that is not a URL (`scheme://…`) is `PLAN_INVALID`. Every command (`plan` and
`apply --destroy` included) resolves the secrets of the active lines first, so their values can be masked in all
output before anything is printed; a scheme backed by a CLI therefore runs that CLI on `plan` too. Only `apply`
passes the values to an adapter. A secret that cannot be resolved makes its line `blocked` (`SECRET_UNRESOLVED`).

**Secret-looking names take references, never literals.** A parameter whose name ends in `_KEY`, `_SECRET`,
`_TOKEN`, `PASSWORD`, `_PASS`, `PASSWD` or `PRIVATE` (any case) and whose value is a literal string or number is
rejected at parse time with `SECRET_LITERAL`. `{ from }`, `{ secret }` and `{ keep: true }` are allowed.

**Display text is not a value.** `plan` prints unresolved values as `(pending ← db.connection_string)` or
`(secret ← env://X)`. A string that starts like that (or like `<pending:` / `<secret>`) is rejected with
`PLAN_INVALID`: write the reference instead.

### `{ keep: true }`

`sponson init` writes `{ keep: true }` when it adopts existing variables, so that values are never copied into the
plan. Adapters treat it as "equal to whatever is live": the diff is `unchanged` and `apply` leaves the live value
alone. If the resource does not exist, there is nothing to keep and the line fails with `PARAM_INVALID`. Replace
`{ keep: true }` with a literal or a reference to let Sponson manage the value.

### Value states in `--json`

`plan --json` reports every input of every line under `lines[].inputs`, keyed by its dotted path (for example
`values.DATABASE_URL`), with an explicit state:

| `state` | `value` | When |
|---|---|---|
| `literal` | the value | written in the file |
| `resolved` | the value, or `null` when `sensitive: true` | a `from:` whose output exists now |
| `pending` | `null` | a `from:` whose output does not exist yet; `ref` names it |
| `secret` | `null` (always) | a `secret:`; `ref` is the URL |
| `kept` | `null` | `{ keep: true }` |

Unknown, secret and sensitive values are `null` next to their `state`, never placeholder text.

## Context interpolation: `${ctx.*}`

Strings in parameters may contain `${ctx.<name>}`. Interpolation happens before the adapter sees the parameters, in
values only (not in map keys, ids, `adapter`, `op`, `environments` or `providers`). These are the only variables;
there are no user-defined ones.

| Variable | Value |
|---|---|
| `${ctx.env}` | the run's environment (`--env`, default `preview`) |
| `${ctx.scope}` | the lifecycle unit: `pr-<n>` inside a pull request, `main` on `main`, `master` or the repository's default branch, `branch-<name>` otherwise (characters outside `[A-Za-z0-9._-]` become `-`) |
| `${ctx.git.branch}` | the git branch |
| `${ctx.git.sha}` | the full commit sha |
| `${ctx.git.short_sha}` | its first 7 characters |
| `${ctx.pr.number}` | the pull request number; **null outside a pull request**, which stops the command with `CTX_NULL` before any provider is called. Use `${ctx.scope}` when the plan also runs outside pull requests. |

An unknown variable is `CTX_NULL` too, and the message lists the valid ones.

The context comes from, in order of precedence: the flags `--env`, `--branch`, `--sha`, `--pr`; the variables
`SPONSON_CTX_ENV`, `SPONSON_CTX_BRANCH`, `SPONSON_CTX_SHA`, `SPONSON_CTX_PR` (`SPONSON_CTX_PR=""` means "no pull
request"); the CI host's predefined variables (GitHub Actions' variables and event payload; GitLab CI/CD's
`CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`/`_SHA`, `CI_COMMIT_REF_NAME`, `CI_COMMIT_SHA` and
`CI_DEFAULT_BRANCH`; CircleCI's `CIRCLE_PULL_REQUEST`, `CIRCLE_BRANCH`, `CIRCLE_SHA1`; Bitbucket Pipelines'
`BITBUCKET_PR_ID`, `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`); the local git checkout; and, for the pull request number
outside CI, `gh pr view`. The environment is never inferred: without `--env` it is `preview`.

## Environments

A plan is one flat list. `environments:` on a line filters it: `sponson plan --env production` sees only the lines
whose `environments` include `production`, plus the lines without `environments`. Write the same variable twice, once
per environment, rather than reaching for anchors or expressions:

```yaml
- id: env-preview
  adapter: vercel
  op: env
  target: preview
  values: { DATABASE_URL: { from: db.connection_string } }
  environments: [preview]

- id: env-production
  adapter: vercel
  op: env
  target: production
  values: { DATABASE_URL: { secret: "env://PRODUCTION_DATABASE_URL" } }
  environments: [production]
```

A line may not reference a line that the filter removed: that is `REF_FILTERED`, with a message saying which filter to
change.

**Approval.** A run needs an approver (`--approved-by <who>` or `SPONSON_APPROVED_BY`) when it can write to
production: when `--env production`, or when any active line writes to production whatever the run's environment
(`vercel.env` with `target: production`). Without one, `apply` is refused with `ENV_NOT_APPROVED` before any provider
is called. `plan --json` reports `requiresApproval: true` in both cases. A blank name is no name.

YAML anchors and aliases are allowed but produce the warning `YAML_ANCHOR`: repeated lines are easier to review.

## Ordering: references and `depends_on`

Sponson orders the active lines so that each comes after every line it references with `from:` and every line in its
`depends_on`. A cycle is `REF_CYCLE`, and the message prints it (`a → b → a`). Ties are broken deterministically, so
the same plan always runs in the same order. Lines whose input depends on an external event (a deploy) are not
special in the file: Sponson stops at them and the next `apply` continues (see
[ADR 0004](adr/0004-apply-phases-inferred-from-output-availability.md)).

## Built-in ops

The adapters that ship with Sponson (`createRegistry()` in `@sponson/adapters`) and their ops. Plugins loaded with
`SPONSON_PLUGINS` can add more. Credentials come from each provider's own variable; Sponson has no credential store.
The base URL override replaces the provider's API base URL (the test suites point it at the local fake cloud).

<!-- generated:adapters:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
| Adapter | Ops | Credential | Base URL override |
|---|---|---|---|
| `neon` | [`neon.branch`](#neonbranch) | `NEON_API_KEY` | `NEON_API_URL` |
| `vercel` | [`vercel.env`](#vercelenv), [`vercel.deploy`](#verceldeploy) | `VERCEL_TOKEN` | `VERCEL_API_URL` |
| `clerk` | [`clerk.redirect_allow`](#clerkredirect_allow) | `CLERK_SECRET_KEY` | `CLERK_API_URL` |
| `planetscale` | [`planetscale.branch`](#planetscalebranch), [`planetscale.password`](#planetscalepassword) | `PLANETSCALE_SERVICE_TOKEN_ID` + `PLANETSCALE_SERVICE_TOKEN` | `PLANETSCALE_API_URL` |
| `launchdarkly` | [`launchdarkly.flag_target`](#launchdarklyflag_target) | `LAUNCHDARKLY_ACCESS_TOKEN` | `LAUNCHDARKLY_API_URL` |
| `http` | [`http.resource`](#httpresource), [`http.list_item`](#httplist_item) | `providers.http.<api>.auth` | `providers.http.<api>.base_url_env` |
| `supabase` | [`supabase.branch`](#supabasebranch), [`supabase.auth_redirect`](#supabaseauth_redirect) | `SUPABASE_ACCESS_TOKEN` | `SUPABASE_API_URL` |
<!-- generated:adapters:end -->

A missing credential fails the line with `PROVIDER_AUTH`. Every resource has a key that identifies it within the
adapter and provider block; the ledger treats two resources with the same key as the same resource.

### `neon.branch`

A Neon branch. Requires `providers.neon.project`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `sponson/${ctx.env}/${ctx.scope}` | Branch name; the branch's identity (key `branch:<name>`). |
| `parent` | string | `main` | Parent branch, by name or id. Used only when the branch is created; a different parent on an existing branch is not a change. An unknown parent is `PARAM_INVALID`. |

`connection_string` is the URI for the branch's database `neondb` (a new Neon project's default) or, when it has no
such database, its first one, connecting as the role that owns that database.
Destroy deletes the branch. For drift and adoption, every branch except the project's root branch is in scope.

### `vercel.env`

Environment variables of one Vercel target and, for `preview`, one git branch. Requires `providers.vercel.project`;
`providers.vercel.team` is sent as `teamId` when present.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | `preview` \| `production` \| `development` | `production` when `--env production`, else `preview` | The Vercel target. Anything else is `PARAM_INVALID`. `production` requires approval (see [Environments](#environments)). |
| `branch` | string | the current git branch, for `target: preview` | The git branch the variables apply to. `"*"` (or `""`) means project-wide: every preview deployment sees them. A specific branch is only valid with `target: preview`. |
| `values` | map: NAME → value | `{}` | The variables. Each value is a literal, `{ from }`, `{ secret }` or `{ keep: true }`. All values are written as encrypted and shown as sensitive in diffs. |

Each variable is a resource with key `env:<target>:<branch or *>:<NAME>`. A dashboard variable that one record shares
between several targets cannot be managed by a line that owns one target; the line fails with `PROVIDER_CONFLICT` and
asks you to split it. After writing, if the newest deployment of this commit for the line's environment (production for
`target: production`, a preview otherwise) started before the write (and has not failed), the adapter triggers a
redeploy so the build sees the new values, and the receipt line gets `notes.redeployed: true`.

`preview_url` and `deployment_id` are external outputs: they become available when the newest deployment of the
current commit for the line's environment is `READY` — a commit's preview build is never taken for its production
build, or the other way round. `target: development` variables belong to no deployment: writing them never
triggers a redeploy, and a line that reads their `preview_url` fails with `PARAM_INVALID`. A deployment that ends `ERROR`, `CANCELED`, `BLOCKED` or `DELETED` fails the lines waiting on it
(`EXTERNAL_FAILED`). Project-wide variables belong to the scope that applied them first and are destroyed with it;
see [examples/README.md](../examples/README.md#vercel-shared-and-branch-varsplanyaml).

### `vercel.deploy`

A deployment of the current commit, started by Sponson through the project's Git connection (GitHub, GitLab or
Bitbucket: the connected repository at the context's branch and sha; target `production` when `--env production`).
A project with no Git connection fails with `PROVIDER_INVALID`. Takes no parameters. Requires
`providers.vercel.project`. Its resource key is `deployment:<production|preview>:<sha>`: a commit's production and
preview deployments are different resources.

If a deployment of this commit for the run's environment exists and has not failed, the op watches it instead of starting another. `apply`
waits until it is `READY`, for at most `SPONSON_DEPLOY_TIMEOUT_MS` (default 120000), then fails with `WAIT_TIMEOUT`.
Its outputs are immediate, so a plan with an explicit deploy line has no external barrier. Destroy leaves deployments
alone: they are history.

### `clerk.redirect_allow`

One URL on the Clerk instance's redirect allow-list (the instance `CLERK_SECRET_KEY` belongs to).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | (required) | The URL; its identity (key `redirect:<url>`). Usually `{ from: <vercel.env line>.preview_url }`. |

A URL that is already on the list is taken over, not duplicated. Destroy removes the URL. For drift and adoption,
every URL on the instance's list is in scope.

### `planetscale.branch`

A development branch of a PlanetScale database (Vitess / MySQL), one per scope. Requires
`providers.planetscale.organization` and `providers.planetscale.database`; the credential is a service token, two
variables sent together as `Authorization: <PLANETSCALE_SERVICE_TOKEN_ID>:<PLANETSCALE_SERVICE_TOKEN>`. The token
needs the `create_branch`, `read_branch`, `delete_branch`, `connect_branch` and `delete_branch_password` accesses on
the database.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `sponson-${ctx.env}-${ctx.scope}`, lowercased, anything but letters, digits and dashes turned into `-` | Branch name; the branch's identity (key `branch:<name>`). |
| `parent` | string | `main` | Parent branch, by name. Used only when the branch is created; a different parent on an existing branch is not a change. An unknown parent is `PARAM_INVALID`. |

PlanetScale provisions a new branch asynchronously: `apply` polls it every `SPONSON_PLANETSCALE_POLL_MS` (default
2000) until it reports `ready`, for at most `SPONSON_PLANETSCALE_READY_TIMEOUT_MS` (default 600000), then fails with
`WAIT_TIMEOUT` (the run's rollback deletes the branch it created). A create that meets a branch of the same name (the
answer to an earlier create of ours was lost, or someone else made it) takes that branch instead of failing; whether
it is Sponson's is decided by the ledger's intent, as for every adapter. Outputs: `name` (pass it to
`planetscale.password`) and `branch_id`.

A branch deleted in the console is `missing` drift and re-created by the next apply; one deleted and re-created
under the same name is `changed` drift (a new id), refused until `--reconcile`, which takes it over as adopted.
Destroy deletes the branch by name, and only if it is still the one the ledger recorded. For drift and adoption,
every non-production branch of the database is in scope.

### `planetscale.password`

A password (credential) on a PlanetScale branch, and the connection string built from it.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `branch` | string | (required) | The branch, by name. Usually `{ from: <planetscale.branch line>.name }`. |
| `name` | string | `sponson-${ctx.env}-${ctx.scope}`, as for the branch | The password's name on that branch; with the branch, its identity (key `password:<branch>/<name>`). |
| `role` | `reader` \| `writer` \| `readwriter` \| `admin` | `admin` (as `pscale password create`) | The password's database role. |
| `connection_params` | string | `ssl={"rejectUnauthorized":true}` | The query of `connection_string` (the form PlanetScale documents for Node.js drivers). Prisma wants `sslaccept=strict`. |

`connection_string` is `mysql://<username>:<password>@<access host>/<database>?<connection_params>`. Before
creating the password, `apply` waits for the branch to be ready (an earlier run may have left it provisioning).

**The plaintext exists once.** PlanetScale returns a password's plaintext only in the answer that creates it; no
later request can read it, and Sponson never stores it. So `password` and `connection_string` are sensitive
[once-only outputs](#once-only-outputs):

- In the run that creates the password, they reach the lines that reference them, like any output. Put those
  lines in the same plan (a `vercel.env` line with `DATABASE_URL: { from: dbpw.connection_string }`).
- In every later run they are `{ keep: true }` for those lines: a variable that already holds the value is unchanged,
  so re-applying an unchanged plan writes nothing.
- A line that would have to write the value again (its variable was deleted, or a new line references the password
  after it was created) is **refused** with `OUTPUT_UNAVAILABLE`, nothing written. Sponson never re-creates or
  renews a password on its own to get a value back: that would rotate a credential something may still be using.
  To rotate deliberately, delete the password in PlanetScale (`missing` drift: the next apply creates a new one and
  passes it on in that run) or change its `name` in the plan.

A different `role` on an existing password is `PARAM_INVALID` at plan time: PlanetScale cannot change a role in
place, and replacing the password is the plan's decision (a new `name`), not Sponson's. Two passwords with the line's
name on one branch are `PROVIDER_CONFLICT` (PlanetScale does not keep names unique). Destroy deletes the password;
destroying the branch deletes the rest. Passwords are not listed for drift or adoption. PlanetScale Postgres
databases use roles instead of passwords and are not supported by this op.

### `launchdarkly.flag_target`

Serves one variation of a LaunchDarkly feature flag to one individual target, a context key of a context kind, in one
environment: typically a flag turned on for a pull request's preview. Requires `providers.launchdarkly.project` (the
project key) and `providers.launchdarkly.environment` (the environment key, usually a preview or test environment).
The flag must already exist; Sponson never creates or deletes flags, and never turns a flag on or off.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `flag` | string | (required) | The flag key. An unknown flag, or an environment the project lacks, is `PROVIDER_NOT_FOUND`. |
| `key` | string | `${ctx.scope}` (`pr-42`) | The context key to target, e.g. `{ from: <vercel.env line>.preview_url }`. |
| `context_kind` | string | `user` | The context kind of `key` (for a URL, a kind such as `url` that your application evaluates). |
| `variation` | any | `true` | The variation to serve, by name (`"Treatment"`) or by value (`true`, `"treatment"`, `42`). One that matches no variation, or more than one, is `PARAM_INVALID` at plan time. `{ keep: true }` keeps whatever variation the target is served. |

The resource key is `target:<flag>:<context_kind>:<key>`; the project and environment are the provider block, which
the ledger keys every resource by, so the same target in another environment is another resource. The resource's hash
covers the variation (by its id): a human who moves the target to another variation in the LaunchDarkly console makes
`changed` drift, refused until `--reconcile`; a human who removes it makes `missing` drift, and the next apply adds it
back. A target that already exists is taken over, not duplicated; one in another variation is moved (a single
semantic patch removes it from the old variation and adds it to the new one). Destroy removes exactly this target,
from whichever variation serves it; the flag's other targets and rules are untouched. An environment that requires
approvals for flag changes fails the line with `PROVIDER_INVALID` (Sponson does not open approval requests). For drift
and adoption, every individual target of the line's flag in the environment is in scope.

### `supabase.branch`

A Supabase preview branch ([Branching](https://supabase.com/docs/guides/deployment/branching)) of the project
`providers.supabase.project` (the parent project's ref; branching must be enabled on it). Each branch is a project of
its own, with its own ref, API URL and database.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `sponson-${ctx.env}-${ctx.scope}` | Branch name; the branch's identity (key `branch:<name>`). The project's default branch is never managed: naming it is `PARAM_INVALID`. |

`apply` creates the branch, then waits until its project is `ACTIVE_HEALTHY`, for at most
`SPONSON_SUPABASE_TIMEOUT_MS` (default 600000), and fails with `WAIT_TIMEOUT` after that; the next `apply` keeps
waiting for the same branch instead of creating another. A branch that ends `INIT_FAILED` (or another state it does
not leave by itself) fails the line with `PROVIDER_INVALID`.

Outputs: `project_ref` (the branch's own ref), `api_url` (`https://<project_ref>.supabase.co`, for
`NEXT_PUBLIC_SUPABASE_URL`), `db_host`, and `connection_string`, sensitive: the branch's direct connection,
`postgresql://<db_user>:<db_pass>@<db_host>:<db_port>/postgres`. Supabase's direct host resolves over IPv6 unless the
project has the IPv4 add-on. Destroy deletes the branch. For drift and adoption, every branch except the project's
default one is in scope; a branch deleted and re-created under the same name is `changed` drift (a new ref).

### `supabase.auth_redirect`

One URL in a project's Auth redirect allow-list ("Redirect URLs"), which the Management API stores as one
comma-separated string, `uri_allow_list`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | (required) | The URL or pattern (Supabase accepts wildcards such as `https://*-acme.vercel.app/**`); its identity (key `redirect:<url>`). A comma or surrounding whitespace is `PARAM_INVALID`. Usually `{ from: <vercel.env line>.preview_url }`. |
| `project` | string | `providers.supabase.project` | The ref of the project whose allow-list to edit. A preview branch is a project with its own Auth config, so a preview that talks to its branch sets `project: { from: db.project_ref }`. When set, it is part of the key (`redirect:<project>:<url>`). |

`apply` reads the list, appends the URL and writes the whole field back (a `PATCH` carrying only `uri_allow_list`),
then reads it again to confirm. The API offers no precondition, so a concurrent edit can overwrite the write; the
re-read notices and the round is repeated (three times, then `PROVIDER_CONFLICT`). A URL already on the list is taken
over, not duplicated. Destroy removes exactly that entry and leaves every other entry in place; when the project is
already gone (a branch deleted first), there is nothing to remove. For drift and adoption, every URL on the list of
`providers.supabase.project` is in scope.

### The generic `http` adapter

For the long tail of APIs that have no adapter of their own (feature flags, webhooks, allow-lists, CORS origins,
per-environment config): the plan describes the requests, and Sponson keeps every rule it keeps for the built-in
adapters (intents before creates, idempotent apply, drift by hash, destroy only what it created, secrets as
references). Why it exists and what it deliberately does not do: [ADR 0017](adr/0017-generic-http-adapter.md).
It speaks JSON (or form-encoded) REST; an API whose lifecycle is more than create, read, update and delete wants a
first-class adapter.

Each API is a block under `providers.http`, and each line names one with `api:`. A block is part of the identity of
the resources made through it: editing it (a new base URL, another credential variable, a header) re-identifies
them, as moving a Vercel line to another project would.

```yaml
providers:
  http:
    statsig:
      base_url: https://statsigapi.net/console/v1
      auth: { header: STATSIG-API-KEY, value_env: STATSIG_CONSOLE_KEY }
    stripe:
      base_url: https://api.stripe.com/v1
      auth: { bearer_env: STRIPE_SECRET_KEY }
      encoding: form
```

| Key | Type | Meaning |
|---|---|---|
| `base_url` | http(s) URL | Request paths are relative to it. |
| `base_url_env` | variable name | Optional. When this variable is set, it replaces `base_url` (a staging API; the test suites point it at the local fake cloud). |
| `auth` | map | `{ bearer_env: NAME }` (`Authorization: Bearer`), `{ header: X-Api-Key, value_env: NAME }` (the value in that header), or `{ basic: { user_env: NAME, password_env: NAME } }`. Always variable NAMES, never values; the credential's name must end in `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `_KEY` or `APIKEY` so that its value is masked in every output. Unset: `PROVIDER_AUTH`. |
| `headers` | map: header → string | Optional static headers (an API version pin). `Authorization`, `Accept` and `Content-Type` are Sponson's. |
| `encoding` | `json` \| `form` | Request bodies as JSON (default) or `application/x-www-form-urlencoded`, nested as `a[b]=c` and `a[0]=c`. Answers are read as JSON either way. |

A malformed block, or a line naming an API that is not configured, is `PLAN_INVALID` before any request is sent;
a malformed line is `PARAM_INVALID` naming the field. Paths take `{id}` (the object's id, once known) and
`{name}` placeholders filled from the line's `vars:` (literals or references; URI-encoded). Fields are a top-level
name (`url`) or a JSON pointer (`/config/url`); write a key that is literally `from`, `secret` or `keep` as a pointer
(`/from`), since a map holding one of those keys is a [reference](#values).

### `http.resource`

One object per item: a feature flag, a webhook endpoint, a DNS record.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `api` | string | (required) | The API block under `providers.http`. |
| `vars` | map | `{}` | Values for `{name}` placeholders in paths. |
| `find` | `{ path, list_path?, match, next?, cursor_param? }` | — | Locate the object by natural key: GET `path`, take the array at `list_path` (default: the whole body), keep the objects whose fields equal every `match` value. More than one is `PARAM_INVALID`. With `next` (a pointer to the next page's cursor), pages are followed, sending the cursor as `cursor_param` (default `cursor`); without it only the first page is read. |
| `read` | `{ path }` | — | GET the object. With `find`, the path takes `{id}` and fetches the found object's detail; without `find`, it must be a path that names the object (a client-chosen id or key). One of `find` and `read` is required. 404 means it does not exist. |
| `create` | `{ method?, path, body?, content_type?, idempotency_key? }` | (required) | `POST` (or `PUT`, `PATCH`) to create. The body is `match`, then `fields`, then `body` merged. `idempotency_key: true` sends an `Idempotency-Key` derived from the resource key, the commit and the body, and lets a create whose connection dropped be sent again. |
| `update` | `{ method?, path?, body?, content_type? }` | none | `PATCH` (or `PUT`, `POST`) when `fields` differ from live; path defaults to `read.path`. `PATCH` and `POST` send the declared fields; `PUT` sends the whole declared state (`match`, `fields`, kept values). Without `update`, a difference is `PARAM_INVALID`. |
| `delete` | `{ method?, path? }` | `DELETE read.path` | How the object is removed (`DELETE` or `POST`). |
| `destroy` | `delete` \| `keep` | `delete` | `keep` leaves the object in place when the scope is destroyed. |
| `item_path` | JSON pointer | `""` | Where the object is in read, create and update answers (`/data` for a `{ data: {...} }` envelope). |
| `id_path` | JSON pointer | `/id` | Where the id is in the object. |
| `fields` | map: field → value | `{}` | The desired state, compared for drift and sent on create and update. Values are literals, `{ from }`, `{ secret }` or `{ keep: true }`. |
| `outputs` | map: name → pointer, or `{ path, sensitive: true }` | `{}` | Outputs read from the object, besides `id` (always there). A sensitive one is never shown or written to a receipt. |
| `exists_status` | list of statuses | `[]` | Besides 409, the statuses a create answers when the object exists already: it is then found and taken over, not created. |
| `gone_status` | list of statuses | `[]` | Besides 404, the statuses that mean "gone" on read and delete. |

Key: `<find.path>[<field>=<value>,…]` when located by `find`, else `read.path`. The record id is the request that
removes the object (`DELETE /flags/<id>`), so destroy needs only the ledger; a new id means it was deleted and
re-created outside Sponson. **Drift** covers the declared `fields` only, hashed as canonical JSON: a console edit of
a declared field is `changed`, an edit of anything else is not Sponson's business, a deleted object is `missing`.
Write values with the type the API returns (`true`, not `"true"`), or every plan shows an update. A value the API
never returns (a write-only secret) belongs in `create.body`, which is sent but not compared. An object that exists
before the first apply is taken over as adopted, never deleted. Not listed for drift or adoption: a collection holds
much that is not this release's.

### `http.list_item`

One value kept in a collection on a parent object: an allowed origin, a callback URL, a config var. The parent is
read, the collection changed, and the result written back; then the parent is read again, and the write counts only
once the item is there as planned (written again, up to three times, if another writer dropped it).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `api` | string | (required) | The API block under `providers.http`. |
| `vars` | map | `{}` | Values for `{name}` placeholders in paths. |
| `parent` | `{ path, read_path?, method?, send?, content_type? }` | (required) | GET `read_path` (default `path`), write with `method` (`PATCH` by default, `PUT`, `POST`) to `path`. `send: field` (default) sends only the collection at `list_path`; `send: parent` sends the whole object read just before, with the collection replaced. |
| `list_path` | JSON pointer | (required except for `map`) | Where the collection is in the parent. `""` is the whole parent (a map of config vars). |
| `shape` | `array` \| `delimited` \| `map` | `array` | A JSON array; one string of values joined by `separator` (a comma-separated allow-list); or a map of name → value, where an entry is written as a merge patch and `null` deletes it (config vars). |
| `separator` | string | `,` | For `delimited`. |
| `item` | value or map | (required) | `array`: the value, or a map whose `key_field` identifies it; `delimited`: the string; `map`: the entry's name. |
| `key_field` | field | — | Required when an array `item` is a map: the field that identifies it (`name`, `/match/host`). |
| `value` | value | — | Required for `map`: the entry's value (a literal, `{ from }`, `{ secret }`, `{ keep: true }`). |
| `destroy` | `delete` \| `keep` | `delete` | `keep` leaves the item in place when the scope is destroyed. |

Key: `<parent.path>#<list_path>=<item>`. **Drift**: the item missing from the collection is `missing`; for map items
and keyed entries, a declared field or value edited in the console is `changed`. Items no line declares are left
exactly as they are, and are reported as `unmanaged`. Writes replace the whole collection (except keyed maps sent
as `field`), so they are sent as idempotent and retried after a dropped connection. There is no precondition: two
runs editing the same parent at the same moment can still lose one write, which the re-read reports as
`PROVIDER_CONFLICT` when it happens to see it ([ADR 0017](adr/0017-generic-http-adapter.md)).

### Outputs

The outputs each built-in op declares. `immediate` outputs exist once the line is applied; `external` ones only after
the named event. Sensitive outputs are never displayed, logged or written to receipts.

<!-- generated:outputs:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
| Op | Output | Available | Sensitive |
|---|---|---|---|
| `neon.branch` | `branch_id` | immediate | no |
| `neon.branch` | `connection_string` | immediate | yes |
| `neon.branch` | `host` | immediate | no |
| `vercel.env` | `preview_url` | external (`deploy`) | no |
| `vercel.env` | `deployment_id` | external (`deploy`) | no |
| `vercel.deploy` | `preview_url` | immediate | no |
| `vercel.deploy` | `deployment_id` | immediate | no |
| `clerk.redirect_allow` | `id` | immediate | no |
| `planetscale.branch` | `name` | immediate | no |
| `planetscale.branch` | `branch_id` | immediate | no |
| `planetscale.password` | `id` | immediate | no |
| `planetscale.password` | `username` | immediate | no |
| `planetscale.password` | `host` | immediate | no |
| `planetscale.password` | `role` | immediate | no |
| `planetscale.password` | `password` | immediate, [once](#once-only-outputs) | yes |
| `planetscale.password` | `connection_string` | immediate, [once](#once-only-outputs) | yes |
| `launchdarkly.flag_target` | `variation_id` | immediate | no |
| `launchdarkly.flag_target` | `variation_name` | immediate | no |
| `launchdarkly.flag_target` | `variation_value` | immediate | no |
| `http.resource` | `id` | immediate | no |
| `http.list_item` | (none) | | |
| `supabase.branch` | `project_ref` | immediate | no |
| `supabase.branch` | `api_url` | immediate | no |
| `supabase.branch` | `db_host` | immediate | no |
| `supabase.branch` | `connection_string` | immediate | yes |
| `supabase.auth_redirect` | `url` | immediate | no |
<!-- generated:outputs:end -->

### Once-only outputs

Some providers reveal a value only in the answer that creates a resource (a database password's plaintext). An op
declares such an output `once` (always together with `sensitive`). It reaches the lines that reference it in the
run that creates the resource. In a later run, when the resource already exists, a reference to it resolves to
`{ keep: true }`: a dependent that holds the value keeps it, and a dependent that would have to write it is refused
with `OUTPUT_UNAVAILABLE` before anything is written. A plan run shows such a dependent as unchanged (or blocked), never
pending forever. Nothing is re-created to get the value back; see
[ADR 0018](adr/0018-once-only-outputs.md).

## What is checked when

| When | Checks | Codes |
|---|---|---|
| Editing, with the schema | shape of every key; id format; value forms; secret-looking literals; display text; the built-in ops' parameter names and `target` values | (editor diagnostics) |
| Parsing (every command) | everything above that the parser enforces, plus unique ids, declared environments, `depends_on` and `from:` ids exist | `PLAN_PARSE`, `PLAN_INVALID`, `SECRET_LITERAL`, `REF_UNKNOWN` |
| Preparing a run (before any provider call) | `--env` declared; adapters and ops exist; references survive the environment filter; no cycles; referenced outputs exist; `${ctx.*}` resolves; approval | `ENV_UNKNOWN`, `ADAPTER_UNKNOWN`, `OP_UNKNOWN`, `REF_FILTERED`, `REF_CYCLE`, `REF_OUTPUT_UNKNOWN`, `CTX_NULL`, `ENV_NOT_APPROVED` (apply only) |
| Reading live state (per line) | parameter values; credentials; secrets resolve; drift; ownership by another scope; once-only outputs a line would need again | `PARAM_INVALID`, `PROVIDER_*`, `SECRET_UNRESOLVED`, `DRIFT_CHANGED`, `OWNED_BY_OTHER_SCOPE`, `OUTPUT_UNAVAILABLE` |

Every code is listed in [errors.md](errors.md).

### What the schema does not check

The schema checks each part of the file on its own. These need the whole document and are left to `sponson plan`
(`scenarios/docs/schema.test.ts` pins the list): duplicate ids; a line environment the top-level `environments` does
not declare; `depends_on` or `from:` naming an id that does not exist; referenced outputs; cycles; `${ctx.*}` names.

The schema is stricter than the parser in these places, each a likely typo the runtime would ignore or report later:
unknown top-level keys; unknown parameters of the built-in ops (for example `from: main` instead of `parent: main` on
`neon.branch`); and extra keys next to `from`, `secret` or `keep`.
