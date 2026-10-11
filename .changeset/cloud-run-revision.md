---
"@sponson/adapters": minor
"@sponson/sim": minor
"@sponson/core": minor
"sponson": minor
---

New `cloud_run` adapter with one op, `cloud_run.revision`: a revision of an existing Google Cloud Run service per scope, made from the service's template with the line's image and environment variables (`{ from }` and `{ secret }` values included), tagged (`pr-42` by default) with its own URL as the `url` output, and given no traffic; `apply` waits for Cloud Run's operations and for the revision to be ready, drift covers the image and the declared variables, and destroy removes the tag. It authenticates with the token `gcloud auth print-access-token` prints and needs `providers.cloud_run.project` and `.region`; `production: true` in that block makes its lines need approval. Traffic is never moved: when a share of the service's traffic follows LATEST, the line is refused before any write unless it sets `pin_latest: true`, which pins that share to the revision serving it, as `gcloud run deploy --no-traffic` does (see docs/plan-format.md for what that means for later production deploys). `sponson init` detects Cloud Run, `AdapterAbout` gains `credentialCommand` for adapters that take a CLI's token, and the sim gained a Cloud Run provider. Covers the last uncovered row of the coverage matrix, `cloud-run-tag`.
