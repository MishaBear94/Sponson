---
"@sponson/adapters": minor
"@sponson/sim": minor
---

New `xata` adapter with one op, `xata.branch`: a copy-on-write Postgres branch per scope on the Xata platform, waited for until healthy, with its connection string as a sensitive output (readable on every run). Needs `XATA_API_KEY` and `providers.xata.organization` and `.project`. The sim gained a Xata provider.
