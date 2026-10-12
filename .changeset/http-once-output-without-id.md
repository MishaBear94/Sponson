---
"@sponson/adapters": minor
"@sponson/sim": minor
---

`http.resource`: a once-only output is now taken from the create's answer also when that answer holds nothing but
the value and the object is then found with `find` (Convex answers a new deploy key as `{ deployKey }`). The REST sim
lets a create choose its id with a query parameter (style `id_query`, recipe sim hint `id_query`) and deletes an
object a `POST` names in its path (a `deletes` path with a `{id}` segment).
