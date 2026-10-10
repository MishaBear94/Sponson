---
"sponson": minor
---

The run context is detected in GitLab CI/CD, CircleCI and Bitbucket Pipelines as it already was in GitHub Actions, so `--pr`, `--branch` and `--sha` are no longer needed there. GitLab: `CI_MERGE_REQUEST_IID`, the merge request's source branch and head commit (`CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` in merged-results pipelines, else `CI_COMMIT_SHA`), `CI_COMMIT_BRANCH`/`CI_COMMIT_REF_NAME` and `CI_DEFAULT_BRANCH`. CircleCI: the number at the end of `CIRCLE_PULL_REQUEST` (or `CIRCLE_PR_NUMBER`), `CIRCLE_BRANCH`, `CIRCLE_SHA1`. Bitbucket: `BITBUCKET_PR_ID`, `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`. Inside one of these hosts, a pipeline without a pull request means "no pull request" and skips the `gh` lookup. The sources are exported as `gitlabCiSource`, `circleCiSource` and `bitbucketPipelinesSource`. Copy-paste CI templates for the three hosts and MCP configurations for agent tools are under `integrations/`.
