---
"@sponson/adapters": minor
"@sponson/sim": minor
"@sponson/core": minor
---

Add the generic `http` adapter: manage any JSON (or form-encoded) REST API from the plan, without TypeScript. `http.resource` keeps one object per item (a feature flag, a webhook endpoint), located by a path or by a list and the fields that identify it; `http.list_item` keeps one entry in an array, a delimited string or a keyed map on a parent object (an allowed origin, a redirect allow-list entry, a config var) by read-modify-write with re-read verification. Each API is a block under `providers.http.<api>` that names its credential's environment variable (bearer, custom header or Basic). Intents, idempotent apply, drift by hash, destroy of only what Sponson created and secret redaction work as for every other adapter. See ADR 0017 and docs/plan-format.md. `OpSpec` gains two optional hooks, `providerFor` and `outputsFor`; the HTTP client takes static headers, form encoding and a content type; the sim gains a generic REST provider (`rest`).
