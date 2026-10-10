# Changelog

All notable changes to Sponson are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) — before 1.0, a minor release may break things, and every break
is listed under **Breaking**.

The four packages (`sponson`, `@sponson/core`, `@sponson/adapters`, `@sponson/sim`) always share one version.
From the next release on, entries are written by [changesets](.changeset/README.md): each package's
`CHANGELOG.md` is generated in the "Version Packages" PR, and the release highlights are copied here.

## [Unreleased]

### Added

- Contributor tooling: `pnpm new:adapter <name>` scaffolds an adapter, its unit test, its sim routes and a
  scenario, and registers them; issue forms, PR template, CODEOWNERS, Dependabot, changesets-based release
  workflow; CI coverage thresholds, a package/pack smoke job and macOS.
- Documentation as code: `ARCHITECTURE.md`, ADRs in `docs/adr/`, the plan format spec and a JSON Schema
  (`schema/release.plan.schema.json`) kept in parity with the parser by tests, `docs/errors.md` generated from
  `ERROR_CODES`, and runnable `examples/`.
- `ReceiptStore.close()`; the CLI closes the git store after every command, so a long-running `sponson mcp`
  no longer accumulates temporary clones.

### Changed

- **Breaking for `@sponson/core` users:** context detection (`detectCtx`, GitHub Actions and local git/`gh`)
  moved to the `sponson` package behind a `CtxSource` seam; core keeps the pure `scopeFor` and `interpolate`.
- The engine reads approval only from `approvedBy`; the CLI resolves `--approved-by` / `SPONSON_APPROVED_BY`.

### Fixed

- A lease holder whose renewals stall now stops itself before its lease could be taken over, instead of
  continuing to write to providers while another run legitimately holds the scope.

## [0.2.0] — 2026-10-10

A rebuild of the engine around a ledger, after system testing along six dimensions (team lifecycle in CI,
concurrency, misbehaving providers, an agent operator, humans and plan refactors, secrets) found ~100 defects
that were regrouped into six structural gaps and fixed once each.

### Breaking

- **Receipts are version 2.** Each receipt now carries a ledger of every resource the scope owns, the commit
  history of the scope and a per-scope hash key. Version 1 receipts are **migrated automatically**: they are
  read as v2 in memory and written back as v2 by the next run. Nothing to do — but a 0.1 CLI cannot read a
  receipt written by 0.2 (it fails with `RECEIPT_VERSION`), so upgrade every pipeline that shares a receipts
  store at once.
- **Production approval applies per line, not per run.** Approval (`--approved-by`, or the new
  `SPONSON_APPROVED_BY`) is required whenever *any* line writes to `production` — for example a Vercel `env`
  line with `target: production` — whatever `--env` the run uses. Plans that did this from a preview run
  without approval are now refused with `ENV_NOT_APPROVED`.
- **`sponson init` adopts values as `{ keep: true }`.** Adopted Vercel environment variables are written into
  the plan as `{ keep: true }` instead of anything resembling their value: Sponson manages that they exist and
  never destroys them. Adopting a value that does not exist is `PARAM_INVALID`.
- **New line status `blocked`.** `plan` predicts refusals: a line that would be refused (drift without
  `--reconcile`, a resource owned by another scope, missing approval) or that depends on one
  (`DEPENDENCY_BLOCKED`) is reported as `blocked` instead of as a normal create/update. Consumers that switch
  on line status must handle it.
- **JSON output contract.** Every `--json` path — including `init`, usage errors and MCP tools — returns one
  JSON document with an error `code` when it fails. Diffs are structured data (`before`/`after` sides with a
  `state` of `literal`, `sensitive`, `pending`, `secret` or `absent`) instead of display strings.
- **Error codes.** Codes live in one table (`ERROR_CODES` in `@sponson/core`) with their exit codes and CLI
  hints. `APPLY_FAILED` is gone: failures carry a specific code (`PROVIDER_*`, `ROLLBACK_FAILED`,
  `DESTROY_FAILED`, `EXTERNAL_FAILED`, `INTERRUPTED`, …) or `INTERNAL`. New codes: `LOCK_LOST`,
  `STORE_CONTENDED`, `STORE_REJECTED`, `OWNED_BY_OTHER_SCOPE`, `REF_OUTPUT_UNKNOWN`, `USAGE`, `PARAM_INVALID`,
  `DEPENDENCY_BLOCKED`, `INTENT_UNRESOLVED`, `STALE`, and the provider classes `PROVIDER_TRANSIENT`,
  `PROVIDER_CONFLICT`, `PROVIDER_NOT_FOUND`, `PROVIDER_AUTH`, `PROVIDER_INVALID`, `PROVIDER_TIMEOUT`,
  `PROVIDER_RESPONSE`.
- **The `sponson` package's programmatic API is reduced to `run()`** (and the `RunIO` and `SponsonPlugin`
  types). The renderers, command implementations and context helpers it used to export are internal.
- **Adapter contract** (`@sponson/core` types, for adapter authors): adoption moved into the adapter as
  `OpSpec.adopt()` — the CLI no longer parses provider keys; ops that target a deployment environment
  implement `writesEnvironment()`; `AdapterContext` gained `intend(keys)` (call it before every create) and
  `redact(text)`; `diff` returns structured `DiffSide`s. The stable authoring helpers are exported from
  `@sponson/adapters` (`clientFor`, `requireEnv`, `requireProvider`, `diffValue`, `desiredSide`,
  `assertNoPending`, `deleteIgnoringNotFound`, `paramError`, `stringParam`).

### Added

- **Ledger and intents.** Resources are keyed by adapter + provider block + key and kept across failed,
  refused and crashed runs. Creates are recorded as intents before they are sent, so a lost response or a crash
  never orphans a resource. `apply --destroy` works from the ledger: after a successful destroy nothing
  Sponson created survives (new invariant 8).
- **Commit history per scope.** A late deployment event or re-run job for an older commit changes nothing: the
  receipt is marked `stale` and its lines are `skipped` with `STALE` — also for a never-applied commit that
  git ancestry shows is older than the last applied one.
- **Scope boundaries.** Resources owned by another scope are excluded from adoption and cannot be changed
  (`OWNED_BY_OTHER_SCOPE`); a pull request scope takes over its head branch's scope.
- **Plugins.** `SPONSON_PLUGINS` (comma-separated module specifiers) loads third-party adapters and secret
  sources: each module exports `register(registry)`.
- **HTTP layer for adapters.** One client with timeouts, retries honouring `Retry-After`, pagination and
  classified `PROVIDER_*` errors; tunable with `SPONSON_HTTP_TIMEOUT_MS`, `SPONSON_HTTP_RETRIES` and
  `SPONSON_HTTP_RETRY_BASE_MS`.
- **Leases.** Scope locks are renewed (self-paced, so renewals never pile up behind a slow store), receipt
  writes are fenced by the lock holder, expired locks are taken over atomically (`lockPreempted` in the
  receipt), git receipt stores use per-process clones with budgeted backoff, and a receipt that cannot be
  pushed is kept under `.sponson/unpushed/` (`STORE_REJECTED`).
- **Redaction** registers every secret, credential and sensitive output up front in all its encodings; text is
  redacted before it is truncated, and JSON is redacted field by field before serialization.
- `sponson --version` reports the installed package's version.
- The packages are publishable: `publishConfig` points at `dist/`, `prepack` builds and copies the LICENSE,
  each package has a README and `engines: { node: ">=20" }`.
- The GitHub Action gained the `skipped` output (a `deployment_status` with no open pull request, or a
  production deployment for a preview run) and reports `stale` as a status.
- `@sponson/sim` is split into a provider-neutral core and one routes file per provider (`ProviderSim`), each
  listing the API assumptions it encodes.

### Fixed

- Roughly 100 defects found by the new journey suites (`scenarios/journeys/`), among them: secrets echoed back
  by providers in error text, receipts lost when two runs raced for a scope, resources orphaned by a lost
  create response, and late deploy events rolling a scope back to an older commit.

## [0.1.0] — 2026-10-10

First release.

### Added

- **Plan format** `release.plan.yaml` (version 1): lines with `adapter`, `op`, params, `environments` and
  `depends_on`; values are literals, `{ from: line.output }` references or `{ secret: "scheme://…" }`
  references; `${ctx.*}` interpolation; a dependency graph with cycle and unknown-reference checks.
- **Engine**: `plan` / `apply` / `apply --destroy` with rollback of what the run created, resume after a
  partial run, a deploy barrier for outputs that only exist after a deployment, scope locks, drift detection
  (`unmanaged`, `changed`, `missing`, `orphan`) with `--reconcile`, `--wait`, and redaction of secrets.
- **Receipts** in a local directory or on the orphan git branch `sponson/receipts`.
- **Adapters**: `neon.branch`, `vercel.env`, `vercel.deploy`, `clerk.redirect_allow`; secret sources `env://`,
  `doppler://`, `op://`.
- **CLI**: `sponson init`, `plan` (alias `status`), `apply`, and `mcp` (an MCP server for agents); `--json`
  output; `--approved-by` required for `--env production`.
- **GitHub Action** (`action/`) for pull request, deployment status and close events, and `SKILL.md` for agents.
- **`@sponson/sim`**, a local fake Vercel / Neon / Clerk with chaos injection and a write log.
- **Tests**: 53 YAML scenarios across nine failure categories, an MCP smoke test, a property suite checking
  seven invariants over random plans, and a contract suite that runs against the sim or, with
  `pnpm test:live`, the real APIs.

[Unreleased]: https://github.com/sponson/sponson/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sponson/sponson/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sponson/sponson/releases/tag/v0.1.0
