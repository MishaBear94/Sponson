---
"@sponson/adapters": minor
"@sponson/sim": minor
---

Adapter authors: `WriteOptions.contentType` sends a POST or PATCH body with a `Content-Type` other than `application/json` (the body is still JSON), for a JSON dialect such as LaunchDarkly's semantic patch. In `@sponson/sim`, a provider can declare `auth: "raw"` to expect its token as the whole `Authorization` value, and routes receive the request `headers`.
