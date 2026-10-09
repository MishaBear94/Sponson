# Contributing to Sponson

## Layout

```
packages/core       plan model, parser, engine (engine/: ledger, inspect, plan, apply, destroy, lease, receipt),
                    receipt stores, adapter interfaces, error codes (errors.ts: ERROR_CODES)
packages/adapters   neon, vercel, clerk adapters; env / doppler / op secret sources; the stable authoring helpers (common.ts)
packages/sim        local fake cloud: provider-neutral core (state.ts, server.ts, chaos.ts) + one routes file per provider
packages/cli        `sponson` CLI, MCP server, plugin loading
scenarios/          YAML scenarios + runner, MCP and contract suites; support.ts is the shared harness
scenarios/journeys/ long system tests along six dimensions (lifecycle, concurrency, providers, agent, humans, secrets)
property/           property-based tests over random plans
action/             GitHub Action
```

Dependency direction: `core` depends on nothing in the repo; `adapters` depends on `core`; `sim` depends on nothing; `cli` depends on `core` and `adapters`. Tests at the root import packages by name.

## Running

```bash
pnpm install
pnpm typecheck            # sources and tests
pnpm lint
pnpm test                 # unit + scenarios + journeys + property (~45s)
pnpm test:coverage        # same, with a coverage table
pnpm test:scenarios       # the acceptance catalogue only
pnpm test:live            # contract suite against the real APIs (needs credentials, see scenarios/contract.test.ts)
pnpm sim                  # start the fake cloud on :4777 for manual poking
pnpm sponson plan         # run the CLI from source
```

## Adding an adapter

An adapter is an object implementing `ResourceAdapter` from `@sponson/core`: a name and a map of ops. Read `packages/core/src/types.ts` (the contract, with the marker rules next to `OpSpec.diff`) and the fake adapter in `packages/core/src/testing/fake.ts` (`@sponson/core/testing`), the smallest complete example.

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

## Releasing

Publish with `pnpm publish -r` (not npm): pnpm rewrites `workspace:*` and applies `publishConfig`. `prepack` builds each package and copies the root LICENSE into it. The version lives in each `package.json`; the CLI reads its own at runtime.
