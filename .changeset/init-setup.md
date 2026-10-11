---
"sponson": minor
"@sponson/adapters": minor
---

`sponson init --setup`: from a plan to the first real apply in one guided run on your own machine. For every
provider the plan uses (and every value it references with `env://`), it shows the page where the token is created
and the least it needs, reads the token from the environment or asks for it with hidden input (terminal only, never
written to disk), and checks it with one read-only request: `ok`, `wrong_scope` (403, or a project the token does
not reach) or `unauthorized` (401). Then, after a yes per secret (`--yes` for scripted use), it stores each checked
token as a GitHub Actions secret of the origin repository with your own `gh` (the value on stdin only, never in argv
or the child's environment), and writes `.github/workflows/sponson.yml` from the action README's preview job with the
action pinned to the commit of the installed version's release tag, never overwriting an existing file. Works on a
fresh repository (after writing the starter plan) and on an existing plan. `--json` reports each credential's status,
the secrets stored and the workflow written, never a value.

Adapters: `about.credentialUrl` and `about.credentialScope` say where a credential is created and what to pick (every
built-in adapter declares them, checked against the providers' docs), and `ResourceAdapter.verifyCredential(actx)`
checks one with a single read-only request (Vercel `GET /v9/projects/{id}` or `/v2/user`, Neon `GET /projects/{id}`,
Clerk `GET /redirect_urls`, …). Recipes gain a `credential` block (`url`, `scope`, `source`, optional `verify`), and
`verifyRecipeCredential` sends a recipe's check through the same client and authentication as its ops.
docs/providers.md lists each provider's token page and scope.
