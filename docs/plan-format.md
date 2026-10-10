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
| `providers` | map: adapter name → map | `{}` | Static configuration per adapter, handed to the adapter as `providers.<adapter>`. Built-in: `vercel.project` (required by the Vercel ops), `vercel.team` (optional), `neon.project` (required by the Neon op). Clerk needs none. A missing required key fails the line with `PLAN_INVALID` when the adapter runs. |
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
| `adapter` | non-empty string | `neon`, `vercel`, `clerk`, or one added by a plugin (`SPONSON_PLUGINS`). Unknown: `ADAPTER_UNKNOWN`. |
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
<!-- generated:outputs:end -->

## What is checked when

| When | Checks | Codes |
|---|---|---|
| Editing, with the schema | shape of every key; id format; value forms; secret-looking literals; display text; the built-in ops' parameter names and `target` values | (editor diagnostics) |
| Parsing (every command) | everything above that the parser enforces, plus unique ids, declared environments, `depends_on` and `from:` ids exist | `PLAN_PARSE`, `PLAN_INVALID`, `SECRET_LITERAL`, `REF_UNKNOWN` |
| Preparing a run (before any provider call) | `--env` declared; adapters and ops exist; references survive the environment filter; no cycles; referenced outputs exist; `${ctx.*}` resolves; approval | `ENV_UNKNOWN`, `ADAPTER_UNKNOWN`, `OP_UNKNOWN`, `REF_FILTERED`, `REF_CYCLE`, `REF_OUTPUT_UNKNOWN`, `CTX_NULL`, `ENV_NOT_APPROVED` (apply only) |
| Reading live state (per line) | parameter values; credentials; secrets resolve; drift; ownership by another scope | `PARAM_INVALID`, `PROVIDER_*`, `SECRET_UNRESOLVED`, `DRIFT_CHANGED`, `OWNED_BY_OTHER_SCOPE` |

Every code is listed in [errors.md](errors.md).

### What the schema does not check

The schema checks each part of the file on its own. These need the whole document and are left to `sponson plan`
(`scenarios/docs/schema.test.ts` pins the list): duplicate ids; a line environment the top-level `environments` does
not declare; `depends_on` or `from:` naming an id that does not exist; referenced outputs; cycles; `${ctx.*}` names.

The schema is stricter than the parser in these places, each a likely typo the runtime would ignore or report later:
unknown top-level keys; unknown parameters of the built-in ops (for example `from: main` instead of `parent: main` on
`neon.branch`); and extra keys next to `from`, `secret` or `keep`.
