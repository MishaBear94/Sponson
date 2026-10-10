---
"@sponson/adapters": minor
"@sponson/sim": minor
---

The generic `http` adapter can now declare an output the provider shows only when it creates the object (`outputs.<name>: { path, sensitive: true, once: true }`, such as a webhook signing secret: it reaches dependent lines in the same run, and later runs keep what they hold, ADR 0018), archive instead of delete (`delete: { method: POST, body: { active: false } }`), and refuse credentials by prefix (`refuse_credential: { prefixes: [sk_live_], unless_env: NAME }` on an API block). Recipes gain a `{ join: [...] }` template form for values such as a preview URL plus a path. The REST sim types form values, shows once-only fields only in the create's answer, accepts POST updates to objects, and can list under a suffix and name objects by a query parameter.
