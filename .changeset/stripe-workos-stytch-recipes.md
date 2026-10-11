---
"@sponson/adapters": minor
---

New recipes: `stripe.webhook_endpoint` (a test-mode webhook endpoint per preview at the preview's URL, whose signing secret reaches an env line such as `STRIPE_WEBHOOK_SECRET` in the same run; live-mode keys are refused unless `SPONSON_STRIPE_ALLOW_LIVE=1`), `stripe.product`, `stripe.price` and `stripe.coupon` (test-mode catalog objects; products and prices are archived on destroy), `workos.redirect_uri` (an AuthKit redirect URI) and `stytch.redirect_url` (a redirect URL of a Stytch project environment). See docs/recipes.md.
