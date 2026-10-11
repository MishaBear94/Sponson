---
"@sponson/core": minor
"@sponson/adapters": minor
"@sponson/sim": minor
"sponson": minor
---

One-off actions (ADR 0022): a new `http.action` op sends one request (or GraphQL request) when its declared `trigger` changes, for side effects with nothing to read back or delete (an Inngest sync, a cache purge, a deploy notification). `plan` shows the new status `run` (symbol `>`) until the current trigger has run in the scope, then `unchanged`; `apply` sends it, checks the answer (status, `ok_status`, `expect`), and records the trigger hash, its outputs and its optional `undo`, which `apply --destroy` sends. Delivery is at least once (nothing is recorded before the request is sent; `request.idempotency_key: true` derives an `Idempotency-Key` from the ledger key and the trigger hash), and rollback never undoes an action. A request may go to an absolute `url` (the app's own endpoint), which never receives an API credential. The engine gained the optional `OpSpec.action` hook, `ActionTrigger`, `LedgerEntry.action`, and `run` in `PlanLineStatus` and `DiffKind`. The REST sim gained logged endpoints (`endpoints`, `calls`; assumption R9).
