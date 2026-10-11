---
"sponson": patch
"@sponson/core": patch
"@sponson/adapters": patch
---

Polish the newcomer walkthrough of 0.9.1:

- `init --setup` says what each credential is for, in one sentence: Sponson calls the provider with it, and it is
  not the app's own variable. When the app's `.env*` files name the provider's variables differently, they are named
  ("Sponson calls Stripe with this key; it is not your app's STRIPE_KEY"); only names are read, never values. The
  `--json` report carries it as each credential's `purpose`.
- `setup.next.why` no longer says "the credentials above" (the JSON report has no above): it names the credentials
  that did not check ok and how each stands.
- A credential check that gets a 404 on what the plan names is `not_found` ("check the id in release.plan.yaml"),
  no longer `wrong_scope`, which is kept for a 403. Where the API answers 403 for what a credential cannot reach
  (Cloudflare, LaunchDarkly: `AdapterAbout.notFoundMeansMissing`), the id is wrong; elsewhere a 404 may also mean the
  credential cannot see it, and the message says both.
- `DRIFT_CHANGED`'s remedy says that reconciling adopts a re-created resource only when the drift is a replacement
  (`replaced: true`), not on a plain edit.
- A partial apply's summary reads "callback waits for the deploy" instead of "waiting on deploy for lines callback".
- The PR comment shows a literal value as itself (`MODE` = `preview`) instead of "values not shown", and keeps the
  reference of an unchanged value (`STRIPE_KEY` ← `env://STRIPE_KEY` (secret)) in plan, drift and apply comments
  alike. Plan diffs of unchanged values now describe their `after` like any other diff, and the apply `--json`
  envelope has `inputs`: what each line's values stand for, by line and resource key (never a hidden value).
