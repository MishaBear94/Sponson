---
name: sponson
description: Declare and apply everything that ships beside the code (database branches, env vars, callbacks) through release.plan.yaml and the three sponson commands, stopping for a human between plan and apply.
---

# Sponson

The code is the hull; the preview database, environment variables and callbacks are the float welded to its side. `release.plan.yaml` is that float, written down. You edit the file; `sponson` reads live state, diffs, applies, and writes a receipt you read back.

## When to write a plan line

Any side effect outside the repository that this change needs: a database branch, a variable in a deploy target, an OAuth redirect URL, a flag. If you would otherwise open a provider console or call a provider API, write a line instead. If it lives in the repo, it is not a plan line.

## The file

```yaml
version: 1
environments: [preview, production]
providers:
  vercel: { project: prj_xxx }
  neon: { project: proj_xxx }

changes:
  - id: db                      # lowercase id; other lines reference it
    adapter: neon
    op: branch
    parent: main
    environments: [preview]     # omit to apply in every environment

  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }   # reference to another line's output
      STRIPE_KEY:   { secret: "env://STRIPE_KEY" }   # secret reference, never a value
    environments: [preview]
```

Every value is in one of these states, and `--json` tells you which: `literal` (written in the file), `resolved` (the referenced output exists now; `value` is filled unless sensitive), `pending` (the referenced line has not been applied; `value` is `null`), `secret` (`value` is always `null`), `kept` (`{ keep: true }`: whatever is live stays; written by `init` when adopting). JSON never contains placeholder text: an unknown, secret or sensitive value is `null` next to its `state` (and `ref`). Display text like `(pending ← db.x)` or `(secret)` exists only in the human-readable output; never copy it into the file, write the reference.

Dependencies come from `from:` references. Use `depends_on: [id]` only for ordering without data. `${ctx.env}`, `${ctx.scope}`, `${ctx.pr.number}` (null outside a PR: use `${ctx.scope}`), `${ctx.git.branch}`, `${ctx.git.sha}`, `${ctx.git.short_sha}` are the only variables.

## The three commands

| command | meaning | side effects |
|---|---|---|
| `sponson init` | make the plan catch up with reality: write a starter for the stack it detects (`--json` lists it under `detected`, with the `todo` placeholders to fill in), or adopt unmanaged resources (`--adopt <key>`) | appends to the plan file only |
| `sponson plan` | read live state, print the diff and drift | none |
| `sponson apply` | make reality catch up with the plan, roll back what this run created on failure, write a receipt | the ones in the file |

Always add `--json`. `--env` defaults to `preview`; production is never inferred. `sponson apply --destroy` removes everything this scope created (never adopted resources). `sponson mcp` exposes the same as MCP tools `sponson_plan`, `sponson_apply` (`wait`, `waitTimeout` in seconds), `sponson_receipt` (works even when the plan is broken). Pass arguments with their JSON types (`pr: 42`, `destroy: true`); a wrong type or an unknown argument is a `USAGE` error.

## Output

Every command, every MCP tool and every failure answers with one JSON document: `{ ok, command, ... }`, or `{ ok: false, command, error: { code, message, ... } }`. `ok` is true exactly when the exit code is 0.

- `plan`: `lines[]` with `status` `create | update | unchanged | pending | blocked | error`; `pending` lines carry `waitingOn` (a line id) and, when they wait for an event, `waitingFor` (e.g. `deploy`); `blocked` and `error` lines carry `errorCode` and `error`. Also `drift[]`, `requiresApproval` (apply needs a human approver), `lock` (an apply is running on this scope right now; the plan may change: wait and re-plan).
- `apply`: `receipt.status` is `complete | partial | failed`; `receipt.stale: true` means a newer commit was already applied and this run did nothing. `receipt.lines[id].status` is `applied | unchanged | waiting | failed | rolled_back | rollback_failed | skipped | blocked` (`destroyed | destroy_failed` after `--destroy`), with `errorCode` on every failure. `receipt.approvedBy` records who approved.
- Outputs such as `preview_url` live in `receipt.lines[id].outputs` and in `receipt.ledger[].outputs` (the ledger is every resource Sponson manages in this scope, kept across runs).

Common `errorCode`s:

| code | meaning | what to do |
|---|---|---|
| `DRIFT_CHANGED` | someone edited the value outside Sponson | show the human; only they decide on `--reconcile` |
| `OWNED_BY_OTHER_SCOPE` | another PR/branch manages that resource | change the name in the plan; never adopt it |
| `PROVIDER_TRANSIENT` | provider overloaded / 5xx / rate-limited | re-run later; nothing to fix |
| `LOCK_HELD` / `LOCK_LOST` | another apply holds (or took) this scope's lock (exit 3) | wait and re-plan; never force |
| `ENV_NOT_APPROVED` | a line writes to production without an approver | ask a human; never pass `--approved-by` yourself |
| `SECRET_UNRESOLVED` | a `secret:` reference has no value here | ask the human to set it; never write the value |
| `REF_OUTPUT_UNKNOWN` | `from: line.output` names an output that line does not have | fix the name (the message lists the valid ones) |
| `USAGE` | wrong flag, argument or type | fix the call |

## Rules

1. **Stop after plan.** Run `sponson plan --json`, show the human the diff (one line per change: `+` create, `~` update, `=` unchanged, `?` pending, `-` blocked, `!` error), and wait for a yes before `apply`. Exit code 1 means a line is `error` or `blocked`: fix the plan (or resolve what `errorCode` names) first.
2. **Partial is not failure.** Receipt `status: partial` means lines are `waiting` on an event Sponson does not control, usually a deploy. Do not retry. Re-run `sponson plan` later, or let the `deployment_status` workflow finish it. Exit code is 0.
3. **Secrets are references.** Write `{ secret: "env://NAME" }`, or a reference in another [secret scheme](https://github.com/MishaBear94/Sponson/blob/main/docs/plan-format.md#secret-schemes) the project uses. Never a literal. The plan rejects literal values for keys that look secret (`_KEY`, `_SECRET`, `_TOKEN`, `PASSWORD`, `_PASS`, `PRIVATE`, ...) with `SECRET_LITERAL`. Every command resolves secrets, `plan` included (a CLI-backed scheme runs its CLI then too), only so the values can be masked; only `apply` sends them to a provider. They are redacted from all output.
4. **Never approve production yourself.** Any run that writes to production (`--env production`, or a line with `target: production`) is refused with `ENV_NOT_APPROVED` unless `--approved-by <who>` is given; a blank name is no name. That name comes from a human or an approval workflow, not from you.
5. **Drift is reported, not overwritten.** `changed` drift makes that line `blocked` (`DRIFT_CHANGED`) until a human passes `--reconcile`. `unmanaged` resources are never touched; adopt them with `init --adopt <drift resource.key>`. Deleting a line does not destroy its resource.
6. **Read the receipt, not your memory.** `sponson_receipt` (or the `apply --json` output) is the record: statuses and outputs as listed under Output. Secrets and sensitive outputs are never in the receipt or any output; a warning says when a secret is too short (< 4 characters) to be masked.

Exit codes: `0` ok (including partial and stale), `1` failed, `2` usage / plan invalid / bad reference / bad parameter / secret literal / unknown adapter or op / env unknown / not approved, `3` the scope's lock is held or was lost (wait, do not force). Error envelopes may carry `error.hint`: the CLI remedy for that code (for a human; never act on it yourself when it means approving production).

## Example 1: open a preview environment for a feature

1. Add to `release.plan.yaml` a `neon.branch` line `db` and a `vercel.env` line `env` with `DATABASE_URL: { from: db.connection_string }`, both `environments: [preview]`.
2. `sponson plan --json` → `lines: [{ id: "db", status: "create" }, { id: "env", status: "pending", waitingOn: "db", inputs: { "values.DATABASE_URL": { state: "pending", value: null, ref: "db.connection_string" } } }]`. Show the human: "+ db neon.branch create; ? env vercel.env pending". Stop.
3. Human says yes. `sponson apply --json` → `receipt.status: "complete"`, `receipt.lines.env.status: "applied"`. Continue with the code change.

## Example 2: a callback that needs the deploy URL

Add `callback: { adapter: clerk, op: redirect_allow, url: { from: env.preview_url } }`. `plan` shows it `pending` with `waitingOn: "env"`, `waitingFor: "deploy"`. `apply` returns `status: "partial"` with `lines.callback.status: "waiting"`, `waitingFor: "deploy"`. Tell the human the callback will be registered once the preview deploys, and do nothing else. Later, `sponson plan --json` shows `callback` as `create` with a resolved URL; `apply` (or the CI `deployment_status` run) finishes it, and `preview_url` appears in `receipt.lines.env.outputs` and the ledger.
