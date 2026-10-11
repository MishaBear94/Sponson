---
"@sponson/adapters": minor
"@sponson/sim": minor
---

`http.resource` outputs can be declared once-only (`{ path, sensitive: true, once: true }`): the value is taken only
from the create that made the object, and later runs treat references to it as ADR 0018 describes. A recipe op can set
what destroy does by default (`destroy: keep`, or `destroy: never` when the provider cannot delete). The generic REST
sim ignores trailing slashes, lists a collection under declared `aliases`, and accepts the credential in declared
`auth_headers`.
