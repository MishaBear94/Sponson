---
"@sponson/adapters": minor
---

New `planetscale` adapter (Vitess / MySQL databases). `planetscale.branch` creates a development branch per scope from a parent (default `main`), waits until PlanetScale reports it ready (`SPONSON_PLANETSCALE_POLL_MS`, `SPONSON_PLANETSCALE_READY_TIMEOUT_MS`), and deletes it on destroy. `planetscale.password` creates a password on that branch; its `connection_string` and `password` outputs exist only in the run that creates it (PlanetScale never shows the plaintext again), so reference them from lines in the same plan, such as a `vercel.env` `DATABASE_URL`. Later runs keep the value those lines hold and write nothing; Sponson never rotates the password on its own. Configure `providers.planetscale: { organization, database }` and set `PLANETSCALE_SERVICE_TOKEN_ID` and `PLANETSCALE_SERVICE_TOKEN`. The sim simulates the same API, with a `planetscale_ready_ms` chaos setting.
