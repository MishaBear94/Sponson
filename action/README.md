# Sponson GitHub Action

Runs `sponson plan`, `sponson apply` or `sponson apply --destroy` from `release.plan.yaml` and comments the result on the pull request. One action, one command, three triggers.

**Pin the action to a commit.** A commit SHA is the only reference nobody can move under you. `sponson init --setup`
writes the workflow with `<commit-sha>` filled in: the commit the installed version's release tag (`sponson@<version>`)
points at. To pin by hand, read that commit with
`git ls-remote https://github.com/MishaBear94/Sponson 'refs/tags/sponson@<version>^{}'` (`uses:` cannot name the tag
itself: GitHub splits a reference at its `@`).

## Inputs

| input | default | meaning |
|---|---|---|
| `command` | `plan` | `plan`, `apply` or `destroy` (`destroy` runs `apply --destroy`) |
| `env` | `preview` | environment; `production` is never inferred from the branch |
| `approved-by` | | required when a line writes to production; take it from the environment approval (below), never from an agent |
| `plan` | `release.plan.yaml` | path to the plan |
| `version` | `source` | `source` runs Sponson from this action's own checkout (exactly the ref you pinned; nothing is fetched from a registry); or an npm version of `sponson` (the one you reviewed, as `sponson --version` prints it), installed with `npm install` into the runner's temporary directory |
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
the reviewer: a headline that says what this pull request's preview has (on a plan: what it already has, and what
applying would add), then one line per plan line with a link to the provider's console where Sponson knows one, the
preview URL as a link, and what a waiting line waits for. Values are never shown: resources by name, inputs as
references (`DATABASE_URL ← db.connection_string`), labelled by what they are in the plan: a `{ secret }` reference as
`(secret)`, another value that is never shown (a connection string from `{ from }`) as `(value hidden)`, a literal
with no label. A refused or failed line says what happened and then the fix, once (`sponson apply --reconcile`,
`--approved-by <who>`, `sponson apply --confirm <line>`): a resource changed outside Sponson says so next to its name,
and nowhere else. A line held back only because a line it depends on was refused is counted apart and has no fix of
its own.

The examples below are real comments: the PR comment suite (`scenarios/journeys/secrets/pr-comment.test.ts`) renders
them from `--json` output against the fake cloud, and `pnpm docs:gen` copies its snapshots here, so they cannot go
stale. The plan is the README's (a Neon branch, two Vercel variables, a Clerk callback).

While the preview deploy has not finished (`apply` on `opened`; the `deployment_status` run finishes the callback):

<!-- generated:comment-apply-partial:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:preview -->
### Sponson: the preview for pr-42 is almost ready

This preview has its own database branch and 2 variables.

Still to come: 1 auth callback, once the preview deploy finishes (nothing to retry).

- `db` Neon branch sponson/preview/pr-42 — set up in this run · [console](https://console.neon.tech/app/projects/proj_demo/branches/br-11)
- `env` 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`, values not shown — set up in this run · [console](https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables)
- `callback` auth callback — waits for the preview deploy: the run after the deploy finishes it, nothing to retry

<sub>apply run-1a2b3c4d · plan 1e5d99ef · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-apply-partial:end -->

After the deploy, the same comment:

<!-- generated:comment-apply-complete:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:preview -->
### Sponson: the preview for pr-42 is ready

This preview has its own database branch, 2 variables and 1 auth callback.

**Preview:** [https://prj\_demo-01234567.vercel.app](https://prj_demo-01234567.vercel.app)

- `db` Neon branch sponson/preview/pr-42 — unchanged · [console](https://console.neon.tech/app/projects/proj_demo/branches/br-11)
- `env` 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`, values not shown — unchanged · [console](https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables)
- `callback` Clerk redirect https://prj\_demo-01234567.vercel.app — set up in this run · [console](https://dashboard.clerk.com)

<sub>apply run-1a2b3c4d · plan 1e5d99ef · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-apply-complete:end -->

Someone edited `DATABASE_URL` in the Vercel console (`plan`; an `apply` refuses the same line the same way):

<!-- generated:comment-plan-drift:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:preview -->
### Sponson plan: the preview for pr-42

This preview already has its own database branch.

**1 line is refused**, and 1 line that depends on it is held back: see below for why and how to fix it.

- `db` Neon branch sponson/preview/pr-42 — up to date
- `env` 2 variables (preview, feat/x): `DATABASE_URL` ← `db.connection_string` (value hidden; changed outside Sponson) and `STRIPE_KEY` — refused (`DRIFT_CHANGED`) **Fix:** Keep that change by updating the plan, or overwrite it with `sponson apply --reconcile`.
- `callback` auth callback — held back: depends on `env`, which cannot be applied (`DEPENDENCY_BLOCKED`)

<sub>plan 1e5d99ef · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-plan-drift:end -->

A line waits on a [manual step](../docs/plan-format.md#manualstep) (the job stays red, exit 2, until a person confirms
it):

<!-- generated:comment-apply-manual-step:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:preview -->
### Sponson: the preview for pr-42 waits for a person

This preview has 1 variable.

Still to come: 1 manual step.

**Preview:** [https://prj\_demo-01234567.vercel.app](https://prj_demo-01234567.vercel.app)

- `env` MODE (preview, feat/x), values not shown — set up in this run · [console](https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables)
- `google-redirect` manual step — waits for a person to do the manual step below

**Manual steps waiting for a person** (no API can do these; a person does them, agents never confirm them)

- `google-redirect` Allow the callback on the Google OAuth client

<pre>1. Open the client "acme-web".
2. Add https://prj_demo-01234567.vercel.app/cb to its authorized redirect URIs and save.</pre>

  Then a person confirms it: `sponson apply --confirm google-redirect`

<sub>apply run-1a2b3c4d · plan 1e5d99ef · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-apply-manual-step:end -->

A production run without an approver, refused before anything is touched:

<!-- generated:comment-apply-refused-production:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:production -->
### Sponson apply refused: `ENV_NOT_APPROVED`

This run applies to production, and nobody approved it.

**Fix:** Production needs a person's approval: run it with `--approved-by <who>` from your approval workflow, never from an agent.

Nothing was written.

<sub>[run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-apply-refused-production:end -->

When the pull request closes (`destroy`):

<!-- generated:comment-destroy:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:preview -->
### Sponson cleaned up the preview for pr-42

**Cleaned up:** Clerk redirect https://prj\_demo-01234567.vercel.app; 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`; Neon branch sponson/preview/pr-42.

**Kept (adopted, never destroyed):** nothing.

**Left for you:** nothing.

<sub>destroy destroy-5e6f7a8b · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-destroy:end -->

`Kept` lists what existed before Sponson and was adopted: destroy forgets it and never deletes it. `Left for you` lists
what a person has to finish: a delete the provider refused (with the error and the fix), something re-created outside
Sponson under the same name, or the undo of a [manual step](../docs/plan-format.md#manualstep).

A manual step that nobody has done yet is listed under the lines with its instructions, whole, and the command a person
runs once they did it (`sponson apply --confirm <line>`); the job stays red (exit 2) until then.

A resource Sponson created that someone edited since the last apply is deleted on destroy too (the pull request is
closing), and the comment's warnings name it. The receipt records it under the line's `notes.changedOutside`. When the
pull request closes with the `DATABASE_URL` edit above still there:

<!-- generated:comment-destroy-changed:start (scripts/gen-docs.ts; run `pnpm docs:gen`) -->
```markdown
<!-- sponson:preview -->
### Sponson cleaned up the preview for pr-42

**Cleaned up:** Clerk redirect https://prj\_demo-01234567.vercel.app; 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`; Neon branch sponson/preview/pr-42.

**Kept (adopted, never destroyed):** nothing.

**Left for you:** nothing.

**Warnings**

- `env`: DATABASE\_URL (preview, feat/x) was changed outside Sponson since the last apply; deleted anyway (Sponson created it, and this scope is being destroyed).

<sub>destroy destroy-5e6f7a8b · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
```
<!-- generated:comment-destroy-changed:end -->

Console links: Neon links the branch, Vercel the project's Environment Variables page, Clerk the dashboard, and a
[recipe](../docs/recipes.md) line its op's `console_url` when the recipe declares one. They come from
`receipt.lines[id].consoleUrl` in the JSON result. Vercel's link goes through its documented dashboard link, which
asks the person for the team and project: Vercel's dashboard addresses a project by team slug and project name, and
documents no page URL by the project id the plan holds. Clerk documents no dashboard URL deeper than its root.

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
