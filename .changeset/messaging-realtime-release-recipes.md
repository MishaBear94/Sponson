---
"@sponson/adapters": minor
"@sponson/sim": minor
"sponson": minor
---

Recipes for six more providers with per-preview state: Mailgun (`mailgun.webhook`, an account webhook, and `mailgun.route`, an inbound route, posting to the preview's URL), Twilio (`twilio.twiml_app`, a TwiML Application per preview that its Voice SDK tokens name), Ably (`ably.webhook_rule`, an integration rule for the preview's channels), and release events as one-off actions with no undo: New Relic (`newrelic.deployment`, a change-tracking marker), Rollbar (`rollbar.deploy`) and BugSnag (`bugsnag.build`). The generic `http` adapter's Basic credential takes a literal user name (`basic: { user: api, password_env }`), and an API block may send lists as repeated form keys (`form_arrays: repeat`). The REST sim reads a repeated form key as a list and stores fields a write names otherwise than its answers under the read names. `sponson init` now finds Mailgun and Twilio, and reports Pusher Channels (no API for its webhooks) and Liveblocks (Enterprise-only Management API) as unmanaged.
