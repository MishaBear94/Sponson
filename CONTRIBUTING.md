# Contributing to Sponson

## Layout

```
packages/core       plan model, parser, engine (engine/: ledger, inspect, plan, apply, destroy, lease), receipt stores, adapter interfaces
packages/adapters   neon, vercel, clerk adapters; env / doppler / op secret sources
packages/sim        local fake cloud with chaos injection (used by every test above unit level)
packages/cli        `sponson` CLI and MCP server
scenarios/          YAML scenarios + runner, MCP and contract suites: the acceptance suite
scenarios/journeys/ long system tests along six dimensions (lifecycle, concurrency, providers, agent, humans, secrets)
property/           property-based tests over random plans
action/             GitHub Action
```

The dependency direction is strict: `core` depends on nothing in the repo; `adapters` and `sim` depend on `core`; `cli` depends on all three. Tests at the root import packages by name.

## Running

```bash
pnpm install
pnpm typecheck
pnpm test                 # unit + scenarios + property
pnpm test:scenarios       # the acceptance catalogue only
pnpm sim                  # start the fake cloud on :4777 for manual poking
pnpm sponson plan         # run the CLI from source
```

## Adding an adapter

An adapter is one object implementing `ResourceAdapter` from `@sponson/core`: a name and a map of ops. Each op has `read`, `diff`, `apply`, `destroy`, and declares its `outputs`. Read the fake adapter in `packages/core/src/testing/fake.ts` first; it is the smallest complete example and the engine tests run against it.

Rules the engine relies on:

- `read` and `diff` never write.
- `apply` is idempotent: with unchanged params it performs zero writes and returns `created: []`.
- Call `actx.intend(keys)` immediately before sending any create. The engine persists it, so a crash or a lost response cannot make Sponson forget what it created.
- Resource keys must include every dimension that makes two resources distinct in the provider (Vercel: target and git branch).
- Use the shared HTTP client (`clientFor`): it owns retries, timeouts, pagination and error classification. Redact provider text with `actx.redact` before truncating it.
- `diff` returns `DiffSide` data, never display strings. A `{ keep: true }` value arrives as a keep marker: equal to whatever is live.
- `destroy` treats "already gone" as success.
- Outputs marked `sensitive` may be returned, but never logged by the adapter; the engine redacts them.
- A param may arrive as a pending marker (`isPendingMarker`). `diff` shows it as `(pending ← ref)`; `apply` must throw if it sees one.

Add the corresponding routes to `packages/sim` so the scenarios can exercise it, and write at least one scenario.

## Adding a scenario

Scenarios live in `scenarios/<category>/<name>.yaml` and are documented at the top of `scenarios/runner.test.ts`. A scenario is a plan, a sim seed, optional chaos, a list of steps, and expectations. The seven invariants are checked after every step automatically; put scenario-specific expectations under `expect`.

If the property suite finds a failing case, turn its counterexample into a scenario before fixing the bug.

## Style

- TypeScript strict, ESM, imports end in `.js`.
- Comments say why, not what. Error messages say what to do next.
- Nothing that resolves a secret may also format output; secrets go through `Redactor`, and JSON is produced only by `serialize()` in `packages/cli/src/output.ts`.
- When a test fails, ask which structural gap it belongs to before adding a branch. `brainstorm/` (local only) records how v0.2 regrouped ~100 defects into six gaps.
- Three CLI commands. A fourth needs a design note in the PR explaining why a flag on an existing one is worse.
