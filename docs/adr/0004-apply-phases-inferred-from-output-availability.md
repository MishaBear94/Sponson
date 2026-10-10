# 4. Apply phases are inferred from output availability

Date: 2026-10-10

## Status

Accepted

## Context

A preview environment has to cross an event Sponson does not control. `DATABASE_URL` must be written to Vercel
before the preview builds; the Clerk redirect URL needs the preview URL, which exists only after the build. The
deploy itself is usually started by Vercel's git integration on push, at the same time as the CI job that runs
Sponson.

Asking users to split the plan into "before deploy" and "after deploy" phases would put an execution detail into the
file, and every new adapter with a late output would need another phase.

## Decision

Each op declares its outputs with their availability (`OutputSpec` in `packages/core/src/types.ts`):

```ts
outputs: {
  connection_string: { available: "immediate", sensitive: true },
  preview_url: { available: "external", event: "deploy" },
}
```

A line that reads an `external` output that does not exist yet is not applied. By default `apply` records it as
`waiting` (with `waitingFor: "deploy"`), applies every line that does not depend on it, writes the receipt with status
`partial` and exits 0. The next `apply`, typically triggered by the deployment finishing, finds the output and
continues. `--wait` polls instead (`awaitExternal`) until the event happens, fails, or times out.

Two further rules:

- **Late builds.** After writing variables, the Vercel adapter checks the newest deployment of the commit. If it
  started before the write and has not failed, the adapter triggers a redeploy and notes `redeployed: true`: one
  wasted build, but never a preview without its variables.
- **Explicit deploys.** A `vercel.deploy` line starts the deployment itself; its `preview_url` is `immediate`, so the
  barrier disappears and one `apply` runs to the end. Teams that want a deterministic order turn off automatic
  preview deployments and use it.

## Consequences

- Users never write phases. One workflow with several triggers runs the same `sponson apply` (see the README).
- `partial` is a normal outcome, not a failure. Agents are told not to retry on it (SKILL.md).
- A deployment that fails turns the waiting lines into `skipped` with `EXTERNAL_FAILED` and the run into `failed`;
  what was applied before the barrier is not rolled back ([ADR 0013](0013-rollback-undoes-only-this-run.md)).
- `plan` makes a read-only `awaitExternal` check, so a finished deploy shows the waiting line as `create` with its
  resolved input.
- A late build of an older commit must not roll a scope back. Receipts keep the history of applied commits, and a run
  for a commit that was superseded, or is a git ancestor of the last applied one, is skipped as `stale`.
