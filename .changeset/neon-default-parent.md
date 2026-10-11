---
"@sponson/adapters": minor
"@sponson/sim": minor
"sponson": minor
---

`neon.branch` without `parent` now forks from the project's default branch (the one Neon lists with `default: true`),
whatever it is called, instead of a branch named `main`. A new Neon project calls its default branch `production`
(checked against the real API on 2026-10-11), so a new user's first apply failed with "parent branch `main` not
found". An explicit `parent` (name or id) works as before; an unknown one now says which branch omitting it would
use. `sponson init`, the `sponson-sim --demo` plan, the README and the examples no longer write `parent: main`. The
sim's default Neon project now has a root branch named `production`, marked default, and answers a duplicate branch
name with Neon's real `409 BRANCH_ALREADY_EXISTS` body.
