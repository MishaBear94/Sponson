---
"@sponson/core": minor
"@sponson/adapters": minor
"sponson": minor
---

Added manual steps (ADR 0021) for state no API can manage, such as a Google OAuth client's redirect URIs. A
`manual.step` line (`title`, `instructions`, optional `undo`, `vars` and a `verify` GET) is shown by `plan` as `todo`
with its instructions filled in. `apply` leaves it and the lines that depend on it waiting, applies everything else,
and exits 2 with the new code `MANUAL_STEP_PENDING` and the steps' instructions in `manual`, until a person runs
`apply --confirm <line>` (or its verify request sees it done); the ledger records who confirmed it (`--approved-by`,
else the git user) and when. A verified step that stops verifying is `missing` drift. `apply --destroy` shows the
step's `undo` and waits for the same confirmation. The MCP `sponson_apply` tool takes `confirm`; agents never pass
it on their own. For adapter authors: `OpSpec.manual`, `PlanLineStatus` `todo`, and `RunOptions.confirm` /
`confirmedBy`.
