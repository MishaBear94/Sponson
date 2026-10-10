# sponson

## 0.4.0

### Patch Changes

- 9b6c97a: Internal: scope drift, destroy, receipt parsing and listing, `init`'s plan editing, the sims' chaos selection and request handling are split into named steps; behaviour is unchanged. Lint caps cyclomatic complexity at 15.
- 53e7446: npm metadata: every package has keywords and its homepage is the documentation site (https://sponson.mintlify.site); the package READMEs link to it, and the CLI's README states the Node.js 22 requirement its `engines` already declared.
- Updated dependencies [78eef8a]
- Updated dependencies [b028881]
- Updated dependencies [eec4766]
- Updated dependencies [510ebe8]
- Updated dependencies [8f1b9c2]
- Updated dependencies [9b6c97a]
- Updated dependencies [53e7446]
  - @sponson/adapters@0.4.0
  - @sponson/core@0.4.0

## 0.3.0

### Minor Changes

- 9813460: The GitHub Action now defaults to `version: source`: it installs and runs Sponson from the action's own checkout — exactly the ref the caller pinned — instead of `npx sponson@latest`, so nothing is fetched from a package registry. Pin the action to a commit SHA. An explicit npm version is still accepted once the package is published from this repository. Node 22 is now the minimum (the versions CI tests).
- 0434a9e: Context detection (`detectCtx`, GitHub Actions and local git/`gh`) moved from `@sponson/core` to `sponson` behind a `CtxSource` seam (breaking for direct users of `@sponson/core`). A lease holder whose renewals stall now stops itself before its lease could be taken over. `ReceiptStore.close()` lets long-running hosts release temporary git clones. Adapters gain `adopt()`; the plan format has a JSON Schema. Adapters declare `about` (credential and base-URL variables) and secret sources declare `form`/`resolvedBy`, read by the generated docs (ADR 0015). Secret-source errors no longer repeat the reference, and a missing CLI is reported as such. `aws-sm://` resolves secrets from AWS Secrets Manager. `pnpm sim` prints a paste-ready environment block.

### Patch Changes

- Updated dependencies [3f2c6e0]
- Updated dependencies [8987603]
- Updated dependencies [4f01efe]
- Updated dependencies [e009218]
- Updated dependencies [0434a9e]
- Updated dependencies [7fc20cf]
- Updated dependencies [1533787]
  - @sponson/adapters@0.3.0
  - @sponson/core@0.3.0
