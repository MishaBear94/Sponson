---
"@sponson/sim": minor
---

Simulated providers declare their HTTP API as a route table: `route(method, path, handler)` per endpoint, with `:name` path segments passed URI-decoded and typed in `params`, served by `router(routes, fallback)`. The Vercel, Neon and Clerk sims and the `pnpm new:adapter` template use it.
