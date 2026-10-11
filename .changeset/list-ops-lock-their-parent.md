---
"@sponson/adapters": minor
---

`supabase.auth_redirect` and `http.list_item` now lock the object their list lives on (ADR 0019):
`supabase:<project ref>:auth-uri-allow-list`, and `http:<base_url><parent path>` (never a credential). Pull requests
and environments adding or removing entries of one list at the same moment no longer lose each other's writes. A line
whose parent is busy waits with `--wait`, or fails with `LOCK_HELD`. Entries applied by an earlier version carry no
lock name in their receipts: re-apply once (unchanged lines record it) so that a later destroy of them is locked too.
