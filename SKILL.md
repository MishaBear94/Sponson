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

Every value is in one of four states, and `--json` tells you which: `literal` (written in the file), `resolved` (the referenced output exists now; `value` is filled unless sensitive), `pending` (the referenced line has not been applied; `value` is `null`), `secret` (`value` is always `null`). Never copy display text like `(pending ← db.x)` into the file; write the reference.

Dependencies come from `from:` references. Use `depends_on: [id]` only for ordering without data. `${ctx.env}`, `${ctx.scope}`, `${ctx.pr.number}` (null outside a PR: use `${ctx.scope}`), `${ctx.git.branch}`, `${ctx.git.sha}`, `${ctx.git.short_sha}` are the only variables.

## The three commands

| command | meaning | side effects |
|---|---|---|
| `sponson init` | make the plan catch up with reality: write a starter, or adopt unmanaged resources (`--adopt <key>`) | writes the plan file only |
| `sponson plan` | read live state, print the diff and drift | none |
| `sponson apply` | make reality catch up with the plan, roll back what this run created on failure, write a receipt | the ones in the file |

Always add `--json`. `--env` defaults to `preview`; production is never inferred. `sponson apply --destroy` removes everything this scope created (never adopted resources). `sponson mcp` exposes the same as MCP tools `sponson_plan`, `sponson_apply`, `sponson_receipt`.

## Rules

1. **Stop after plan.** Run `sponson plan --json`, show the human the diff (one line per change, `+ ~ = ? !`), and wait for a yes before `apply`. Exit code 1 means a line is `error` or `blocked`: fix the plan first.
2. **Partial is not failure.** Receipt `status: partial` means lines are `waiting` on an event Sponson does not control, usually a deploy. Do not retry. Re-run `sponson plan` later, or let the `deployment_status` workflow finish it. Exit code is 0.
3. **Secrets are references.** Write `{ secret: "env://NAME" }` (or `doppler://proj/cfg/NAME`, `op://vault/item/field`). Never a literal. The plan rejects literal values for keys that look secret (`_KEY`, `_SECRET`, `_TOKEN`, `PASSWORD`, `_PASS`, `PRIVATE`, ...) with `SECRET_LITERAL`. Values are resolved inside apply and redacted from all output.
4. **Never approve production yourself.** `--env production` is refused with `ENV_NOT_APPROVED` unless `--approved-by <who>` is given. That name comes from a human or an approval workflow, not from you.
5. **Drift is reported, not overwritten.** `changed` drift blocks that line until a human passes `--reconcile`. `unmanaged` resources are never touched; adopt them with `init`. Deleting a line does not destroy its resource.
6. **Read the receipt, not your memory.** After apply, `status` is `complete | partial | failed`; `lines[id].status` is `applied | unchanged | waiting | failed | rolled_back | rollback_failed | skipped` (`destroyed | destroy_failed` after `--destroy`); `lines[id].outputs` holds non-sensitive outputs (e.g. `preview_url`). Secrets and sensitive outputs are never in the receipt.

Exit codes: `0` ok (including partial), `1` failed, `2` plan invalid / env unknown / not approved, `3` another apply holds the lock (wait, do not force).

## Example 1: open a preview environment for a feature

1. Add to `release.plan.yaml` a `neon.branch` line `db` and a `vercel.env` line `env` with `DATABASE_URL: { from: db.connection_string }`, both `environments: [preview]`.
2. `sponson plan --json` → `lines: [{ id: "db", status: "create" }, { id: "env", status: "pending", waitingOn: "db" }]`. Show the human: "+ db neon.branch create; ? env vercel.env pending". Stop.
3. Human says yes. `sponson apply --json` → `receipt.status: "complete"`, `receipt.lines.env.status: "applied"`. Continue with the code change.

## Example 2: a callback that needs the deploy URL

Add `callback: { adapter: clerk, op: redirect_allow, url: { from: env.preview_url } }`. `apply` returns `status: "partial"` with `lines.callback.status: "waiting"`, `waitingFor: "deploy"`. Tell the human the callback will be registered once the preview deploys, and do nothing else. Later, `sponson plan --json` shows `callback` as `create` with a resolved URL; `apply` (or the CI `deployment_status` run) finishes it.
