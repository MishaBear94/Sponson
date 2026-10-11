---
"@sponson/adapters": minor
---

Five more built-in secret schemes: `vault://mount/path#KEY` (HashiCorp Vault KV v2 over HTTP, `VAULT_ADDR`, `VAULT_TOKEN`, optional `VAULT_NAMESPACE`), `infisical://projectId/env/[folder/…/]NAME` (Infisical CLI; an unknown name is `SECRET_UNRESOLVED`, never the CLI's `*not found*` placeholder), `azure-kv://vault/name[/version]` (Azure CLI), `op-connect://vault/item/[section/]field` (a 1Password Connect server, `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`) and `bws://secret-id` (Bitwarden Secrets Manager CLI, `BWS_ACCESS_TOKEN`). See docs/plan-format.md#secret-schemes.
