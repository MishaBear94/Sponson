---
"@sponson/adapters": minor
---

New recipe `inngest.sync` (coverage row `inngest-sync`): syncs a preview deployment into its Inngest branch environment by sending `PUT` to the app's serve endpoint (`/api/inngest` by default) once per deployment URL and revision. The app's SDK registers itself with its own signing key into the environment `INNGEST_ENV` names, so the line needs no Inngest credential; extra `headers` (such as a Vercel deployment protection bypass, as a secret) are passed on. Recipes may now be `kind: action`, and a recipe whose ops are all actions sent to the app's own URL has no `api` block.
