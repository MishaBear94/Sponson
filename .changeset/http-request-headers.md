---
"@sponson/adapters": minor
"@sponson/sim": minor
---

`http.resource` requests take per-request `headers` (values may be references) and `send_fields: false` (the declared fields are compared but carried in headers, not the body), and a path placeholder written `{+name}` keeps a URL as it is (RFC 6570 reserved expansion). Together they express APIs such as QStash's schedules (`POST /v2/schedules/<destination URL>` with `Upstash-Cron`). The REST sim's styles gained `header_fields` and `suffix_field` to stand in for them.
