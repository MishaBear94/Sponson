# 10. One JSON envelope and an `ERROR_CODES` table

Date: 2026-10-10

## Status

Accepted. Introduced in v0.2.

## Context

Agents drive Sponson through `--json` and MCP, so every outcome must be machine-readable. Before v0.2, error codes
existed on some paths only; `init` had no JSON output; a mistyped flag or a bad MCP argument produced text; JSON mixed
data with display strings such as `(pending ← db.x)`, which agents copied back into plans; and exit codes were chosen
case by case.

## Decision

**One envelope.** Every command (`init` included), every failure path (usage errors, plan errors, provider failures,
unexpected crashes) and every MCP tool answers with one JSON document:

```text
{ ok: true,  command, ...data }
{ ok: false, command, error: { code, message, hint?, ...details } }
```

`ok` is true exactly when the exit code is 0. Line-level failures carry `errorCode` on the plan or receipt line.

**Data, not display text.** Unknown, secret and sensitive values are `null` next to an explicit `state`. Diffs are
`DiffSide` data; only renderers produce text. The parser rejects display text pasted back into a plan.

**Codes are data.** `ERROR_CODES` in `packages/core/src/errors.ts` lists every code with its exit code, a `doc` line
and, when the remedy is a flag, a `cliHint`. Exit codes: 0 success (including `partial` and `stale`), 1 failed, 2
refused before running (invocation, plan, reference, parameter, environment, approval), 3 lock held or lost. The
engine speaks in run options (`approvedBy`, `reconcile`); the CLI attaches the hint that names the flag.
`toSponsonError()` turns anything thrown into a coded error (`INTERNAL` as the last resort).

**Documentation is generated.** `docs/errors.md` is generated from the table by `scripts/gen-docs.ts`, and a test
fails when it is stale.

## Consequences

- Agents branch on `code`, never on prose; SKILL.md lists the common codes and what to do about each.
- Adding a failure mode means adding a code: a `SponsonError` with an unlisted code does not type-check.
- Changing a code's exit code is a breaking change for scripts and CI, and should be treated as one.
- The MCP server returns the same envelope as the CLI, so the two cannot drift apart.
