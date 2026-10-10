---
"@sponson/adapters": patch
"@sponson/sim": patch
---

Vercel deployments are matched by environment as well as commit: a production line no longer takes the commit's preview build (or the reverse), using the documented `target` filter of `GET /v7/deployments` plus a check of each item's `target`. The `vercel.deploy` resource key is now `deployment:<production|preview>:<sha>`; an existing ledger entry under the old key is reported as an orphan once and is harmless (destroying a deployment is a no-op).
