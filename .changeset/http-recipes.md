---
"@sponson/adapters": minor
"@sponson/sim": minor
---

The generic `http` adapter gained recipes: verified specs for one provider operation, shipped in `@sponson/adapters` under `recipes/`. A plan line names one with `recipe: <provider>.<op>` and fills in its typed params (`adapter: http, op: resource, recipe: cloudflare.dns_cname, zone_id: …, name: …, target: …`); the `providers.http.<provider>` block is optional and overrides the recipe's base URL, credential variable, headers or encoding. Params are checked before any request (`PARAM_INVALID` naming the param; an unknown recipe or op lists the known ones). The ledger records the resolved API block and the expanded requests' keys, so a recipe line and the hand-written line it expands into are the same resource. First recipes: `cloudflare.dns_cname` and `turso.database_branch` (docs/recipes.md). The sim's generic REST provider answers per-collection response styles (`RestStyle`: envelopes, cursor, id field, integer ids) and accepts credentials in any `*-Key` or `*-Token` header.
