# Sponson on GitLab CI/CD

[gitlab-ci.yml](gitlab-ci.yml) runs Sponson in merge request pipelines: it plans and applies when a merge request is
opened or updated, finishes the lines that wait on the deploy, and destroys the preview resources when the merge
request is merged or closed. Production is a manual job on the default branch.

| Moment | Job | What runs |
|---|---|---|
| MR opened or updated | `sponson:plan` | `sponson plan` (read-only diff in the job log) |
| | `sponson:apply` | `sponson apply`: creates the database branch, injects variables, stops with status `partial` at the deploy barrier |
| | `sponson:finish` | `sponson apply --wait`: after your `deploy` stage (or the host's own deploy), finishes the lines that needed the preview URL |
| MR merged or closed | `sponson:destroy` | `sponson apply --destroy`, run by GitLab when it stops the `review/mr-<iid>` environment |
| Pipeline on the default branch | `sponson:production` | `sponson apply --env production`, a manual job; whoever starts it is the approver |

## Prerequisites

- GitLab 16 or later, with [merge request pipelines](https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/)
  (the template's `workflow:` switches to them for every branch with an open MR).
- A `release.plan.yaml` at the repository root (`sponson init` writes one).
- Runners that can pull `node:22` and reach npm and the providers' APIs.

## Setup

1. Copy [gitlab-ci.yml](gitlab-ci.yml) to `.gitlab-ci.yml`, or merge its `workflow:`, `stages:` and jobs into yours.
   Put your own deploy jobs in the `deploy` stage, if GitLab deploys the app.
2. Replace `0.4.0` with the Sponson version you have reviewed. Every job pins it, so an npm release never changes
   what runs.
3. Create the receipts token and the CI/CD variables below (**Settings → CI/CD → Variables**).
4. Protect the `production` environment (**Operate → Environments → Protected environments**) so only the people
   allowed to deploy can start `sponson:production`.

## Variables

| Variable | Flags | Value |
|---|---|---|
| `SPONSON_GITLAB_TOKEN` | masked, not protected | project access token with `write_repository` (below) |
| `VERCEL_TOKEN`, `NEON_API_KEY`, `CLERK_SECRET_KEY` | masked, not protected, environment scope `review/*` | the preview tokens; one per adapter your plan uses |
| the same names | masked, protected, environment scope `production` | the production tokens |
| every `env://NAME` a line references | masked, scoped like the tokens | the secret values |

Merge request pipelines of unprotected branches cannot read protected variables, so the preview tokens must not be
protected. Scoping them to `review/*` and the production ones to `production` keeps each job to its own tokens.
Every adapter's variable is listed under [built-in ops](../../docs/plan-format.md#built-in-ops).

## Receipts: push credentials

Sponson writes its receipts to orphan branches of the project, `sponson-receipts/<env>/<scope>`, from a clone of its
own. The job token (`CI_JOB_TOKEN`) cannot push to the repository, so the template points that clone at a token that
can:

1. **Settings → Access tokens → Add new token**: name `sponson-receipts`, role **Developer**, scope
   **`write_repository`** only, an expiry date you will rotate before.
2. Save it as the CI/CD variable `SPONSON_GITLAB_TOKEN` (masked).
3. The `.sponson` job template exports
   `SPONSON_RECEIPTS_REMOTE=${CI_SERVER_PROTOCOL}://oauth2:${SPONSON_GITLAB_TOKEN}@${CI_SERVER_HOST}:${CI_SERVER_PORT}/${CI_PROJECT_PATH}.git`.
   Sponson strips credentials from every git error it prints.

If a protected-branch rule matches `sponson-receipts/*` (for example `*`), allow Developers to push to it or give the
token the Maintainer role. The receipts branches carry no `.gitlab-ci.yml`, so pushing them starts no pipeline. To keep
receipts out of git instead, pass `--receipts local` and keep `.sponson/receipts` as a job artifact or cache; a fresh
runner then starts without the last run's receipt, so prefer the git store.

## How the flags are filled

Every job passes `--pr`, `--branch` and `--sha` from GitLab's predefined variables, so the template works with any
Sponson version:

| Flag | Variable |
|---|---|
| `--pr` | `CI_MERGE_REQUEST_IID` (the `!N` of the project) |
| `--branch` | `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` (`CI_COMMIT_BRANCH` on the default branch) |
| `--sha` | `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` in merged-results pipelines (the head that is deployed, not the synthetic merge commit), else `CI_COMMIT_SHA` |

Sponson releases after 0.4.0 read the same variables themselves when `GITLAB_CI` is set, so the flags may then be
dropped.

## Notes

- `sponson:destroy` is the environment's `on_stop` job. GitLab runs it when the merge request is merged or closed, and
  you can run it from the environment's page. It checks out the merge request's ref (`refs/merge-requests/<iid>/head`),
  which GitLab keeps after the source branch is deleted, so the plan file is there to destroy from.
- `interruptible: false` on the applying jobs: GitLab's auto-cancel of redundant pipelines must not kill an apply half
  way. A killed apply is resumed by the next one; a cancelled one is not rolled back.
- To clean up previews whose merge request is forgotten, add `auto_stop_in: 2 weeks` to the `environment:` of
  `sponson:apply` and `sponson:finish`.

<!-- sponson:embed gitlab-ci.yml -->
