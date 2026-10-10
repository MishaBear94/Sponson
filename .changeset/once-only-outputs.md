---
"@sponson/core": minor
---

Ops can declare an output `once: true`: the provider reveals it only when the resource is created (a database password). It reaches dependent lines in that run. In later runs a reference to it resolves to `{ keep: true }`, so a dependent that holds the value stays unchanged and a re-apply writes nothing. A dependent that would need the value again is refused with the new error code `OUTPUT_UNAVAILABLE` before anything is written. Adapters can also declare a second credential variable with `about.extraCredentialEnv`. The in-memory test adapter (`@sponson/core/testing`) has a new once-only output, `token`, and treats `{ keep: true }` values as the marker contract says. See ADR 0018.
