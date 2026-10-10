---
"@sponson/adapters": minor
---

Feature-flag recipes for the generic `http` adapter, each of which manages one per-preview targeting entry and removes it on destroy (docs/recipes.md):

- `posthog.release_condition` adds a release condition on a flag.
- `statsig.gate_rule` adds a gate rule.
- `growthbook.force_rule` adds a force rule, through the v2 API.
- `unleash.flag_strategy` adds a constrained strategy in an environment. Unleash is per-instance, so set `base_url`.
- `configcat.targeting_rule` adds a targeting rule on a boolean flag.
- `split.targeting_rule` adds a targeting rule in an environment's definition.

Each recipe lists, as numbered assumptions, which API facts are verified against the provider's docs or source and which are not. Flagsmith is not covered: its Admin API expects an `Api-Key` scheme prefix on the credential, which the adapter's auth forms do not send.
