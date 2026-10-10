---
"@sponson/adapters": minor
---

`http.resource` outputs (and recipes) can be declared `once: true` with `sensitive: true`: a value the provider shows only in the create answer, such as a database connection string. It reaches dependent lines in the creating run and is never taken from a read; later runs keep it only where the ledger proves a dependent holds it (ADR 0018).
