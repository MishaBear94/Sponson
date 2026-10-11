---
"@sponson/adapters": minor
"@sponson/sim": minor
---

`http` API blocks: an OAuth2 `token_url` or `audience` written as a path (`/oauth/token`, `/api/v2/`) is resolved against the origin of the block's `base_url`, so a per-account API names its account once. `http.list_item`: `parent.write_list_path` writes the collection under another name than it is read (Kinde reads `{ redirect_urls }`, replaces with `{ urls }`). Recipes may declare `oauth2_client_credentials`, `command` and header-`prefix` credentials. The REST sim stores an object's `write_fields` under their read names.
