---
"@sponson/adapters": minor
"@sponson/sim": minor
---

`http.list_item` reads a parent with a POST when `parent.read_method: POST` (an Azure Resource Manager list action
such as `listAppSettings`), and recipes may take a `command` or `aws_sigv4` credential and be tested against a
first-class sim (`sim.provider`). The REST sim answers seeded `reads` POSTs without logging a write, and
`ProviderSim.isWrite` receives the provider's state.
