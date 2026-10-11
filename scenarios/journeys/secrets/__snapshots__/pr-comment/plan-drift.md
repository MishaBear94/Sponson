<!-- sponson:preview -->
### Sponson plan: the preview for pr-42

This preview already has its own database branch.

**1 line is refused**, and 1 line that depends on it is held back: see below for why and how to fix it.

- `db` Neon branch sponson/preview/pr-42 — up to date
- `env` 2 variables (preview, feat/x): `DATABASE_URL` ← `db.connection_string` (value hidden; changed outside Sponson) and `STRIPE_KEY` ← `env://STRIPE_KEY` (secret) — refused (`DRIFT_CHANGED`) **Fix:** Keep that change by updating the plan, or overwrite it with `sponson apply --reconcile`.
- `callback` auth callback — held back: depends on `env`, which cannot be applied (`DEPENDENCY_BLOCKED`)

<sub>plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
