# Sponson GitHub Action

Runs `sponson plan`, `sponson apply` or `sponson apply --destroy` from `release.plan.yaml` and comments the result on the pull request. One action, one command, three triggers.

## Inputs

| input | default | meaning |
|---|---|---|
| `command` | `plan` | `plan`, `apply` or `destroy` (`destroy` runs `apply --destroy`) |
| `env` | `preview` | environment; `production` is never inferred from the branch |
| `approved-by` | | required for `env: production`; take it from an approval step, never from an agent |
| `plan` | `release.plan.yaml` | path to the plan |
| `version` | `latest` | version of the `sponson` npm package |
| `node-version` | `22` | Node.js version |
| `github-token` | `${{ github.token }}` | pushes receipts and comments on the PR |

Outputs: `result` (the CLI's JSON), `status` (`complete` / `partial` / `failed` for apply, `ok` / `error` for plan), `exit-code`.

The action exits with the CLI's exit code **after** posting the comment: `0` complete or partial, `1` failed, `2` plan invalid / environment unknown / not approved, `3` another apply holds the lock.

## Permissions

```yaml
permissions:
  contents: write        # receipts are pushed to the orphan branch sponson/receipts
  pull-requests: write   # the plan / receipt comment
```

## Example workflow

The same action handles all three moments of a preview environment's life. `apply` is idempotent and resumable: on `pull_request` it creates the database branch and injects variables, stops with status `partial` at the deploy barrier, and the `deployment_status` run finishes the lines that needed the preview URL.

```yaml
name: sponson
on:
  pull_request:
    types: [opened, synchronize, closed]
  deployment_status:

permissions:
  contents: write
  pull-requests: write
  deployments: read

concurrency:
  group: sponson-${{ github.event.pull_request.number || github.event.deployment.sha }}
  cancel-in-progress: false

jobs:
  preview:
    runs-on: ubuntu-latest
    # deployment_status fires for every state; only act on a finished deploy.
    if: github.event_name == 'pull_request' || github.event.deployment_status.state == 'success'
    steps:
      - uses: actions/checkout@v4
        with:
          # for deployment_status, check out the commit that was deployed
          ref: ${{ github.event.deployment.sha || github.sha }}

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
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
```

Provider credentials are the providers' own tokens, passed as environment variables. Sponson has no token of its own.

### Plan only on pull requests

```yaml
      - uses: sponson/sponson/action@v1
        with:
          command: plan
```

### Production, gated by an environment approval

```yaml
jobs:
  production:
    runs-on: ubuntu-latest
    environment: production   # GitHub's required reviewers gate this job
    steps:
      - uses: actions/checkout@v4
      - uses: sponson/sponson/action@v1
        with:
          command: apply
          env: production
          approved-by: ${{ github.actor }}
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

Symbols: `+` create/applied, `~` update, `=` unchanged, `?` pending/waiting, `-` blocked/skipped/destroyed, `!` error/failed.
