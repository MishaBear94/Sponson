---
"@sponson/adapters": minor
"@sponson/sim": minor
"sponson": minor
---

Add the `supabase` adapter (credential `SUPABASE_ACCESS_TOKEN`, Management API). `supabase.branch` creates a Supabase preview branch per scope, waits until it is `ACTIVE_HEALTHY` (`SPONSON_SUPABASE_TIMEOUT_MS`), and outputs its `project_ref`, `api_url`, `db_host` and a sensitive `connection_string`; destroy deletes it. `supabase.auth_redirect` keeps one URL in a project's Auth redirect allow-list (`uri_allow_list`), on the parent project or, with `project: { from: db.project_ref }`, on the branch, never touching entries Sponson did not add. The sim simulates both (chaos `supabase_ready_ms` delays readiness), and `sponson init` now writes Supabase lines when it detects Supabase instead of listing it as not supported.
