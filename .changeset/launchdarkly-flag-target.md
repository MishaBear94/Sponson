---
"@sponson/adapters": minor
"@sponson/sim": minor
"sponson": minor
---

Added the `launchdarkly` adapter: `launchdarkly.flag_target` serves a flag variation to one context key (a preview URL, or the scope such as `pr-42`) in the environment `providers.launchdarkly` names, and `apply --destroy` removes exactly that target. A target moved to another variation in the LaunchDarkly console is `changed` drift. It needs `LAUNCHDARKLY_ACCESS_TOKEN`. `sponson init` now recognises LaunchDarkly as supported and writes a commented example line for it, and `@sponson/sim` simulates LaunchDarkly's flag targeting.
