# Sponson on Bitbucket Pipelines

[bitbucket-pipelines.yml](bitbucket-pipelines.yml) runs Sponson in pull request pipelines, finishes the lines that
wait on the deploy, and applies production in a manual step on `main`. Bitbucket Pipelines has no "pull request
merged or declined" trigger, so destroying a preview is a custom pipeline you run (below).

| Moment | Pipeline, step | What runs |
|---|---|---|
| PR created or updated | `pull-requests`: `sponson plan`, `sponson apply`, `sponson finish` | plan; apply (stops with status `partial` at the deploy barrier); `apply --wait` (finishes the lines that needed the preview URL) |
| PR merged or declined | `custom: sponson-destroy` | `sponson apply --destroy` for the PR id you enter |
| Push to `main` | `branches: main`: `production waits for approval`, then `sponson production` | `sponson apply --env production`, a manual step on the `production` deployment environment |

## Prerequisites

- Bitbucket Cloud with Pipelines enabled (**Repository settings → Pipelines → Settings**).
- A `release.plan.yaml` at the repository root (`sponson init` writes one).
- The image `node:22`.

## Setup

1. Copy [bitbucket-pipelines.yml](bitbucket-pipelines.yml) to the repository root, or merge its pipelines into yours.
   If Pipelines deploys the app, put your deploy steps between `sponson apply` and `sponson finish`.
2. Replace `0.5.0` with the Sponson version you have reviewed.
3. Create the receipts token and the variables below.
4. In **Repository settings → Deployments**, keep the production tokens in the `Production` environment's variables
   and, on plans that offer it, restrict who may deploy to it.

## Variables

| Where | Variable | Value |
|---|---|---|
| Repository variables (secured) | `SPONSON_GIT_TOKEN` | repository access token with write access (below) |
| Repository variables (secured) | `VERCEL_TOKEN`, `NEON_API_KEY`, `CLERK_SECRET_KEY` | the preview tokens; one per adapter your plan uses |
| `Production` deployment variables (secured) | the same names | the production tokens; deployment variables override repository variables of the same name |
| either | every `env://NAME` a line references | the secret values |

Every adapter's variable is listed under [built-in ops](../../docs/plan-format.md#built-in-ops).

## Receipts: push credentials

Sponson writes its receipts to orphan branches of the repository, `sponson-receipts/<env>/<scope>`, from a clone of
its own. The pipeline's clone credentials are configured for the build's checkout only, so the template points
Sponson's clone at a token that can push:

1. **Repository settings → Security → Access tokens → Create access token**: name `sponson-receipts`, scope
   **Repositories: Write**.
2. Save it as the secured repository variable `SPONSON_GIT_TOKEN`.
3. Each step exports
   `SPONSON_RECEIPTS_REMOTE=https://x-token-auth:${SPONSON_GIT_TOKEN}@bitbucket.org/${BITBUCKET_REPO_FULL_NAME}.git`
   (the `&receipts-remote` anchor). Sponson strips credentials from every git error it prints.

If a branch restriction matches `sponson-receipts/*`, let the access token push to it. The receipts branches carry no
`bitbucket-pipelines.yml`, so pushing them starts no pipeline.

## Destroying a closed pull request's preview

**Pipelines → Run pipeline**, branch `main`, pipeline `custom: sponson-destroy`, then enter `SPONSON_PR_ID` (the PR's
number) and `SPONSON_PR_BRANCH` (its source branch). The scope is `pr-<id>` whatever branch the pipeline runs on, so
this works after the PR's branch is deleted. The same pipeline can be started through the Bitbucket API with the two
variables.

## How the flags are filled

| Flag | Variable |
|---|---|
| `--pr` | `BITBUCKET_PR_ID` (pull request pipelines only) |
| `--branch` | `BITBUCKET_BRANCH` |
| `--sha` | `BITBUCKET_COMMIT` |
| `--approved-by` | `BITBUCKET_STEP_TRIGGERER_UUID`, the account that started the manual production step |

Sponson 0.5.0 and later read `BITBUCKET_PR_ID`, `BITBUCKET_BRANCH` and `BITBUCKET_COMMIT` themselves when
`BITBUCKET_BUILD_NUMBER` is set, so those flags may then be dropped. `--approved-by` always stays explicit.

## Notes

- The approver is recorded as an account UUID, the only identity of the person who started the step that Pipelines
  exposes. Look it up in the workspace's members if you need the name.
- `clone: depth: full` fetches the whole history; Sponson uses it to recognise a late build of an older commit.
- Pipelines rejects a pipeline whose first step is manual, so `branches: main` starts with a step that only says
  what to run next; put your own build or deploy steps there instead if you have them.
- What has been run (`scripts/try-ci-templates.sh bitbucket`): every step's script verbatim in `node:22`, in pipeline
  order, against the fake cloud: the pull request pipeline (apply stopping at the deploy barrier, finish waiting for
  it), both steps of `branches: main` with the triggerer recorded as the approver, and `custom: sponson-destroy` on
  `main` with the PR's id and branch. The clone and the predefined, custom and deployment variables are emulated; not
  run on Bitbucket itself. See [how the templates are checked](../README.md#how-the-templates-are-checked).

<!-- sponson:embed bitbucket-pipelines.yml -->
