---
"@sponson/core": minor
---

Added locks on shared parent objects (ADR 0019). An op whose items live in one list on a shared provider object (an
Auth0 application's callback URLs, Supabase's `uri_allow_list`) declares it with `OpSpec.lockOn`; apply, rollback
and destroy then write it holding a lease on that object in the receipts store (a lock-only branch
`sponson-receipts/_locks/<hash>`), so concurrent pull requests and environments never lose each other's items. A held
lock fails the line with `LOCK_HELD`, or is waited for with `--wait`. `ReceiptStore` gains optional parent-lock
methods, implemented by both built-in stores; custom stores get them from their scope-lock methods.
