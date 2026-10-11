---
"@sponson/adapters": minor
"@sponson/sim": minor
---

New `algolia` adapter with one op, `algolia.index`: an index per scope copied from a template index, waiting for Algolia's copy task to be published before the line counts as applied; destroy deletes the copy, never the template. Needs `ALGOLIA_API_KEY` and `providers.algolia.application_id`. The sim gained an Algolia provider.
