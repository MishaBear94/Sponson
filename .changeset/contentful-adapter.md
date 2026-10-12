---
"@sponson/adapters": minor
"@sponson/sim": minor
"sponson": minor
---

New `contentful` adapter: `contentful.environment` copies a sandbox environment per scope from `master` (or another
environment) and waits until it is ready; `contentful.api_key_access` lets a delivery API key (and its preview key)
read it, writing the key's environments with the version it read. `sponson init` detects Contentful from
`contentful`, `contentful-management` and `@contentful/*` packages and `CONTENTFUL_*` variables.
