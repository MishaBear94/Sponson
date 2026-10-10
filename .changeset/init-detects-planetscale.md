---
"sponson": minor
---

`sponson init` no longer reports PlanetScale as not supported. When it detects PlanetScale (an `@planetscale/*` dependency, a `PLANETSCALE_*` variable name, or a `*.psdb.cloud` database host) and not Neon, the starter plan has a `planetscale.branch` line, a `planetscale.password` line on that branch (with `connection_params: "sslaccept=strict"` when Prisma is used) and the Vercel `DATABASE_URL` from the password's connection string, with TODOs for the organization and database names.
