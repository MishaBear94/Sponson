# Example plans

Each file is a complete `release.plan.yaml`. Copy one to the root of your repository as `release.plan.yaml`, replace
the provider ids, and run `sponson plan`. Every example is checked by `scenarios/docs/examples.test.ts`: it must parse
and plan cleanly against the local fake cloud in every environment it declares, and validate against
[the schema](../schema/release.plan.schema.json).

The format is specified in [docs/plan-format.md](../docs/plan-format.md).

| File | Shows |
|---|---|
| [nextjs-neon-preview.plan.yaml](nextjs-neon-preview.plan.yaml) | a database branch per pull request, wired into preview variables |
| [nextjs-planetscale-preview.plan.yaml](nextjs-planetscale-preview.plan.yaml) | a PlanetScale branch and password per pull request; a once-only output |
| [nextjs-supabase-preview.plan.yaml](nextjs-supabase-preview.plan.yaml) | a Supabase preview branch per pull request; its URL and connection string in preview variables; an Auth redirect on the branch |
| [vercel-shared-and-branch-vars.plan.yaml](vercel-shared-and-branch-vars.plan.yaml) | project-wide, per-branch and production variables; `${ctx.*}` |
| [clerk-preview-callbacks.plan.yaml](clerk-preview-callbacks.plan.yaml) | a value that exists only after the deploy; `partial` runs |
| [launchdarkly-preview-flags.plan.yaml](launchdarkly-preview-flags.plan.yaml) | flags on for a preview: its URL or the scope as the target; a variation by name |
| [explicit-deploy.plan.yaml](explicit-deploy.plan.yaml) | Sponson starting the deploy; `depends_on` |
| [production-with-approval.plan.yaml](production-with-approval.plan.yaml) | preview and production in one file; approval |
| [adopting-an-existing-project.plan.yaml](adopting-an-existing-project.plan.yaml) | what `sponson init` writes when it adopts; `{ keep: true }` |
| [http-flags-webhooks-allowlists.plan.yaml](http-flags-webhooks-allowlists.plan.yaml) | APIs with no adapter of their own, through the generic `http` adapter (illustrative) |

## nextjs-neon-preview.plan.yaml

The smallest useful plan. `db` creates a Neon branch named `sponson/preview/<scope>` from `main`; `env` writes
`DATABASE_URL` (from the branch's sensitive `connection_string`), a host, a secret and a literal into the preview
target for the current git branch.

```text
$ sponson plan --pr 42
sponson plan · preview · pr-42 · plan 6fb910c2

+ db   neon.branch  create   Neon branch sponson/preview/pr-42  sponson/preview/pr-42
? env  vercel.env   pending  waiting on `db`
    + DATABASE_URL (preview, feat/checkout)  (pending ← db.connection_string)
    + DATABASE_HOST (preview, feat/checkout)  (pending ← db.host)
    + STRIPE_SECRET_KEY (preview, feat/checkout)  (secret)
    + NEXT_PUBLIC_STAGE (preview, feat/checkout)  (secret)

1 to create, 1 pending
```

Every Vercel variable is shown as `(secret)` in the diff: the adapter treats all of them as sensitive.

`env` is `pending` until `db` exists; one `apply` creates both, in that order. Closing the pull request and running
`sponson apply --destroy` deletes the variables and then the branch.

## nextjs-planetscale-preview.plan.yaml

The same shape with PlanetScale. `db` creates a development branch `sponson-preview-<scope>` from `main` and waits
until PlanetScale reports it ready; `dbpw` creates a password on it; `env` writes the password's `connection_string`
to `DATABASE_URL`. On the first plan, `dbpw` and `env` are `pending`; one `apply` creates all three, in that order.

PlanetScale shows a password's plaintext only when it is created, so `connection_string` is a
[once-only output](../docs/plan-format.md#once-only-outputs). `env` receives it in the run that creates the password.
On every later run, `env` keeps the value it holds: the plan shows all three lines unchanged and `apply` writes nothing.
If `DATABASE_URL` is deleted in Vercel, `env` is refused with `OUTPUT_UNAVAILABLE`, because no later run can read the
value again. Sponson does not rotate the password on its own. To get a new one, delete the password in PlanetScale:
the next `apply` creates a new password and writes its connection string. `sponson apply --destroy` deletes the
variable, then the password, then the branch.

## nextjs-supabase-preview.plan.yaml

The Supabase version of the plan above. `db` creates a Supabase preview branch named `sponson-preview-<scope>` on the
project (branching must be enabled on it) and waits until it is `ACTIVE_HEALTHY`; `env` writes its sensitive
`connection_string` and its `api_url` into the preview target for the current git branch; `auth_callback` puts the
preview URL on the branch's own Auth redirect allow-list, because a branch is a project with its own Auth settings.
Without `project:`, an `auth_redirect` line edits the allow-list of `providers.supabase.project` instead, leaving every
entry Sponson did not add in place.

The branch's API keys are not an output yet, so the example passes the anon key as a secret.
`sponson apply --destroy` removes the redirect, the variables, then the branch.

## vercel-shared-and-branch-vars.plan.yaml

Three levels of Vercel variables:

- `branch: "*"` writes project-wide preview variables that every preview deployment sees.
- Without `branch:`, preview variables apply to the current git branch only.
- `target: production` writes production variables; that line is filtered to `environments: [production]`.

Project-wide variables are owned by the scope that applied them first and are destroyed with it. Apply this plan from
the default branch (scope `main`) before pull requests use it; pull request scopes then rely on the shared variables
without owning them, and a pull request that tries to change one is refused with `OWNED_BY_OTHER_SCOPE`.

## clerk-preview-callbacks.plan.yaml

`callback` reads `env.preview_url`, which only exists once Vercel's deployment of this commit is `READY`. The first
`apply` creates the branch and the variables, then stops:

```text
$ sponson apply
...
? callback  clerk.redirect_allow  waiting    waiting on deploy

apply partial: waiting on deploy for lines callback
```

In `--json`, `receipt.status` is `partial` and `receipt.lines.callback` has `status: "waiting"` and
`waitingFor: "deploy"`.

Exit code 0. Run `sponson apply` again after the deploy (the README's workflow does it on `deployment_status`) and the
callback is registered. With `--wait`, one `apply` polls until the deploy finishes instead. If the deploy fails, the
callback is `skipped` with `EXTERNAL_FAILED` and the branch and variables stay.

## launchdarkly-preview-flags.plan.yaml

Two individual targets on flags that already exist in the LaunchDarkly project `acme-web`, environment `preview`.
`checkout` serves `new-checkout` = `true` to the context of kind `url` whose key is the preview URL, so like the Clerk
callback above it waits for the deploy; `pricing` serves the variation named `Treatment` of `pricing-page` to the user
key `pr-42` (the scope) and is applied at once. `apply --destroy` removes exactly these two targets; the flags, their
rules and everyone else's targets stay. A target moved to another variation in the LaunchDarkly console is `changed`
drift, refused until `--reconcile`.

## explicit-deploy.plan.yaml

A `vercel.deploy` line starts the deployment after the variables are written (`depends_on: [env]`), and its
`preview_url` is available as soon as the line is applied, so one `apply` runs to the end and waits for the build (up
to `SPONSON_DEPLOY_TIMEOUT_MS`, default 120 seconds). Use it when automatic preview deployments are turned off in
Vercel; with them on, prefer the previous example.

## production-with-approval.plan.yaml

Preview lines use a per-PR database; the production line takes its values from secrets. Applying production:

```bash
sponson plan  --env production              # read-only; reports requiresApproval: true
sponson apply --env production              # refused: ENV_NOT_APPROVED (exit 2), nothing written
sponson apply --env production --approved-by alice
```

`--approved-by` (or `SPONSON_APPROVED_BY`) should come from a person or an approval workflow, never from an agent.
The approver is recorded in the receipt as `approvedBy`.

## adopting-an-existing-project.plan.yaml

What `sponson init` appends to an existing plan when it finds resources no scope manages: variables become
`{ keep: true }`, grouped by target and git branch; an existing Neon branch is adopted by its `name:`. Nothing live
changes, and adopted resources are never destroyed. Run `sponson init --adopt <key>` to adopt a single resource; the
keys are listed under `drift` (`kind: unmanaged`) in `sponson plan --json`.

## http-flags-webhooks-allowlists.plan.yaml

**Illustrative.** The generic `http` adapter managing what has no Sponson adapter: a feature gate per pull request
(`http.resource`, located by name), a test-mode webhook endpoint (form-encoded, with an idempotency key and a
sensitive output), the preview URL on an application's allowed web origins (`http.list_item`, an item of a JSON
array), and a callback on a comma-separated redirect allow-list (`shape: delimited`). Each API is a block under
`providers.http` naming its credential's environment variable. The endpoints follow the providers' published API
references as we understand them; plan against the real API (`sponson plan` only reads) before the first apply.
`apply --destroy` removes the gate, the endpoint and the two list items, and leaves every other origin and
redirect as it was. Reference: [`http.resource`](../docs/plan-format.md#httpresource),
[`http.list_item`](../docs/plan-format.md#httplist_item).
