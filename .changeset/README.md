# Changesets

Every pull request that changes what a user of `sponson`, `@sponson/core`, `@sponson/adapters` or
`@sponson/sim` sees adds one changeset:

```bash
pnpm changeset
```

pick the bump (pre-1.0: `minor` for anything breaking or new, `patch` for fixes) and write one or two
sentences for the changelog, in the past tense, from the user's point of view. Breaking changes start with
`**Breaking:**` and say what to do.

The four packages are `fixed`: they always release together at the same version, so it does not matter which
of them you select. Docs-only, test-only and CI-only changes need no changeset (the PR template asks).

Releases: the `release` workflow opens a "Version Packages" PR that consumes these files, bumps every
`package.json` and writes each package's `CHANGELOG.md`; merging it publishes. See "Releasing" in
CONTRIBUTING.md.
