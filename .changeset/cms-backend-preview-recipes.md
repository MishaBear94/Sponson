---
"@sponson/adapters": minor
---

New recipes for headless-CMS and backend previews: `sanity.dataset` (a dataset per scope) and `sanity.cors_origin`
(the preview's origin in the project's CORS origins), `convex.preview_deployment` (a Convex preview deployment per
scope, its URL an output) and `convex.deploy_key` (its deploy key, a once-only output for `CONVEX_DEPLOY_KEY`), and
`firebase_hosting.channel` (a Firebase Hosting preview channel per scope, deleted with it). `sponson init` detects
Sanity, Convex and Firebase Hosting's pull-request workflow.
