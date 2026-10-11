---
"sponson": patch
---

The GitLab, CircleCI and Bitbucket templates under `integrations/` have now been run end to end in Docker against the fake cloud (`scripts/try-ci-templates.sh`: GitLab's through gitlab-ci-local, CircleCI's and Bitbucket's job by job in their images), which found two bugs. Bitbucket's `branches: main` pipeline started with its manual production step, which Pipelines rejects; it now starts with an automatic step. And in a CircleCI tag build or a Bitbucket tag pipeline, where there is no branch variable and the commit is checked out detached, the run context took the branch from git, so every tag got the scope `branch-HEAD`; the tag (`CIRCLE_TAG`, `BITBUCKET_TAG`) now stands for the branch, as `CI_COMMIT_REF_NAME` and `GITHUB_REF_NAME` already do. The templates now pin `sponson@0.5.0`.
