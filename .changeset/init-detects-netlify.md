---
"sponson": minor
---

`sponson init` writes Netlify lines when it detects Netlify (`netlify.toml`, `.netlify/state.json`, `@netlify/*` or `netlify-cli`, `NETLIFY_*` variables): `providers.netlify.site` from `.netlify/state.json` (`siteId`) or `NETLIFY_SITE_ID`, a `netlify.env` line for the preview variables (the Neon branch's connection string when Neon is detected), and a Clerk callback on its `deploy_preview_url`. Netlify is no longer listed as "not supported yet".
