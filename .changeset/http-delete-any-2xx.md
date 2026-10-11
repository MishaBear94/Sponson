---
"@sponson/adapters": patch
---

`http.resource` destroy accepts any 2xx answer to its delete request, even one that is not JSON (Upstash answers `OK`), instead of failing after the object was deleted.
