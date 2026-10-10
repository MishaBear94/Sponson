# Sponson on CircleCI

[config.yml](config.yml) runs Sponson on every push to a branch with an open pull request, finishes the lines that
wait on the deploy, and applies production after a human approves a hold job on `main`. CircleCI has no "pull request
closed" trigger, so destroying a preview is a pipeline you start through the API (below).

| Moment | Workflow, job | What runs |
|---|---|---|
| Push to a branch with an open PR | `sponson-preview`: `sponson-plan`, `sponson-apply`, `sponson-finish` | plan; apply (stops with status `partial` at the deploy barrier); `apply --wait` (finishes the lines that needed the preview URL) |
| PR merged or closed | `sponson-destroy` | `sponson apply --destroy`, when the pipeline parameter `sponson-destroy-pr` is set |
| Push to `main` | `sponson-production`: `hold`, `sponson-production` | `sponson apply --env production --approved-by <who approved hold>` |

Jobs on a branch without an open pull request stop at their first step (`circleci-agent step halt`) and succeed.

## Prerequisites

- A project on CircleCI with the repository on GitHub. For Bitbucket, change the receipts remote (below).
- A `release.plan.yaml` at the repository root (`sponson init` writes one).
- The docker image `cimg/node:lts` (Node.js 22 or later).

## Setup

1. Copy [config.yml](config.yml) to `.circleci/config.yml`, or merge its parameters, commands, jobs and workflows
   into yours. If CircleCI deploys the app, put your deploy jobs between `sponson-apply` and `sponson-finish`.
2. Replace `0.4.0` with the Sponson version you have reviewed.
3. Create two [contexts](https://circleci.com/docs/contexts/) (**Organization Settings → Contexts**) with the
   variables below. Restrict `sponson-production` to a security group of the people allowed to deploy.

## Variables

| Context | Variable | Value |
|---|---|---|
| both | `SPONSON_GIT_TOKEN` | a token that may push to the repository (below) |
| `sponson-preview` | `VERCEL_TOKEN`, `NEON_API_KEY`, `CLERK_SECRET_KEY` | the preview tokens; one per adapter your plan uses |
| `sponson-production` | the same names | the production tokens |
| `sponson-production` | `CIRCLE_TOKEN` | a CircleCI personal API token, to read who approved `hold` |
| either | every `env://NAME` a line references | the secret values |

Every adapter's variable is listed under [built-in ops](../../docs/plan-format.md#built-in-ops).

## Receipts: push credentials

Sponson writes its receipts to orphan branches of the repository, `sponson-receipts/<env>/<scope>`, from a clone of
its own. CircleCI checks out with a read-only deploy key, so the template points that clone at a token that can push:

- **GitHub:** a fine-grained personal access token (or a GitHub App installation token) for this repository only,
  with **Contents: Read and write**. The `sponson-setup` command exports
  `SPONSON_RECEIPTS_REMOTE=https://x-access-token:${SPONSON_GIT_TOKEN}@github.com/${CIRCLE_PROJECT_USERNAME}/${CIRCLE_PROJECT_REPONAME}.git`.
- **Bitbucket:** a repository access token with **Repositories: Write**, and the remote
  `https://x-token-auth:${SPONSON_GIT_TOKEN}@bitbucket.org/${CIRCLE_PROJECT_USERNAME}/${CIRCLE_PROJECT_REPONAME}.git`.
- **SSH instead of a token:** add a read-write deploy key under **Project Settings → SSH Keys**, load it with
  `add_ssh_keys` before `checkout`, and delete the `Receipts remote` step: Sponson then pushes to `origin`.

Sponson strips credentials from every git error it prints. The receipts branches carry no `.circleci/config.yml`;
if CircleCI reports a failed pipeline for each receipts push, turn on **Only build pull requests** in the project's
advanced settings.

## Destroying a closed pull request's preview

Start a pipeline on `main` with both parameters set, for example from a GitHub workflow on `pull_request: closed`, a
chat command, or by hand:

```bash
curl -fsS -X POST "https://circleci.com/api/v2/project/gh/<org>/<repo>/pipeline" \
  -H "Circle-Token: $CIRCLE_TOKEN" -H "Content-Type: application/json" \
  -d '{"branch": "main", "parameters": {"sponson-destroy-pr": "42", "sponson-destroy-branch": "feat/x"}}'
```

The scope is `pr-42` whatever branch the pipeline runs on; running it on `main` works after the PR's branch is
deleted. Only the `sponson-destroy` workflow runs when `sponson-destroy-pr` is set.

## How the flags are filled

| Flag | Variable |
|---|---|
| `--pr` | the number at the end of `CIRCLE_PULL_REQUEST` (`${CIRCLE_PULL_REQUEST##*/}`) |
| `--branch` | `CIRCLE_BRANCH` |
| `--sha` | `CIRCLE_SHA1` |

Sponson releases after 0.4.0 read the same variables themselves when `CIRCLECI` is set (and `CIRCLE_PR_NUMBER` for
pull requests from forks), so the flags may then be dropped.

## Notes

- `CIRCLE_PULL_REQUEST` is only set when the pull request already existed when the pipeline started. A branch pushed
  before its PR was opened gets its first preview on the next push.
- CircleCI has no variable naming who approved a hold job. `sponson-production` reads it from the API (the hold
  job's `approved_by`, then the user's `login`) and fails when no approval is recorded; Sponson refuses a production
  apply without an approver in any case.
- Projects that use CircleCI's GitHub App integration trigger pipelines differently from the `/pipeline` endpoint
  above; see CircleCI's documentation for triggering a pipeline with parameters.

<!-- sponson:embed config.yml -->
