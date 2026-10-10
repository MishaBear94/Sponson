# 14. Secrets are references, never values

Date: 2026-10-10

## Status

Accepted

## Context

The plan file is committed and reviewed in pull requests; agents write it. Any secret value in it is leaked the
moment it is pushed, and an agent asked to "add the Stripe key" will paste the key unless the format makes that
impossible. Sponson also should not become another place where secrets are stored.

## Decision

- A secret is written as `{ secret: "<scheme>://<ref>" }`. Built-in sources: `env://NAME` (the process environment,
  the CI default), `doppler://project/config/NAME` and `op://vault/item/field` (through the providers' own CLIs).
  Plugins add schemes through the `SecretSource` interface.
- A parameter whose name looks like a secret (`_KEY`, `_SECRET`, `_TOKEN`, `PASSWORD`, `_PASS`, `PASSWD`, `PRIVATE`)
  with a literal string or number is rejected at parse time with `SECRET_LITERAL`.
- Sponson has no credential store. Provider credentials come from each provider's own variable (`VERCEL_TOKEN`,
  `NEON_API_KEY`, `CLERK_SECRET_KEY`).
- Values are resolved inside the Sponson process only, registered with the redactor
  ([ADR 0009](0009-single-point-redaction.md)), and passed only to the adapter during `apply`. Receipts keep a keyed
  fingerprint per reference, so a rotated secret is noticed (a warning and an update) without storing anything
  reversible.
- Outputs can be marked `sensitive` (Neon's `connection_string`): they can be referenced, but are never displayed,
  logged or written to receipts.

## Consequences

- A plan is always safe to commit, comment on and paste into an issue.
- `plan` resolves secrets too, so their values can be masked and diffs compare real values; a missing secret blocks
  its line with `SECRET_UNRESOLVED` rather than failing later.
- The name-based check has false positives (a public `NEXT_PUBLIC_POSTHOG_KEY` must be a reference or
  `{ keep: true }`) and false negatives (a secret under an innocent name). It catches the common mistake; the
  redactor is the real defence.
