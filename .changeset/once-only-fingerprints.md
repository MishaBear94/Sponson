---
"@sponson/core": minor
"sponson": minor
---

Once-only outputs are now kept only when proven: the ledger records a keyed fingerprint (never the value) of each `once` output on the producer and of the value each dependent was written with, and a later run keeps a dependent as `{ keep: true }` only when they match. A dependent added later, one whose producer was adopted, one edited outside Sponson, or one that must be created again is refused with `OUTPUT_UNAVAILABLE`. New `sponson apply --recreate <line>` (and `recreate` on the MCP apply tool, `RunOptions.recreate`) deletes what that line created and creates it again in the same run, so the new value reaches every dependent. See ADR 0018.
