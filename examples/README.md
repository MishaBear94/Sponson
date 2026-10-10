# Example plans

Each file is a complete `release.plan.yaml`. Copy one to the root of your repository as `release.plan.yaml`, replace
the provider ids, and run `sponson plan`. Every example is checked by `scenarios/docs/examples.test.ts`: it must parse
and plan cleanly against the local fake cloud in every environment it declares, and validate against
[the schema](../schema/release.plan.schema.json).

The format is specified in [docs/plan-format.md](../docs/plan-format.md).

| File | Shows |
|---|---|
| [nextjs-neon-preview.plan.yaml](nextjs-neon-preview.plan.yaml) | a database branch per pull request, wired into preview variables |
| [vercel-shared-and-branch-vars.plan.yaml](vercel-shared-and-branch-vars.plan.yaml) | project-wide, per-branch and production variables; `${ctx.*}` |
| [clerk-preview-callbacks.plan.yaml](clerk-preview-callbacks.plan.yaml) | a value that exists only after the deploy; `partial` runs |
| [explicit-deploy.plan.yaml](explicit-deploy.plan.yaml) | Sponson starting the deploy; `depends_on` |
| [production-with-approval.plan.yaml](production-with-approval.plan.yaml) | preview and production in one file; approval |
| [adopting-an-existing-project.plan.yaml](adopting-an-existing-project.plan.yaml) | what `sponson init` writes when it adopts; `{ keep: true }` |
| [netlify-neon-preview.plan.yaml](netlify-neon-preview.plan.yaml) | Netlify values per deploy context; the Deploy Preview URL |

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

## netlify-neon-preview.plan.yaml

The Neon branch per pull request on a Netlify site. Netlify stores one variable per name with one value per deploy
context; a `netlify.env` line owns one context's value of each variable it declares, so values a human set for other
contexts are never read, changed or deleted. In previews the line writes the value for the pull request's git branch
(`context: branch`), which Netlify uses for that branch's Deploy Previews; `context: deploy-preview` would instead
be one value shared by every pull request.

`callback` reads `env.deploy_preview_url`, the pull request's `https://deploy-preview-<n>--<site>.netlify.app`. Like
Vercel's `preview_url`, it exists only once the Deploy Preview of this commit is ready, and only a deploy that
started after the variables were written counts: a build reads the values set when it started.
