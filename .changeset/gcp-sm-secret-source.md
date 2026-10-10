---
"@sponson/adapters": minor
---

Added the `gcp-sm://` secret source: `{ secret: "gcp-sm://<project>/<secret>" }` reads the latest version of a Google Secret Manager secret through the `gcloud` CLI (credentials from `gcloud auth` and the CLI's usual environment); `gcp-sm://<project>/<secret>/<version>` pins a version.
