# Sponson GitHub Action

Runs `sponson plan`, `sponson apply` or `sponson apply --destroy` from `release.plan.yaml` and comments the result on the pull request. One action, one command, three triggers.

**Pin the action to a commit.** Replace `<commit-sha>` with the full SHA of the Sponson commit you have reviewed
(`git rev-parse HEAD` in a checkout). Release tags will exist from the first release; a SHA is the only reference
nobody can move under you.

## Inputs

| input | default | meaning |
|---|---|---|
| `command` | `plan` | `plan`, `apply` or `destroy` (`destroy` runs `apply --destroy`) |
| `env` | `preview` | environment; `production` is never inferred from the branch |
| `approved-by` | | required when a line writes to production; take it from the environment approval (below), never from an agent |
| `plan` | `release.plan.yaml` | path to the plan |
| `version` | `source` | `source` runs Sponson from this action's own checkout (exactly the ref you pinned; nothing is fetched from a registry); or an npm version of `sponson` (e.g. `0.4.0`), installed with `npm install` into the runner's temporary directory |
| `node-version` | `22` | Node.js version |
| `github-token` | `${{ github.token }}` | pushes receipts and comments on the PR |

Outputs: `result` (the CLI's JSON envelope), `status` (`complete` / `partial` / `failed` / `stale` for apply, `ok` / `error` for plan), `exit-code`, `skipped`.

The action exits with the CLI's exit code **after** posting the comment: `0` complete or partial, `1` failed, `2` usage / plan invalid / environment unknown / not approved / a [manual step](../docs/plan-format.md#manualstep) waits for a person, `3` another apply holds the lock (or took it over).

Provider credentials are the providers' own tokens, passed as environment variables to **every** step that runs the action, `destroy` included: a destroy without tokens cannot delete anything. Sponson has no token of its own.

### When the action skips

For `deployment_status`, the scope is the **open** pull request associated with the deployed commit. When there is none (the PR was merged or closed before the build finished, or the branch never had a PR) the action skips: it sets `skipped: true`, prints a notice, and runs nothing. It never falls back to a closed PR, which would re-create a preview that `destroy` already removed. A deployment to Production never drives a `preview` run.

## Permissions

```yaml
permissions:
  contents: write        # receipts are pushed to the orphan branches sponson-receipts/<env>/<scope>
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
        uses: MishaBear94/Sponson/action@<commit-sha>
        with:
          command: destroy
          env: preview

      - name: Apply preview resources
        if: github.event_name != 'pull_request' || github.event.action != 'closed'
        uses: MishaBear94/Sponson/action@<commit-sha>
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

      - uses: MishaBear94/Sponson/action@<commit-sha>
        with:
          command: apply
          env: production
          approved-by: ${{ steps.approval.outputs.by }}
```

`PROD_*` are [environment secrets](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment#environment-secrets) of the `production` environment, so only the approved job can read them: production provider tokens, and every value a production line references with `{ secret: "env://NAME" }`. Use separate tokens for preview and production when the providers allow it.

On a push the action passes no scope flags; the CLI reads the GitHub context (`GITHUB_REF_NAME`, `GITHUB_SHA`) and a push to the default branch is scope `main`. Without an approver the CLI refuses with `ENV_NOT_APPROVED` and writes nothing.

### Plan only on pull requests

```yaml
      - uses: MishaBear94/Sponson/action@<commit-sha>
        with:
          command: plan
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
```

## The PR comment

One comment per environment, marked with `<!-- sponson:<env> -->` and updated in place on every run. It is written for
the reviewer: a headline that says what this pull request's preview has, then one line per plan line with a link to
the provider's console where Sponson knows one, the preview URL as a link, and what a waiting line waits for. Values
are never shown: resources by name, inputs as references (`DATABASE_URL ← db.connection_string`), secrets as
`(secret)`. A refusal, a failure or drift is one sentence with the fix (`sponson apply --reconcile`,
`--approved-by <who>`, `sponson apply --confirm <line>`).

After `apply` on a pull request:

```markdown
<!-- sponson:preview -->
### Sponson: the preview for pr-42 is ready

This preview has its own database branch, 2 variables and 1 auth callback.

**Preview:** [https://acme-web-git-feat-x.vercel.app](https://acme-web-git-feat-x.vercel.app)

- `db` Neon branch sponson/preview/pr-42 — set up in this run · [console](https://console.neon.tech/app/projects/proj_demo/branches/br-11)
- `env` 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`, values not shown — set up in this run · [console](https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables)
- `callback` Clerk redirect https://acme-web-git-feat-x.vercel.app — set up in this run · [console](https://dashboard.clerk.com)

<sub>apply run-1a2b3c4d · plan 1e5d99ef · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```

Before the preview deploy finished, the same comment said `is almost ready`, `Still to come: 1 auth callback, once
the preview deploy finishes (nothing to retry)`, and listed the callback as `waits for the preview deploy`.

When the pull request closes (`destroy`):

```markdown
<!-- sponson:preview -->
### Sponson cleaned up the preview for pr-42

**Cleaned up:** Clerk redirect https://acme-web-git-feat-x.vercel.app; 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`; Neon branch sponson/preview/pr-42.

**Kept (adopted, never destroyed):** nothing.

**Left for you:** nothing.

<sub>destroy destroy-5e6f7a8b · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```

`Kept` lists what existed before Sponson and was adopted: destroy forgets it and never deletes it. `Left for you` lists
what a person has to finish: a delete the provider refused (with the error and the fix), something re-created outside
Sponson under the same name, or the undo of a [manual step](../docs/plan-format.md#manualstep).

A manual step that nobody has done yet is listed under the lines with its instructions, whole, and the command a person
runs once they did it (`sponson apply --confirm <line>`); the job stays red (exit 2) until then.

Console links: Neon links the branch, Vercel the project's Environment Variables page (through Vercel's dashboard
link, which asks for the team and project), Clerk the dashboard, and a [recipe](../docs/recipes.md) line its op's
`console_url` when the recipe declares one. They come from `receipt.lines[id].consoleUrl` in the JSON result.

How the comment is made: the action runs the CLI with `--json` (that JSON is the `result` output), then renders the
comment from it with Sponson's own renderer (`render-comment.mjs`, the function behind
`sponson plan|apply --format markdown`), so the comment and the CLI never disagree. Everything that comes from a
provider (error messages, labels) is HTML-escaped and kept on its line, so an HTML error page or a stray backtick
cannot open a tag or hide the rest of the comment. A comment that would exceed GitHub's 65,536 characters keeps its
title and headline and leaves out the lines and sections that do not fit, saying so; the run log and the `result`
output have everything. With a `version` older than the renderer, the action posts a one-line summary instead.

The same markdown outside this action: `sponson apply --format markdown > comment.md` (GitLab, CircleCI, Bitbucket:
[integrations](../integrations/README.md#the-pull-request-comment)), or `renderMarkdown(envelope)` from the `sponson`
package on a `--json` result you already have.
