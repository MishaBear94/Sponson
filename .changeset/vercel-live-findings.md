---
"@sponson/adapters": patch
"@sponson/sim": patch
---

Vercel, after checking the env API against the real service on 2026-10-11: `vercel.env` no longer sends the
deprecated `decrypt=true` on the env list, which no longer decrypts; values are read with the per-variable GET, as
they already were whenever the list did not decrypt. A preview line bound to a git branch (the default for
`target: preview`) on a project with no connected Git repository, which Vercel refuses with a 400, now fails with
`PARAM_INVALID` and says how to fix it: connect the repository, or set `branch: "*"` for project-wide preview values.
The sim behaves the same way: its env list never decrypts, and a project seeded with `link: false` refuses
branch-bound values with Vercel's real 400 body.
