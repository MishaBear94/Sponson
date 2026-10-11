<!-- sponson:preview -->
### Sponson: the preview for pr-42 is almost ready

This preview has its own database branch and 2 variables.

Still to come: 1 auth callback, once the preview deploy finishes (nothing to retry).

- `db` Neon branch sponson/preview/pr-42 — set up in this run · [console](https://console.neon.tech/app/projects/proj_demo/branches/br-11)
- `env` 2 variables (preview, feat/x): `DATABASE_URL` ← `db.connection_string` (value hidden) and `STRIPE_KEY` ← `env://STRIPE_KEY` (secret) — set up in this run · [console](https://vercel.com/d?to=%2F%5Bteam%5D%2F%5Bproject%5D%2Fsettings%2Fenvironment-variables&title=Go+to+Environment+Variables)
- `callback` auth callback — waits for the preview deploy: the run after the deploy finishes it, nothing to retry

<sub>apply run-RUNID · plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
