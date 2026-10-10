---
"@sponson/adapters": minor
"@sponson/sim": minor
---

New `netlify` adapter (`NETLIFY_AUTH_TOKEN`, `providers.netlify: { site, account? }`). Op `env` owns one deploy context's value of each variable it declares (`production`, `deploy-preview`, `branch-deploy`, `dev`, `dev-server`, or `branch` with a branch name; previews default to the current git branch's value, which Netlify uses for that branch's Deploy Previews, so pull requests never share values). Values others set for other contexts are never changed, and destroy deletes a variable only when nothing is left in it. External outputs `preview_url` (the deploy's permalink), `deploy_id` and `deploy_preview_url` (`https://deploy-preview-<n>--<site>.netlify.app`) wait for a ready deploy of the commit that started after the values changed; an older production or branch deploy is rebuilt, and an older Deploy Preview, which Netlify's API cannot rebuild, is reported as `notes.stale_deploy`. The sim simulates Netlify's env and deploy APIs.
