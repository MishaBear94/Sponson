---
"@sponson/adapters": minor
---

`ApiClient` gains `put()`, retried after a 502/503/504 or a dropped connection like GET, and `post()`/`patch()` take `{ idempotent: true }` for writes that set state rather than add to it (a PATCH replacing a whole list), so they are retried the same way. `WriteOptions` joins the stable authoring API.
