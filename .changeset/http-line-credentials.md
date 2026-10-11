---
"@sponson/core": minor
"@sponson/adapters": minor
"@sponson/sim": minor
---

`http` lines may take their credential from another line: `credential: { from: <line>.<output> }` (a sensitive output that is not once-only) or `credential: { secret: … }` replaces the API block's variable for that line, never part of its identity; the line must say `destroy: keep`. The engine checks such params before any request through the new optional `OpSpec.credentialInputs` hook (a literal, a non-sensitive or a once-only output is `PARAM_INVALID`). A `POST` delete's body may name the object with `{id}` (Datadog's `{ public_ids: ["{id}"] }`), and `http.list_item` over XML reads a lone element as a list of one where the item declares a list. The REST sim gained stored generated fields with a header that accepts them, and bulk deletes by body.
