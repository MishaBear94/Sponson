# 7. `{ keep: true }` for adopting existing values

Date: 2026-10-10

## Status

Accepted. Introduced in v0.2, replacing adopted values written as `{ secret: "env://KEY" }`.

## Context

`sponson init` adopts resources that exist but no scope manages: variables someone set in the Vercel dashboard, an
existing Neon branch, an allowed Clerk URL. Adopting must write plan lines, and plan lines need values.

Copying live values into the plan would put secrets in the repository. Writing each adopted variable as
`{ secret: "env://KEY" }` avoided that but changed its meaning: the next apply would try to resolve `KEY` from the
environment and fail or overwrite the live value with whatever happened to be set.

## Decision

A fourth value form, `{ keep: true }`, means "whatever value the resource has live". Sponson then manages that the
resource exists and who owns it, not its value.

- `init` writes adopted variables as `{ keep: true }`, grouped into one `vercel.env` line per target and git branch
  (`branch: "*"` for project-wide ones). Neon branches and Clerk URLs are adopted by their identifying parameter
  (`name:`, `url:`), which is not a secret. Values are never copied into the plan.
- The resolver turns `{ keep: true }` into a `keep` marker. An adapter's `diff` reports it `unchanged` when the
  resource exists and fails with `PARAM_INVALID` when it does not: there is nothing to keep. `apply` leaves the live
  value alone.
- Adopted resources are recorded with `createdBy: adopted` and are never destroyed.

## Consequences

- Adoption is safe to run anywhere: the plan file gains references only, and nothing live changes.
- To take over a value later, replace `{ keep: true }` with a literal or a reference; the next apply writes it.
- `{ keep: true }` is allowed for secret-looking names, since only literal strings and numbers are rejected there.
- `plan --json` reports the input as `state: "kept"` with `value: null`.
