---
"@sponson/sim": minor
---

Try Sponson without any cloud account: `npx @sponson/sim --demo <dir>` starts the fake cloud, writes a demo git repository with a plan wired to its seeded projects (Neon branch, Vercel `DATABASE_URL` by reference, the preview deploy, a Clerk redirect) and an env file to `source`, and prints the commands to run next. `sponson-sim env` prints the `export` lines for a running sim, for `eval "$(sponson-sim env)"`; `sponson-sim --help` lists the options.
