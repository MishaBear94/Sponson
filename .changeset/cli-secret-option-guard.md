---
"@sponson/adapters": patch
---

Security: the `doppler://` and `aws-sm://` secret sources refused nothing that looked like a command-line option, so a reference such as `doppler://p/c/--help` passed `--help` to the CLI. Every CLI-backed source now declares which arguments come from the reference, and one starting with `-` is refused with SECRET_UNRESOLVED before the CLI runs.
