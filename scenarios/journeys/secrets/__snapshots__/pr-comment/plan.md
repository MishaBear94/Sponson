<!-- sponson:preview -->
### Sponson plan: the preview for pr-42

Applying this plan gives this preview its own database branch, 2 variables and 1 auth callback.

- `db` Neon branch sponson/preview/pr-42 — will be created
- `env` 2 variables (preview, feat/x): `DATABASE_URL` ← `db.connection_string` and `STRIPE_KEY` ← `env://STRIPE_KEY` (secret) — waits for `db`
- `callback` Clerk redirect ← `env.preview_url` — waits for the preview deploy: the run after the deploy finishes it, nothing to retry

<sub>plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
