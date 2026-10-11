---
"@sponson/adapters": minor
---

New recipes: `mongodb_atlas.database_user` (Digest, versioned media type, password as a reference), `cockroachdb.database` and `cockroachdb.sql_user` (Cloud API), `gcs.bucket_cors` (Firebase Storage / GCS bucket CORS through `gcloud auth print-access-token`), `s3.bucket_cors` (S3 and R2 bucket CORS, SigV4 and XML), `flagsmith.environment` (`Authorization: Api-Key`), and `datadog.synthetic_api_test` (API and application keys). `postmark_server.webhook` now chains with `postmark.server` in one plan through `credential: { from: <server line>.server_token }`. Recipe files may use every credential form of the `http` adapter and `encoding: xml`.
