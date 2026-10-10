---
"@sponson/core": minor
"@sponson/adapters": minor
---

**Breaking:** a `launchdarkly` provider block that names a production environment now needs `--approved-by`, even
under `--env preview`: `production: true` in the block, or, without that key, an `environment` key containing `prod`
in any case. If such a key is not production (`preprod`), add `production: false` to the block before the next apply.

The approval gate sees the provider block: `OpSpec.writesEnvironment(params, ctx, provider)` gets the line's provider
block as a third argument (optional for callers, so existing adapters and callers keep working). The generic `http`
adapter takes `production: true` on an API block, making every line through that API need approval.
