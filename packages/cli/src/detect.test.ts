import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectCtx, localGitSource, sponsonEnvSource, type CtxSource } from "./detect.js";

describe("detectCtx", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const notARepo = () => mkdtemp(join(tmpdir(), "sponson-ctx-"));

  it("a push to main in GitHub Actions (GITHUB_HEAD_REF empty) is scope main", async () => {
    const dir = await notARepo();
    const event = join(dir, "event.json");
    await writeFile(event, JSON.stringify({ ref: "refs/heads/main", after: SHA, repository: { default_branch: "main" } }));
    const c = await detectCtx({ env: "production" }, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_HEAD_REF: "", GITHUB_SHA: SHA }, dir);
    expect(c).toMatchObject({ env: "production", scope: "main", git: { branch: "main", sha: SHA }, pr: { number: null } });
  });

  it("a push to a non-`main` default branch is scope main", async () => {
    const dir = await notARepo();
    const event = join(dir, "event.json");
    await writeFile(event, JSON.stringify({ ref: "refs/heads/trunk", repository: { default_branch: "trunk" } }));
    const c = await detectCtx({}, { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: event, GITHUB_REF_NAME: "trunk", GITHUB_HEAD_REF: "", GITHUB_SHA: SHA }, dir);
    expect(c.scope).toBe("main");
  });

  it("empty SPONSON_CTX_* and CI variables are unset, not values", async () => {
    const c = await detectCtx({}, { SPONSON_CTX_ENV: "", SPONSON_CTX_BRANCH: " ", SPONSON_CTX_SHA: "", SPONSON_CTX_PR: "", GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "feat/y", GITHUB_SHA: SHA }, await notARepo());
    expect(c).toMatchObject({ env: "preview", scope: "branch-feat-y", git: { branch: "feat/y", sha: SHA }, pr: { number: null } });
  });

  it("pull_request events take the head ref and the PR number", async () => {
    const c = await detectCtx({}, { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/7/merge", GITHUB_REF_NAME: "7/merge", GITHUB_HEAD_REF: "feat/z", GITHUB_SHA: SHA }, await notARepo());
    expect(c).toMatchObject({ scope: "pr-7", git: { branch: "feat/z" } });
  });

  it("an invalid SPONSON_CTX_PR is an error, not NaN", async () => {
    await expect(detectCtx({ branch: "b", sha: SHA }, { SPONSON_CTX_PR: "abc" }, await notARepo())).rejects.toMatchObject({ code: "CTX_NULL" });
  });

  it("--pr wins over SPONSON_CTX_PR without validating it", async () => {
    const c = await detectCtx({ branch: "b", sha: SHA, pr: 5 }, { SPONSON_CTX_PR: "abc" }, await notARepo());
    expect(c).toMatchObject({ scope: "pr-5", pr: { number: 5 } });
  });

  it("outside a repository with nothing given, says how to supply branch and sha", async () => {
    await expect(detectCtx({}, {}, await notARepo())).rejects.toMatchObject({ code: "CTX_NULL", message: expect.stringMatching(/--branch and --sha/) });
  });

  describe("GitLab CI/CD", () => {
    const MR_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

    it("a merge request pipeline is scope pr-<iid> on the source branch", async () => {
      const c = await detectCtx({}, { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_IID: "12", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feat/x", CI_COMMIT_REF_NAME: "feat/x", CI_COMMIT_SHA: SHA, CI_DEFAULT_BRANCH: "main" }, await notARepo());
      expect(c).toMatchObject({ scope: "pr-12", git: { branch: "feat/x", sha: SHA }, pr: { number: 12 } });
    });

    it("a merged-results pipeline uses the source branch head, not the synthetic merge commit", async () => {
      const c = await detectCtx({}, { GITLAB_CI: "true", CI_MERGE_REQUEST_IID: "3", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feat/y", CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: MR_HEAD, CI_COMMIT_SHA: SHA }, await notARepo());
      expect(c.git.sha).toBe(MR_HEAD);
    });

    it("a branch pipeline on the default branch is scope main, and knows there is no MR", async () => {
      const c = await detectCtx({ env: "production" }, { GITLAB_CI: "true", CI_COMMIT_BRANCH: "trunk", CI_COMMIT_REF_NAME: "trunk", CI_COMMIT_SHA: SHA, CI_DEFAULT_BRANCH: "trunk", CI_MERGE_REQUEST_IID: "" }, await notARepo());
      expect(c).toMatchObject({ env: "production", scope: "main", git: { branch: "trunk" }, pr: { number: null } });
    });

    it("a tag pipeline falls back to CI_COMMIT_REF_NAME", async () => {
      const c = await detectCtx({}, { GITLAB_CI: "true", CI_COMMIT_REF_NAME: "v1.2.0", CI_COMMIT_TAG: "v1.2.0", CI_COMMIT_SHA: SHA }, await notARepo());
      expect(c).toMatchObject({ scope: "branch-v1.2.0", pr: { number: null } });
    });

    it("CI_* variables outside GitLab (no GITLAB_CI) are not read", async () => {
      const c = await detectCtx({ branch: "b", sha: SHA, pr: null }, { CI_MERGE_REQUEST_IID: "12", CI_COMMIT_SHA: "x" }, await notARepo());
      expect(c).toMatchObject({ scope: "branch-b", git: { sha: SHA } });
    });

    it("flags win over GitLab's variables", async () => {
      const c = await detectCtx({ pr: 99, branch: "flag" }, { GITLAB_CI: "true", CI_MERGE_REQUEST_IID: "12", CI_COMMIT_REF_NAME: "feat/x", CI_COMMIT_SHA: SHA }, await notARepo());
      expect(c).toMatchObject({ scope: "pr-99", git: { branch: "flag", sha: SHA } });
    });
  });

  describe("CircleCI", () => {
    it("takes the PR number from the end of CIRCLE_PULL_REQUEST", async () => {
      const c = await detectCtx({}, { CIRCLECI: "true", CIRCLE_PULL_REQUEST: "https://github.com/acme/app/pull/42", CIRCLE_BRANCH: "feat/c", CIRCLE_SHA1: SHA }, await notARepo());
      expect(c).toMatchObject({ scope: "pr-42", git: { branch: "feat/c", sha: SHA } });
    });

    it("understands Bitbucket-style PR URLs and a trailing slash", async () => {
      const c = await detectCtx({}, { CIRCLECI: "true", CIRCLE_PULL_REQUEST: "https://bitbucket.org/acme/app/pull-requests/8/", CIRCLE_BRANCH: "b", CIRCLE_SHA1: SHA }, await notARepo());
      expect(c.pr.number).toBe(8);
    });

    it("falls back to CIRCLE_PR_NUMBER (forked pull requests)", async () => {
      const c = await detectCtx({}, { CIRCLECI: "true", CIRCLE_PR_NUMBER: "5", CIRCLE_BRANCH: "pull/5", CIRCLE_SHA1: SHA }, await notARepo());
      expect(c.scope).toBe("pr-5");
    });

    it("a branch build without a pull request is the branch scope, and main is main", async () => {
      const dir = await notARepo();
      expect(await detectCtx({}, { CIRCLECI: "true", CIRCLE_PULL_REQUEST: "", CIRCLE_BRANCH: "feat/d", CIRCLE_SHA1: SHA }, dir)).toMatchObject({ scope: "branch-feat-d", pr: { number: null } });
      expect((await detectCtx({}, { CIRCLECI: "true", CIRCLE_BRANCH: "main", CIRCLE_SHA1: SHA }, dir)).scope).toBe("main");
    });

    it("a PR URL that does not end in a number is not a PR", async () => {
      const c = await detectCtx({}, { CIRCLECI: "true", CIRCLE_PULL_REQUEST: "https://github.com/acme/app/pull/abc", CIRCLE_BRANCH: "b", CIRCLE_SHA1: SHA }, await notARepo());
      expect(c.pr.number).toBeNull();
    });
  });

  describe("Bitbucket Pipelines", () => {
    it("a pull-requests pipeline is scope pr-<id>", async () => {
      const c = await detectCtx({}, { BITBUCKET_BUILD_NUMBER: "17", BITBUCKET_PR_ID: "4", BITBUCKET_BRANCH: "feat/e", BITBUCKET_COMMIT: SHA }, await notARepo());
      expect(c).toMatchObject({ scope: "pr-4", git: { branch: "feat/e", sha: SHA }, pr: { number: 4 } });
    });

    it("a branch pipeline has no pull request", async () => {
      const c = await detectCtx({}, { BITBUCKET_BUILD_NUMBER: "18", BITBUCKET_BRANCH: "main", BITBUCKET_COMMIT: SHA }, await notARepo());
      expect(c).toMatchObject({ scope: "main", pr: { number: null } });
    });

    it("an invalid BITBUCKET_PR_ID is no pull request, never NaN", async () => {
      const c = await detectCtx({}, { BITBUCKET_BUILD_NUMBER: "19", BITBUCKET_PR_ID: "0", BITBUCKET_BRANCH: "x", BITBUCKET_COMMIT: SHA }, await notARepo());
      expect(c.pr.number).toBeNull();
    });
  });

  it("SPONSON_CTX_* wins over any CI host", async () => {
    const c = await detectCtx({}, { SPONSON_CTX_PR: "", SPONSON_CTX_BRANCH: "env-b", BITBUCKET_BUILD_NUMBER: "1", BITBUCKET_PR_ID: "4", BITBUCKET_BRANCH: "feat/e", BITBUCKET_COMMIT: SHA }, await notARepo());
    expect(c).toMatchObject({ scope: "branch-env-b", git: { branch: "env-b", sha: SHA }, pr: { number: null } });
  });

  it("another CI host plugs in as a source; earlier sources win field by field", async () => {
    const ci: CtxSource = { name: "other-ci", detect: async () => ({ branch: "from-ci", sha: SHA, pr: 9, defaultBranch: "trunk" }) };
    const c = await detectCtx({}, { SPONSON_CTX_BRANCH: "from-env", SPONSON_CTX_PR: "" }, await notARepo(), [sponsonEnvSource, ci, localGitSource]);
    // SPONSON_CTX_PR="" (no PR) is an answer the later source must not override.
    expect(c).toMatchObject({ env: "preview", scope: "branch-from-env", git: { branch: "from-env", sha: SHA, short_sha: SHA.slice(0, 7) }, pr: { number: null } });
  });
});
