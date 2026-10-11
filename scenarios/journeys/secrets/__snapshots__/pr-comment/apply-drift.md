<!-- sponson:preview -->
### Sponson could not apply the preview for pr-42

This preview has its own database branch, 2 variables and 1 auth callback.

**1 line did not apply**: see below for why and how to fix it.

**Preview:** [https://prj\_demo-01234567.vercel.app](https://prj_demo-01234567.vercel.app)

- `db` Neon branch sponson/preview/pr-42 — unchanged · [console](https://console.neon.tech/app/projects/proj_demo/branches/br-11)
- `env` 2 variables (preview, feat/x): `DATABASE_URL` and `STRIPE_KEY`, values not shown — refused: DATABASE\_URL (preview, feat/x) was changed outside Sponson since the last apply. Apply with reconcile to overwrite it, or update the plan to match. (`DRIFT_CHANGED`) **Fix:** It was changed outside Sponson: keep that change by updating the plan, or overwrite it with `sponson apply --reconcile`.
- `callback` Clerk redirect https://prj\_demo-01234567.vercel.app — skipped: depends on &#96;env&#96; (`DEPENDENCY_BLOCKED`) **Fix:** Fix the line it depends on first.

**Drift**

- DATABASE\_URL (preview, feat/x) (line `env`) was changed outside Sponson; apply refuses to overwrite it. **Fix:** keep the change by updating the plan, or overwrite it with `sponson apply --reconcile`.

<sub>apply run-RUNID · plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
