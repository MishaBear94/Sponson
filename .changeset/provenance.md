---
"sponson": patch
"@sponson/core": patch
"@sponson/adapters": patch
"@sponson/sim": patch
---

Published with npm provenance: each package's `publishConfig` now asks for it. 0.4.0 went out without attestations because `changeset publish` runs `pnpm publish`, which ignores the release workflow's `NPM_CONFIG_PROVENANCE`.
