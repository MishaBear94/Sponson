<!-- sponson:preview -->
### Sponson could not apply the preview for pr-42

This preview has its own database branch, 2 variables and 1 auth callback.

**1 line did not apply**, and 1 line that depends on it is held back: see below for why and how to fix it.

**Preview:** [https://prj\_demo-01234567.vercel.app](https://prj_demo-01234567.vercel.app)

- `db` Neon branch sponson/preview/pr-42 — unchanged · [console](https://console.neon.tech/app/projects/proj_demo/branches/br-11)
- `env` 2 variables (preview, feat/x): `DATABASE_URL` (changed outside Sponson) and `STRIPE_KEY`, values not shown — refused (`DRIFT_CHANGED`) **Fix:** Keep that change by updating the plan, or overwrite it with `sponson apply --reconcile`.
- `callback` Clerk redirect https://prj\_demo-01234567.vercel.app — skipped: depends on `env` (`DEPENDENCY_BLOCKED`)

<sub>apply run-RUNID · plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
