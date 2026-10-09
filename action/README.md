# Sponson GitHub Action

Runs `sponson plan`, `sponson apply` or `sponson apply --destroy` from `release.plan.yaml` and comments the result on the pull request. One action, one command, three triggers.

## Inputs

| input | default | meaning |
|---|---|---|
| `command` | `plan` | `plan`, `apply` or `destroy` (`destroy` runs `apply --destroy`) |
| `env` | `preview` | environment; `production` is never inferred from the branch |
| `approved-by` | | required when a line writes to production; take it from the environment approval (below), never from an agent |
| `plan` | `release.plan.yaml` | path to the plan |
| `version` | `latest` | version of the `sponson` npm package |
| `node-version` | `22` | Node.js version |
| `github-token` | `${{ github.token }}` | pushes receipts and comments on the PR |

Outputs: `result` (the CLI's JSON envelope), `status` (`complete` / `partial` / `failed` / `stale` for apply, `ok` / `error` for plan), `exit-code`, `skipped`.

The action exits with the CLI's exit code **after** posting the comment: `0` complete or partial, `1` failed, `2` usage / plan invalid / environment unknown / not approved, `3` another apply holds the lock (or took it over).

Provider credentials are the providers' own tokens, passed as environment variables to **every** step that runs the action, `destroy` included: a destroy without tokens cannot delete anything. Sponson has no token of its own.

### When the action skips

For `deployment_status`, the scope is the **open** pull request associated with the deployed commit. When there is none (the PR was merged or closed before the build finished, or the branch never had a PR) the action skips: it sets `skipped: true`, prints a notice, and runs nothing. It never falls back to a closed PR, which would re-create a preview that `destroy` already removed. A deployment to Production never drives a `preview` run.

## Permissions

```yaml
permissions:
  contents: write        # receipts are pushed to the orphan branch sponson/receipts
  pull-requests: write   # the plan / receipt comment
  deployments: read      # deployment_status payloads
  actions: read          # production job: read who approved the environment
```

## Example workflow

The same action handles every moment of a preview environment's life, and production on push to main. `apply` is idempotent and resumable: on `pull_request` it creates the database branch and injects variables, stops with status `partial` at the deploy barrier, and the `deployment_status` run of the **preview** deployment finishes the lines that needed the preview URL.

```yaml
name: sponson
on:
  pull_request:
    types: [opened, synchronize, closed]
  deployment_status:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write
  deployments: read
  actions: read

concurrency:
  group: sponson-${{ github.event.pull_request.number || github.event.deployment.sha || github.ref }}
  cancel-in-progress: false

jobs:
  preview:
    runs-on: ubuntu-latest
    # deployment_status fires for every state and every environment: act only on a finished preview deploy.
    if: >-
      github.event_name == 'pull_request' ||
      (github.event_name == 'deployment_status' &&
       github.event.deployment_status.state == 'success' &&
       github.event.deployment.environment != 'Production' &&
       github.event.deployment.environment != 'production')
    # Every step below needs the provider tokens, destroy included.
    env:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          # for deployment_status, check out the commit that was deployed
          ref: ${{ github.event.deployment.sha || github.sha }}
          # full history lets Sponson recognise a late build of an older commit
          fetch-depth: 0

      - name: Destroy preview resources
        if: github.event_name == 'pull_request' && github.event.action == 'closed'
        uses: sponson/sponson/action@v1
        with:
          command: destroy
          env: preview

      - name: Apply preview resources
        if: github.event_name != 'pull_request' || github.event.action != 'closed'
        uses: sponson/sponson/action@v1
        with:
          command: apply
          env: preview

  production:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    # Required reviewers on the `production` environment gate this job; the approver is read back below.
    environment: production
    env:
      NEON_API_KEY: ${{ secrets.PROD_NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.PROD_VERCEL_TOKEN }}
      CLERK_SECRET_KEY: ${{ secrets.PROD_CLERK_SECRET_KEY }}
      # every `secret: env://...` the production lines reference
      PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # full history: lets Sponson recognise a late build of an older commit

      - name: Who approved this deployment
        id: approval
        uses: actions/github-script@v7
        with:
          script: |
            const { data } = await github.rest.actions.getReviewsForRun({ ...context.repo, run_id: context.runId });
            const by = data.filter((r) => r.state === "approved" && r.environments.some((e) => e.name === "production")).map((r) => r.user.login);
            if (by.length === 0) core.setFailed("no approval recorded for the production environment");
            core.setOutput("by", by.join(", "));

      - uses: sponson/sponson/action@v1
        with:
          command: apply
          env: production
          approved-by: ${{ steps.approval.outputs.by }}
```

`PROD_*` are [environment secrets](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment#environment-secrets) of the `production` environment, so only the approved job can read them: production provider tokens, and every value a production line references with `{ secret: "env://NAME" }`. Use separate tokens for preview and production when the providers allow it.

On a push the action passes no scope flags; the CLI reads the GitHub context (`GITHUB_REF_NAME`, `GITHUB_SHA`) and a push to the default branch is scope `main`. Without an approver the CLI refuses with `ENV_NOT_APPROVED` and writes nothing.

### Plan only on pull requests

```yaml
      - uses: sponson/sponson/action@v1
        with:
          command: plan
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
```

## The PR comment

One comment per environment, marked with `<!-- sponson:<env> -->` and updated in place on every run:

```
### Sponson apply · preview · pr-42 · partial (run run-1a2b3c4d)

|   | line     | adapter          | status  | detail                                 |
|---|----------|------------------|---------|----------------------------------------|
| + | db       | neon.branch      | applied | Neon branch sponson/preview/pr-42      |
| + | env      | vercel.env       | applied | DATABASE_URL (preview)                 |
| ? | callback | clerk.redirect_allow | waiting | waiting on deploy                  |

Some lines are waiting on a deploy. The deployment_status run will finish them; nothing to retry.
```

Symbols: `+` create/applied, `~` update, `=` unchanged, `?` pending/waiting, `-` blocked/skipped/rolled back/destroyed, `!` error/failed.

Everything that comes from a provider (error messages, drift, labels) is HTML-escaped and flattened to one line in the comment, so an HTML error page, a CRLF or a `|` cannot break the table, open a tag or hide the rest of the comment.
