# Contributing to Sponson

Thanks for helping. Sponson is small on purpose: one plan format, three commands, a handful of adapters, and a
test suite that is most of the code. Everything you need to work on it runs locally against a fake cloud — no
cloud accounts, no credentials.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Found a vulnerability (a leaked secret, a receipt that
can be tampered with, a way past production approval)? Do not open an issue: follow [SECURITY.md](SECURITY.md).

## First contribution in 10 minutes

```bash
git clone https://github.com/sponson/sponson.git && cd sponson
nvm use                    # Node 24 (.nvmrc); Node 22 works too
corepack enable            # provides the pnpm version pinned in package.json
pnpm install
pnpm test                  # ~2 min: unit, 50+ scenarios, journeys, property suite, tooling — all against the sim
```

Then pick something:

- **An issue labelled [`good first issue`](https://github.com/sponson/sponson/labels/good%20first%20issue)**,
  or one of the items marked so in [ROADMAP.md](ROADMAP.md). Comment on it so nobody duplicates the work.
- **A new adapter** (a provider Sponson should manage): `pnpm new:adapter <name>` generates a working adapter,
  its unit tests, its sim routes and a scenario, and registers them. Run its tests, then turn the example op into
  the real one — see [Adding an adapter](#adding-an-adapter).
- **A bug you hit**: reproduce it as a YAML scenario first (see [Adding a scenario](#adding-a-scenario)); a failing
  scenario is the best bug report and the first half of the fix.

Open a pull request; the [PR template](.github/PULL_REQUEST_TEMPLATE.md) has the checklist (also below). Add a
changeset if users will notice the change. Design changes start with an ADR (see [Decisions](#decisions-and-adrs)).

Useful elsewhere: [ROADMAP.md](ROADMAP.md) (what is next), [CHANGELOG.md](CHANGELOG.md) (what changed),
[MAINTAINERS.md](MAINTAINERS.md) (who reviews, how decisions are made, how to become a maintainer),
[.github/LABELS.md](.github/LABELS.md) (what the labels mean).

## Layout

```
packages/core       plan model, parser, engine (engine/: ledger, inspect, plan, apply, destroy, lease, receipt),
                    receipt stores, adapter interfaces, error codes (errors.ts: ERROR_CODES)
packages/adapters   neon, vercel, clerk adapters; env / doppler / op / aws-sm secret sources; the stable authoring helpers (common.ts)
packages/sim        local fake cloud: provider-neutral core (state.ts, server.ts, chaos.ts) + one routes file per provider
packages/cli        `sponson` CLI, MCP server, plugin loading
scenarios/          YAML scenarios + runner, MCP and contract suites; support.ts is the shared harness
scenarios/journeys/ long system tests along six dimensions (lifecycle, concurrency, providers, agent, humans, secrets)
property/           property-based tests over random plans
action/             GitHub Action
docs/adr/           architecture decision records
scripts/            repository tooling (new-adapter.ts); templates/adapter/ holds what it generates
.changeset/         pending changelog entries (see "Changesets" below)
```

Dependency direction: `core` depends on nothing in the repo; `adapters` depends on `core`; `sim` depends on nothing; `cli` depends on `core` and `adapters`. Tests at the root import packages by name.

## Running

```bash
pnpm install
pnpm typecheck            # sources and tests
pnpm lint
pnpm test                 # unit + scenarios + journeys + property, then the tooling suites (~2 min)
pnpm test:tooling         # scaffold and docs-as-code checks only (they run tsc/eslint; kept separate on purpose)
pnpm test:coverage        # same, with a coverage table
pnpm test:scenarios       # the acceptance catalogue only
pnpm test:live            # contract suite against the real APIs (needs credentials, see scenarios/contract.test.ts)
pnpm sim                  # start the fake cloud on :4777 for manual poking
pnpm sponson plan         # run the CLI from source
pnpm new:adapter <name>   # scaffold an adapter (add --dry-run to see what it would do)
pnpm changeset            # describe a user-visible change for the changelog
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint and tests on Node 22 and 24 (and macOS on 24), a coverage
job that fails below 95% statements, 87% branches or 95% functions, and a packaging job that builds from clean,
packs every package and installs the tarballs into an empty project. Use `pnpm test:coverage` to see what a
change leaves uncovered.

## Adding an adapter

An adapter is an object implementing `ResourceAdapter` from `@sponson/core`: a name and a map of ops. Read `packages/core/src/types.ts` (the contract, with the marker rules next to `OpSpec.diff`) and the fake adapter in `packages/core/src/testing/fake.ts` (`@sponson/core/testing`), the smallest complete example.

The quickest start is the scaffold:

```bash
pnpm new:adapter acme
```

It writes the four files below from `templates/adapter/` — a complete example op (`item`: a named value per
scope, with read/diff/apply/destroy/listScope/adopt) built on the helpers, seven unit tests, a `ProviderSim`
with numbered assumptions, and a scenario covering create, idempotent re-apply, drift and destroy — and makes
the registrations in step 2 and 3 (it prints each edit; re-running it is safe). Everything it generates passes
`pnpm typecheck`, `pnpm lint` and `pnpm test` as is (`scenarios/tooling/new-adapter.test.ts` checks that), so
you can change it one step at a time and keep the tests green. Then replace the TODOs with the real API.

The checklist, in full:

1. **The adapter file**, `packages/adapters/src/<name>.ts`, built with the exported helpers from `@sponson/adapters` (`clientFor`, `diffValue`, `desiredSide`, `requireEnv`, `requireProvider`, `deleteIgnoringNotFound`, `assertNoPending`, `paramError`, `stringParam`). Implement `adopt()` on each op that `sponson init` should be able to adopt, and `writesEnvironment()` when the op targets a deployment environment.
2. **Register it**: in-tree, add it to `createRegistry()` in `packages/adapters/src/index.ts`; out of tree, publish a module exporting `register(registry)` and load it with `SPONSON_PLUGINS=<module>`.
3. **Sim routes**: `packages/sim/src/routes/<name>.ts` implementing `ProviderSim` (seed, reset, drift, routes, and its `env` token/URL variable names), plus one entry in `PROVIDERS` in `packages/sim/src/state.ts`. Write the API assumptions your routes encode at the top of that file, numbered.
4. **One scenario** under `scenarios/`, and an adapter unit test against the sim (`packages/adapters/src/testing.ts`).

Harnesses pick up the new provider's environment from `simEnv(sim)`; nothing else needs editing.

Rules the engine relies on:

- `read` and `diff` never write.
- `apply` is idempotent: with unchanged params it performs zero writes and returns `created: []`.
- Call `actx.intend(keys)` immediately before sending any create. The engine persists it, so a crash or a lost response cannot make Sponson forget what it created.
- Resource keys must include every dimension that makes two resources distinct in the provider (Vercel: target and git branch).
- Use `clientFor`: it owns retries, timeouts, pagination and error classification. Redact provider text with `actx.redact` before truncating it.
- `diff` returns `DiffSide` data, never display strings. Params may carry markers (`markerKind`): `pending`/`secret` (not yet known; `apply` must never see one) and `keep` (equal to whatever is live).
- `destroy` treats "already gone" as success.
- Outputs marked `sensitive` may be returned, but never logged by the adapter; the engine redacts them.
- Throw `SponsonError` with a code from `ERROR_CODES`; adding a code means adding it there, with its exit code and, if the CLI has a remedy, a `cliHint`.

## Adding a scenario

Scenarios live in `scenarios/<category>/<name>.yaml` and are documented at the top of `scenarios/runner.test.ts`. A scenario is a plan, a sim seed, optional chaos, a list of steps, and expectations. After every `run` step the runner checks invariants I1, I4 and I6 below; put scenario-specific expectations under `expect`. Longer, programmatic tests go in `scenarios/journeys/<dimension>/` and use `scenarios/support.ts`.

If the property suite finds a failing case, turn its counterexample into a scenario before fixing the bug.

## The invariants

`property/engine.property.test.ts` checks all eight on random plans, failures and drift:

1. No output (stdout, stderr, receipts, plan text) contains a registered secret value.
2. When a line fails and rollback succeeds, the set of resources is what it was before the run.
3. `apply; apply` — the second performs zero writes.
4. `plan` performs zero writes.
5. Resources no line declares and Sponson never created are never changed.
6. Every receipt parses at every moment, including after a crash.
7. Nothing writes to `production` without approval.
8. After a successful destroy, nothing Sponson created survives — whatever crashed, failed or was lost before.

## Style

- TypeScript strict, ESM, imports end in `.js`.
- Comments say why, not what. Error messages say what happened; the CLI adds the remedy from `cliHint`.
- Nothing that resolves a secret may also format output; secrets go through `Redactor`, and JSON is produced only by `serialize()` in `packages/cli/src/output.ts`.
- When a test fails, find the structural reason before adding a branch: v0.2 was produced by regrouping ~100 failing tests into six gaps (ledger, scope boundaries, transport, leases, redaction, output contract) and fixing each gap once.
- Three CLI commands (`init`, `plan`/`status`, `apply`) plus `mcp`. A fourth needs a design note in the PR explaining why a flag on an existing one is worse.

## Pull requests

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) asks for:

- `pnpm typecheck && pnpm lint && pnpm test` passing locally;
- a test for new behaviour (a unit test, a YAML scenario or a journey) — a bug fix starts with a failing one;
- for adapters, the rules above, sim routes with numbered assumptions, and a scenario;
- a changeset for any user-visible change;
- docs updated where behaviour changed, and an ADR for design changes;
- which of the eight invariants the change could affect, and how they are still checked.

Keep a PR to one concern. Review rules (one approval; a maintainer's for security-sensitive code) are in
[MAINTAINERS.md](MAINTAINERS.md).

## Decisions and ADRs

Changes to the plan or receipt format, the adapter contract, the JSON output, error or exit codes, an invariant,
or the set of CLI commands need an architecture decision record in `docs/adr/` (next free number; context,
decision, alternatives, consequences), merged before or with the code. Open an issue or a draft PR with the ADR
first if you are not sure; MAINTAINERS.md describes how it is accepted.

## Changesets

User-visible changes are described by a changeset, a small Markdown file under `.changeset/`:

```bash
pnpm changeset
```

Choose the bump (before 1.0: `minor` for anything new or breaking, `patch` for fixes) and write one or two
sentences for users. Breaking changes start with `**Breaking:**` and say what to do. The four packages are
released together at one version (`fixed` in `.changeset/config.json`), so it does not matter which you select.
Docs-, test- and CI-only PRs need none. Details: [.changeset/README.md](.changeset/README.md).

## Releasing

Releases are cut by maintainers with `.github/workflows/release.yml`:

1. Every push to `main` opens or updates a **Version Packages** PR (changesets): it consumes `.changeset/*.md`,
   bumps every `package.json` and writes each package's `CHANGELOG.md`. Copy the highlights into the root
   [CHANGELOG.md](CHANGELOG.md) in that PR.
2. After merging it, run the `release` workflow by hand (Actions → release → Run workflow). By default it is a dry
   run that prints what would be published; unticking `dry-run` publishes, behind the `npm` environment's
   required reviewers, with npm provenance, and pushes the `<package>@<version>` tags.

Publishing goes through `pnpm publish` (`changeset publish` calls it), never npm: pnpm rewrites `workspace:*` and
applies `publishConfig`. `prepack` builds each package and copies the root LICENSE into it. The version lives in
each `package.json`; the CLI reads its own at runtime. To check a release locally without publishing:
`pnpm build && pnpm -r --filter './packages/*' exec pnpm pack --pack-destination /tmp/sponson-packs`.
