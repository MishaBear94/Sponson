# Architecture

A map for contributors: where things live, what happens when someone runs `sponson plan` or `sponson apply`, and the
handful of ideas the engine is built on. Read it once before your first change; it takes about fifteen minutes. The
reasons behind each idea are in the [architecture decision records](docs/adr/README.md); the file format is specified
in [docs/plan-format.md](docs/plan-format.md).

## The shape of the system

Sponson reads `release.plan.yaml`, a flat list of lines, each one adapter op (such as `neon.branch`; the built-in ones
are listed under [built-in ops](docs/plan-format.md#built-in-ops)). It compares each line with live state at the provider and with the **ledger** of what it
already manages, then either reports the difference (`plan`) or makes it real (`apply`). Every writing run leaves a
**receipt**, stored outside the working tree, which the next run starts from.

```text
                         ┌────────────── packages/cli ───────────────┐
 release.plan.yaml ────▶ │ main.ts: flags, one Redactor, envelope    │ ──▶ stdout: text, or one JSON envelope
 flags, CI env, git ───▶ │ context.ts / detect.ts: plan, ctx, store  │
                         └──────────────────┬────────────────────────┘
                                            │ RunOptions { plan, ctx, registry, store, redactor, ... }
                         ┌──────────────────▼──── packages/core ─────┐
                         │ engine/prepare   filter, order, interpolate│
                         │ engine/inspect   read + diff + judge       │◀──▶ ReceiptStore (receipts/)
                         │ engine/plan      read-only report          │     git-branch | local
                         │ engine/apply     write, ledger, rollback   │
                         │ engine/destroy   remove what Sponson made  │
                         └──────────────────┬────────────────────────┘
                                            │ OpSpec: read / diff / apply / destroy / awaitExternal
                         ┌──────────────────▼─ packages/adapters ────┐
                         │ <adapter>.ts (one per adapter) secrets.ts  │ ──▶ provider HTTP APIs
                         │ http.ts: retries, timeouts, pagination     │     (or packages/sim in tests)
                         └────────────────────────────────────────────┘
```

## Packages and the direction of dependencies

| Package | Contains | Depends on |
|---|---|---|
| `packages/core` (`@sponson/core`) | the plan model and parser, context interpolation, the dependency graph, reference resolution, the engine, the ledger, both receipt stores, the redactor, the adapter and secret-source interfaces, `ERROR_CODES` | nothing in the repo (`yaml`, `zod`) |
| `packages/adapters` (`@sponson/adapters`) | the [built-in adapters](docs/plan-format.md#built-in-ops) and [secret sources](docs/plan-format.md#secret-schemes), the shared HTTP client, the adapter authoring helpers (`common.ts`) | `core` |
| `packages/sim` (`@sponson/sim`) | the local fake cloud: a provider-neutral core (`state.ts`, `server.ts`, `chaos.ts`) and one routes file per provider | nothing |
| `packages/cli` (`sponson`) | the `sponson` binary, context detection, receipt-store selection, plugin loading, text rendering, the JSON envelope, the MCP server | `core`, `adapters` |

Why this direction:

- **`core` knows no provider.** The engine sees adapters only through `OpSpec` (`packages/core/src/types.ts`), so it
  can be tested with an in-memory fake (`packages/core/src/testing/fake.ts`, published as `@sponson/core/testing`) and
  third-party adapters plug in without touching it.
- **`core` knows no CLI.** It speaks in run options (`approvedBy`, `reconcile`, `wait`), never in flags; the CLI maps
  error codes to flags through `cliHint` in `ERROR_CODES`. The MCP server reuses the same engine calls.
- **`sim` shares no code with `adapters`.** The fake cloud is an independent model of the providers' APIs. If
  adapters and sim shared types or helpers, a misunderstanding of an API would be encoded twice and could never be caught.
  The sim's assumptions are numbered at the top of each file in `packages/sim/src/routes/`;
  `scenarios/contract.test.ts` pins the critical ones, against the sim by default and against real accounts with
  `pnpm test:live`.
- **`cli` is the composition root.** It is the only place that decides which adapters exist (`createRegistry()`
  plus `SPONSON_PLUGINS`), which receipt store to use, and how to detect the context from CI or git.

Root-level suites (`scenarios/`, `property/`) import the packages by name; `vitest.config.ts` and
`tsconfig.test.json` map the names to the sources.

## The lifecycle of `sponson plan`

1. **Entry.** `packages/cli/src/bin.ts` calls `run()` in `packages/cli/src/main.ts`, which creates **one `Redactor`
   for the whole command** and wraps stdout and stderr so every byte passes through it.
2. **Invocation.** `commands/plan.ts` → `buildInvocation()` in `context.ts`:
   - `loadPlan()` / `parsePlan()` (`packages/core/src/plan.ts`): YAML → zod schema → semantic checks (unique ids,
     declared environments, `depends_on` and `from:` ids exist, secret-looking literals, pasted display text).
   - `detectCtx()` (`packages/cli/src/detect.ts`): flags, then `SPONSON_CTX_*`, then GitHub Actions, then local git
     and `gh`. The scope is derived from branch and pull request by `scopeFor()` in `packages/core/src/ctx.ts`.
   - `selectStore()`: the git-branch store when there is a remote, otherwise the local one.
   - the registry: built-in adapters plus plugins (`packages/cli/src/registry.ts`).
3. **Prepare** (`engine/prepare.ts`, no I/O): check `--env` is declared; keep the lines whose `environments` include
   it (`changesFor`); order them by references and `depends_on` (`orderChanges` in `graph.ts`, which also reports
   `REF_CYCLE` and `REF_FILTERED`); look up each op in the registry; check every `from:` names a declared output;
   interpolate `${ctx.*}` (`interpolate` in `ctx.ts`); apply op defaults; collect `secret:` references; decide whether
   approval is required (`--env production`, or an op's `writesEnvironment()` says `production`).
4. **Load** (`engine/run-context.ts`, `RunContext`): register every credential-looking environment variable with the
   redactor; read this scope's receipt and build the `Ledger` from it; list the other scopes' ledgers in this
   environment (resources they manage are *foreign*); inherit the head branch's scope when this is a pull request
   (see [Scopes](#scopes-leases-and-succession)). Then `resolveSecrets()` resolves every secret the active lines use
   and registers its value with the redactor, so a CLI-backed secret source runs its CLI in `plan` too; a secret
   that fails is remembered and blocks its line in step 5.
5. **Inspect each line, in order** (`engine/plan.ts` → `inspectLine` in `engine/inspect.ts`): resolve references
   against the outputs of earlier lines (`resolveParams` in `resolve.ts`), call the op's `read` and `diff`, scrub the
   diff of anything matching a registered secret, then judge it against the ledger: drift `missing` or `changed`,
   refusal `DRIFT_CHANGED`, `OWNED_BY_OTHER_SCOPE` or `SECRET_UNRESOLVED`. Ops with external outputs get a
   read-only `awaitExternal` check, so a finished deploy turns `pending` into `create`.
6. **Line status**: `blocked` (a refusal, or a dependency in error), `error` (inspect threw), `pending` (an input is
   not known yet; `waitingOn`, `waitingFor`), else `create`, `update` or `unchanged` from the diff.
7. **Scope drift** (`engine/drift.ts`): `orphan` entries (in the ledger, declared by no line) and `unmanaged`
   resources (listed by an op's `listScope`, managed by no scope).
8. **Output.** `planJson()` / `renderPlan()` in `packages/cli/src/render.ts`; JSON goes through `serialize()` in
   `output.ts`. Exit code 1 if any line is `error` or `blocked`, else 0.

`plan` never writes: not to providers, not to the store (invariant I4, checked after every scenario step).

## The lifecycle of `sponson apply`

Steps 1–3 are the same. Then `applyRun()` (`engine/apply.ts`):

1. **Approval.** `requireApproval()` refuses with `ENV_NOT_APPROVED` before anything else when the run can write to
   production and `approvedBy` is blank.
2. **Lease.** `Lease.acquire()` (`engine/lease.ts`) takes the scope's lock or fails with `LOCK_HELD` (exit 3); with
   `--wait` it polls. The lease renews itself in the background.
3. **Load** as in plan, but without secrets. If this commit is older than the last one applied to the scope
   (`staleness()` in `engine/history.ts`, using receipt history and `git merge-base --is-ancestor`), the run writes
   nothing and returns a receipt with `stale: true`, without resolving a single secret. Only after this staleness
   check does `resolveSecrets()` resolve and register every secret, as in plan.
4. **Each line, in order** (`ApplyRun.processLine`):
   - a dependency failed → `skipped` (`DEPENDENCY_BLOCKED`); a dependency is waiting → `waiting` for the same event;
   - inspect (as in plan, against live state read *now*, not the plan's snapshot);
   - an input is an external output not yet available → `awaitExternal`: without `--wait`, the line is `waiting` and
     the run will end `partial`; with `--wait`, poll until it arrives, fails (`EXTERNAL_FAILED`) or times out
     (`WAIT_TIMEOUT`);
   - a refusal → `blocked`, and the run stops and rolls back exactly as on a failure (step 5);
   - every diff `unchanged` → `unchanged`, no adapter call;
   - otherwise `op.apply()`. Before sending any create, the adapter calls `actx.intend(keys)`; the engine writes those
     keys to the ledger as `intent` and **checkpoints the receipt** (a fenced write) before the request leaves. Then
     `record()` updates the ledger from the result, and outputs (including external ones that already exist) are
     stored on the ledger entries.
5. **On failure or refusal**: remaining lines are `skipped`; `rollback()` first re-reads lines with unresolved intents (a create
   whose answer was lost may have succeeded), then destroys what *this run* created, newest first. A destroy that fails
   leaves `rollback_failed` with the resources named.
6. **Settle** (`settleOrphans`): ledger entries no current line declares become `orphan` (if Sponson created them) or
   are forgotten (if adopted). Lines that did not run keep their entries untouched.
7. **Write**: status `complete`, `partial` (something is `waiting`) or `failed`; append the commit to `history`;
   `lease.write()` (fenced: fails with `LOCK_LOST` if another run took the lock); hand resources over from a
   predecessor scope; release the lease.

`apply --destroy` runs `destroyRun()` (`engine/destroy.ts`) instead: it walks the **ledger**, not the plan, in reverse
creation order, using the provider block recorded with each entry. Entries created by Sponson are destroyed, adopted
ones are forgotten, intents are located first (or reported as `INTENT_UNRESOLVED`). It resolves the plan's secrets
too, only so that a provider error echoing one is masked.

## The ledger

A receipt (`Receipt` in `types.ts`, format version `RECEIPT_VERSION`) has two halves: `lines` says what *this run* did per plan line; `ledger`
says what Sponson *manages* in this environment and scope after the run, independent of lines and of any single run.

- **Identity** is `adapter + provider block + key` (`identity()` in `engine/ledger.ts`). The key comes from the
  adapter and includes every dimension that distinguishes two resources at the provider: `env:preview:feat/x:NAME`
  for Vercel (target, git branch, name), `branch:<name>` for Neon, `redirect:<url>` for Clerk. The provider block is
  part of identity so the same key in two projects is two resources.
- **`createdBy`** is `sponson` (destroyed with the scope), `adopted` (existed before; never destroyed) or `intent`
  (about to be created; claimed as `sponson` if found live, dropped if not).
- **`id`** is the provider's id. Same key with a different id means the resource was deleted and re-created outside
  Sponson: it is reported as replaced and is not Sponson's.
- **`hash`** is an HMAC of the value's sha256 with the scope's random `hashKey`, so a receipt cannot be used to look
  up a low-entropy secret.
- **`line`** is the line that declares it; **`orphan`** marks entries no line declares any more; **`outputs`** keeps
  the line's non-sensitive outputs, including external ones such as `preview_url`.
- Every run starts from the previous ledger and changes only entries it observed or wrote, so failed, skipped,
  waiting and refused lines never make Sponson forget what it owns.

Receipts are stored by `ReceiptStore` (`types.ts`) at `<environment>/<scope>/latest.json`, one `<runId>.json` per run,
and `lock.json` (`receipts/layout.ts`). `GitBranchReceiptStore` (`receipts/git.ts`) commits them to the orphan branch
`sponson/receipts` and uses git's non-fast-forward rejection as compare-and-swap; `LocalReceiptStore`
(`receipts/local.ts`) uses `link(2)` and a short-lived mutex. `parseReceipt()` migrates version 1 receipts in memory
and refuses newer versions (`RECEIPT_VERSION`).

## Scopes, leases and succession

- A **scope** is the lifecycle unit: `pr-<n>`, `branch-<name>` or `main` (`scopeFor()` in `ctx.ts`). Receipts, locks
  and ledgers are per environment and scope. Destroying a scope removes what Sponson created in it.
- **Foreign resources**: what another scope's ledger holds in the same environment. A line may rely on a foreign
  resource but not create or change it (`OWNED_BY_OTHER_SCOPE`), and it is never reported as unmanaged.
- **Lease**: the scope lock is held as a lease with a TTL (default 15 minutes), renewed every TTL/3, each renewal
  scheduled after the previous one finishes. Every receipt write passes the holder, and the store checks it in the
  same atomic step (fencing). A run that lost its lease stops with `LOCK_LOST` before writing again. An expired lock
  is taken over and the receipt records `lockPreempted`.
- **The holder's own deadline**: fencing protects receipts, but providers cannot be fenced. So the holder also tracks
  when its lease runs out, measured from when each acquire/renew was *sent*, and stops itself (`LOCK_LOST`) once less
  than TTL/5 is left — before another run could legitimately take the lock. On the way out it tries one fenced
  receipt write so whatever it already created stays in its ledger.
- **Succession**: when a pull request scope runs and the head branch's own scope (`branch-<name>`) has a ledger
  (an agent applied locally before the PR existed), the PR scope inherits those entries. After a successful apply it
  rewrites the predecessor's receipt without them and with `supersededBy`, so exactly one scope owns each resource.

## References and markers

`resolveParams()` (`resolve.ts`) replaces each `{ from }`, `{ secret }` and `{ keep: true }` leaf. What the adapter
receives is either a concrete value or a **marker** string; adapters classify markers only with `markerKind()`:

| Marker | From | `diff` | `apply` |
|---|---|---|---|
| `pending` | a `from:` whose output is not known yet | shows it as pending with its reference | never receives one |
| `secret` | a `secret:` not resolved in this command | shows it as secret with its reference | never receives one |
| `keep` | `{ keep: true }` | `unchanged` if the resource exists, `PARAM_INVALID` if not | leaves the live value alone |

The same function records each input's state (`literal`, `resolved`, `pending`, `secret`, `kept`) for `plan --json`.
`desiredSide`, `diffValue` and `assertNoPending` in `packages/adapters/src/common.ts` implement the contract for
adapter authors.

Each op declares its outputs as `immediate` or `external` (with an event name, such as `deploy`) and optionally
`sensitive`. That one declaration decides where `apply` stops: there are no phases in the file.

## Drift

| Kind | Meaning | Found by | What happens |
|---|---|---|---|
| `missing` | the ledger says Sponson applied it; it no longer exists | `inspectLine` | recreated by the next apply |
| `changed` | the live value's hash differs from the ledger's, or the provider id changed (`replaced: true`) | `inspectLine` | the line is `blocked` with `DRIFT_CHANGED` unless the run reconciles; an edit that already matches the plan is accepted silently |
| `orphan` | Sponson created it; no line declares it any more | `scopeDrift` | reported, left alone; `apply --destroy` removes it |
| `unmanaged` | exists where a line could own it; no scope manages it | `scopeDrift` via `listScope` | reported, never touched; `sponson init` adopts it as `{ keep: true }` |

## Redaction: one choke point

`Redactor` (`packages/core/src/redact.ts`) is created once per command in `main.ts` and passed down in `RunOptions`.
The engine registers into it, before any output exists: credential-looking environment variables, every resolved
secret, and every sensitive output (and the password inside a URL or DSN). Each value is registered in the encodings a
provider or serializer may produce (raw, JSON-escaped, URL-encoded, base64, line by line, head and tail fragments).

Everything leaves through it: text streams are wrapped in `main.ts`; adapter logs and error messages go through
`actx.redact` and `RunContext.errorText`; JSON is redacted field by field by `redactDeep` and only then serialized
(`serialize()` in `packages/cli/src/output.ts`), skipping enum fields such as `status` so a secret can never corrupt the
structure. Diffs that would display a registered value are turned into `sensitive` sides. Values shorter than four
characters cannot be masked safely; the CLI warns about them.

## The output envelope

Every command, every failure path and every MCP tool answers with one JSON document (`packages/cli/src/output.ts`):

```text
{ ok: true,  command, ...data }
{ ok: false, command, error: { code, message, hint?, ...details } }
```

`ok` is true exactly when the exit code is 0. Every thrown value becomes a `SponsonError` with a code from
`ERROR_CODES` (`packages/core/src/errors.ts`); the table decides the exit code (0 ok, 1 failed, 2 refused before
running, 3 lock) and the CLI hint. [docs/errors.md](docs/errors.md) is generated from it.

## Testing layers

| Layer | Where | What it proves |
|---|---|---|
| unit | `packages/*/src/**/*.test.ts` | parser, graph, redactor, stores, adapters against the sim |
| scenarios | every `*.yaml` under `scenarios/` (by convention `scenarios/<category>/<name>.yaml`), run by `scenarios/runner.test.ts` | one failure mode per file, end to end through the CLI; invariants I1, I4, I6 after every step |
| journeys | `scenarios/journeys/<dimension>/` | long programmatic stories, one directory per dimension (such as `lifecycle` or `secrets`) |
| property | `property/engine.property.test.ts` | the invariants numbered at the top of the file, on random plans, failures and drift |
| contract | `scenarios/contract.test.ts` | the sim's API assumptions; against real accounts with `pnpm test:live` |
| docs | `scenarios/docs/` | the schema, the examples and the generated docs match the code |

See [ADR 0011](docs/adr/0011-testing-against-a-local-fake-cloud.md) for why.

## Where to start

- **A new adapter**: the checklist in [CONTRIBUTING.md](CONTRIBUTING.md#adding-an-adapter); the contract is `OpSpec`
  in `packages/core/src/types.ts`; the smallest complete example is `packages/core/src/testing/fake.ts`.
- **A new error code**: `ERROR_CODES`, then `pnpm docs:gen`.
- **A change to the plan format**: `packages/core/src/plan.ts`, `schema/release.plan.schema.json` and
  `docs/plan-format.md` together; `scenarios/docs/schema.test.ts` checks the parser and the schema agree.
- **A bug**: reproduce it as a scenario first. If the property suite found it, its counterexample is the scenario.
