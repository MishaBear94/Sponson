---
"sponson": minor
"@sponson/adapters": minor
---

`sponson init` and `init --setup`, from a newcomer's walkthrough:

- `init --setup` lists the TODOs the plan still has (a `providers.neon.project` still `proj_xxx`) before asking for
  any token, and does not offer the workflow while there are any: it would run a plan that cannot work yet (it says
  so, and what to do; `--json` reports `workflow.result: "todo"`). `ready` is false while a TODO is left, and the run
  ends with what to do next (fill in the TODOs, fix the credentials, then `sponson init --setup` and `sponson plan`)
  and the command that starts the zero-account demo. `--json` carries it as `setup.next`.
- On a re-run with `--setup` the plan is detected again, so `--json` reports `detected` the same way every time (it was
  `null` on an existing plan), with `todo` the TODOs the plan still has: every line with a `# TODO:` comment (a value
  counts as filled in once its comment is gone).
- Text output names the plan relative to the working directory (`Wrote release.plan.yaml`); JSON keeps it absolute.
  `Added .sponson/ to .gitignore` follows it, and the receipts note is one line, printed when a starter is written.
- The Stripe starter line writes the webhook `path` (the recipe's documented default, `/api/webhooks/stripe`) with a
  TODO to check it against the app, and, when an `.env*` file names `STRIPE_WEBHOOK_SECRET` (only the name is read),
  a line of the deploy target's preview variables (Vercel or Netlify) that passes the endpoint's once-only signing
  `secret` to it by reference in the same run.

Recipes: a `detect.starter` entry takes `check` (params written with their `default` and a TODO to check it) and
`env` (outputs passed to the deploy target's variables under the name the app's `.env*` files use).
