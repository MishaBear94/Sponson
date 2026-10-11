<!-- sponson:preview -->
### Sponson could not apply the preview for pr-42

Nothing is set up for this preview yet.

**1 line did not apply**: see below for why and how to fix it. What this run created was rolled back.

- `db` database branch — rolled back: this run created it, then removed it because another line failed
- `env` variable — failed: vercel: POST /v10/projects/prj\_demo/env?upsert=true → 500: {"error":"chaos"} (`PROVIDER_TRANSIENT`) **Fix:** The provider failed temporarily: re-run the job (apply resumes safely).
- `callback` auth callback — skipped: depends on &#96;env&#96; (`DEPENDENCY_BLOCKED`) **Fix:** Fix the line it depends on first.

<sub>apply run-RUNID · plan PLANHASH · [run log](https://github.com/acme/app/actions/runs/1001)</sub>
