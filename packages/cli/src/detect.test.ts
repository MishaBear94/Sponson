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

  it("another CI host plugs in as a source; earlier sources win field by field", async () => {
    const ci: CtxSource = { name: "other-ci", detect: async () => ({ branch: "from-ci", sha: SHA, pr: 9, defaultBranch: "trunk" }) };
    const c = await detectCtx({}, { SPONSON_CTX_BRANCH: "from-env", SPONSON_CTX_PR: "" }, await notARepo(), [sponsonEnvSource, ci, localGitSource]);
    // SPONSON_CTX_PR="" (no PR) is an answer the later source must not override.
    expect(c).toMatchObject({ env: "preview", scope: "branch-from-env", git: { branch: "from-env", sha: SHA, short_sha: SHA.slice(0, 7) }, pr: { number: null } });
  });
});
