---
"@sponson/adapters": minor
"@sponson/sim": minor
---

New `digitalocean` adapter with one op, `digitalocean.app`: a DigitalOcean App Platform app per scope from a whole app spec (environment variables included), waited for until its deployment is live; drift covers the declared fields of the spec (platform defaults and encrypted secret values ignored). Needs `DIGITALOCEAN_ACCESS_TOKEN`. The sim gained an App Platform provider.
