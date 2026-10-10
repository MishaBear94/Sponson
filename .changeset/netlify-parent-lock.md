---
"@sponson/adapters": patch
---

`netlify.env` lines now lock their site's variables (parent object `netlify:<site>:env`, ADR 0019), so pull requests that create the same variable at once, or destroy its last value while another adds one, no longer fail or lose a value.
