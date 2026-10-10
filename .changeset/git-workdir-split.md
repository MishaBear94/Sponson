---
"@sponson/core": patch
---

Internal: the git receipt store's plumbing (working clone, git invocations, push outcomes) moved to `receipts/git-workdir.ts`; the store keeps locks, fencing, retries and migration. Behaviour is unchanged.
