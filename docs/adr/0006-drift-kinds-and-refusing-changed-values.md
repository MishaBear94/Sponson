# 6. Four kinds of drift, and apply refuses changed values

Date: 2026-10-10

## Status

Accepted

## Context

Between two runs people edit consoles: they fix an incident by changing a variable, delete a branch, add something by
hand. A plan line may also be deleted while its resource still exists. Each case needs a different answer, and the
wrong default is costly: silently overwriting a console edit can undo an emergency fix at the worst moment, and
treating unknown resources as "to be deleted" is the largest source of accidents with tools that do so.

## Decision

`plan` reports drift in its own section (`drift[]`), separate from the diff. There are four kinds (`DriftKind` in
`packages/core/src/types.ts`):

| Kind | Meaning | `apply` |
|---|---|---|
| `unmanaged` | exists where a line could own it; no scope manages it | never touches it; `sponson init` can adopt it |
| `changed` | the live value or the provider id differs from what the ledger recorded | refuses the line with `DRIFT_CHANGED` unless the run reconciles (`--reconcile`) |
| `missing` | the ledger says it was applied; it no longer exists | recreates it |
| `orphan` | Sponson created it; no line declares it any more | leaves it alone; only `apply --destroy` removes it |

Further rules:

- A console edit that already matches the plan is accepted silently: only conflicting edits are refused.
- `plan` predicts the refusal: the line's status is `blocked` with `errorCode: DRIFT_CHANGED`, so nobody learns about
  it halfway through an apply.
- `apply` re-reads live state for every line instead of trusting what `plan` saw, so an edit made between `plan`
  and `apply` is still caught.
- `--reconcile` applies only to `changed`: the plan's value wins and the receipt line notes `reconciled: true`. A
  replaced resource reconciled this way is treated as adopted, because Sponson did not create it.
- Drift is only looked for where plan lines could own resources (each op's `listScope`): no account-wide scans and no
  permissions beyond what the plan needs.

## Consequences

- Deleting a plan line never destroys anything. Removal is always the explicit `apply --destroy`.
- A human decides whether a console edit or the plan wins; SKILL.md tells agents to show the drift and leave
  `--reconcile` to a person.
- The ledger must keep a hash and provider id for every entry ([ADR 0005](0005-receipts-are-a-ledger-with-write-ahead-intents.md)),
  or `changed` cannot be told from `missing`.
- Resources other scopes manage are excluded from `unmanaged` ([ADR 0008](0008-scopes-succession-and-leases.md)).
