---
"sponson": minor
---

`sponson init` now detects every supported provider, not only the first-class ones: Auth0, Stripe, Sentry, PostHog, Statsig, GrowthBook, Upstash, Resend, Firebase, Railway, Fly.io and the other recipe providers are found from the repository's dependency names, config files and variable names (never their values). For each it writes the recipe's line: ready to apply when every value is known (a Stripe webhook endpoint or an Inngest sync on `{ from: <deploy line>.preview_url }`), otherwise commented out with a `# TODO:` naming where to find each missing value, and listed under "To fill in". Only services nothing manages yet are reported as "Not supported yet". `init --json` marks each provider found with `via: adapter` or `via: recipe`.
