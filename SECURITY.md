# Security policy

Sponson resolves secrets, writes to cloud providers on your behalf, and decides whether a run may touch
production. A bug in any of those is a security bug. Please report it privately.

## Supported versions

Sponson is pre-1.0. Only the latest minor release line receives security fixes; fixes are released as a new
patch version of every affected package (`sponson`, `@sponson/core`, `@sponson/adapters`, `@sponson/sim`).

| Version | Supported |
|---------|-----------|
| 0.2.x   | yes       |
| < 0.2   | no — upgrade; v1 receipts are migrated automatically |

The GitHub Action (`action/`) follows the version of the `sponson` package it runs (its `version` input).

## Reporting a vulnerability

**Never put vulnerability details in a public issue or pull request.**

1. Open an issue with the **Security contact request** form (or titled "Security contact request") and **no
   details** — only that you have something to report. A maintainer ([MAINTAINERS.md](MAINTAINERS.md)) will reply
   with a private channel, normally within two working days.
2. Send the details there.

If the repository's **Security → Advisories → Report a vulnerability** button is available to you, use it instead:
it is private from the first message. (It appears only when the maintainers have enabled private vulnerability
reporting.)

Please include:

- the Sponson version (`sponson --version`) and Node.js version;
- a minimal `release.plan.yaml` and the commands that reproduce the problem (against `pnpm sim` if possible —
  the fake cloud needs no real credentials);
- what leaked or what was bypassed, and where (stdout, stderr, `--json`, a receipt file, a receipts branch,
  a PR comment, MCP output, a provider request).

**Never send real secrets.** Use obvious placeholders such as `sk_test_PLACEHOLDER`; the reproduction should show
the placeholder appearing where it must not.

What to expect:

| Step | Target |
|------|--------|
| Acknowledgement | within 3 business days |
| Triage and severity assessment | within 7 days |
| Fix or mitigation for high/critical issues | within 30 days, coordinated with you |
| Public advisory (GHSA, and a CVE when warranted) | when the fix is released |

We credit reporters in the advisory unless you ask us not to.

## Scope

### In scope

These break promises Sponson makes in its README and in the invariants in `CONTRIBUTING.md`; we treat them
as vulnerabilities, not ordinary bugs:

- **Secret leakage.** A resolved secret value, a provider credential (`VERCEL_TOKEN`, `NEON_API_KEY`,
  `CLERK_SECRET_KEY`, …) or an output marked `sensitive` appearing — in any encoding (plain, URL-encoded,
  base64, JSON-escaped, truncated) — in stdout, stderr, `--json` output, error messages, plan text, MCP
  responses, PR comments written by the Action, or log lines. (Invariant 1.)
- **Receipts.** A secret value or a reversible hash of one written into a receipt or into the history of a
  receipts branch (`sponson-receipts/<env>/<scope>`, or the legacy `sponson/receipts`); a receipt that can be made to
  claim ownership of resources Sponson did not create so that `apply --destroy` deletes them; a receipt or lock that can be forged or tampered with to make
  Sponson modify resources it does not manage. (Invariants 5, 6, 8.)
- **Production approval bypass.** Any way to make Sponson write to `production` — directly, through a line whose
  `writesEnvironment()` is production while `--env` is something else, through MCP, through the GitHub Action,
  or through plugin loading — without `--approved-by` / `SPONSON_APPROVED_BY`. (Invariant 7.)
- **Scope boundary violations.** One scope (a PR, a branch) changing or destroying resources owned by another.
- **Plan-time writes.** `sponson plan` or `status` performing any write to a provider. (Invariant 4.)
- **Code execution from untrusted input.** A plan file, a receipt, or a provider response that causes code to be
  loaded or executed (plugins are loaded only from `SPONSON_PLUGINS`, which is trusted configuration).
- **The GitHub Action** (`action/action.yml`): script injection from PR titles, branch names or other
  attacker-controlled event fields; leaking `github-token` or provider secrets to forked-PR workflows.

### Out of scope

- Vulnerabilities in the providers themselves (Vercel, Neon, Clerk, Doppler, 1Password) — report those to the
  provider.
- Anything requiring an attacker who already controls the machine, the CI runner, the environment variables,
  `SPONSON_PLUGINS`, or write access to the repository's default branch. A plugin is trusted code by design.
- Secrets that the user writes as literals in places Sponson does not treat as secret-bearing, after Sponson's
  `SECRET_LITERAL` check has been deliberately bypassed (please do report a value the check should have caught).
- `@sponson/sim` (the fake cloud) — it is a test tool, binds to `127.0.0.1` and accepts any token on purpose.
- Denial of service through very large plans, or by holding a scope's lock with legitimate credentials.
- Missing hardening with no demonstrated impact (e.g. headers, best-practice suggestions from scanners).
- Vulnerabilities in dependencies with no reachable path in Sponson — Dependabot handles those; open a normal PR.

## Handling secrets as a contributor

- Tests and scenarios use placeholder values and the sim; never commit real tokens. `pnpm test:live` reads
  credentials from your environment only.
- New output paths must go through `Redactor`, and JSON only through `serialize()` in
  `packages/cli/src/output.ts`. If you add an output channel, add it to the secrets journey
  (`scenarios/journeys/secrets/`).
