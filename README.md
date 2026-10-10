# Sponson

[![ci](https://github.com/MishaBear94/Sponson/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MishaBear94/Sponson/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Sponson is the plan for everything that ships beside the code.

A sponson is the float welded to the side of a hull so the boat does not roll. The code is the hull. The preview database, environment variables, callbacks, and feature flags are the float. Sponson writes that float into one file an agent can read and a human can diff.

```yaml
# release.plan.yaml
version: 1
providers:
  vercel: { project: prj_xxx }
  neon:   { project: proj_xxx }

changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]

  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }      # a reference, never a value
      STRIPE_KEY:   { secret: "env://STRIPE_KEY" }      # a reference, never a value
    environments: [preview]

  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }                      # exists only after the deploy
    environments: [preview]
```

```
$ sponson plan
sponson plan · preview · pr-42 · plan 7aba4410

+ db        neon.branch           create     Neon branch sponson/preview/pr-42
+ env       vercel.env            create
    + DATABASE_URL (preview)  (pending ← db.connection_string)
    + STRIPE_KEY (preview)    (secret ← env://STRIPE_KEY)
? callback  clerk.redirect_allow  pending    waiting on `env` (deploy)

2 to create, 1 pending
```

## Why this exists

Agents can already change a repository. They cannot safely change the rest of a release.

The code lands in Git. The things that have to move with it do not. A preview database lives in the database console. Environment variables live in the deploy console. OAuth callbacks live in an identity console. Feature flags live in a fourth. A person copies state between them by hand. An agent does the same thing with no shared record of what it intended, what it tried, and what a human approved.

Existing tools each own one slice. Terraform and Pulumi plan resources, not the preview data and callback that belong to this release. Vercel and Railway deploy the app, not the secrets and flags that have to match it. Doppler and Infisical hold secrets, not the release those secrets belong to. A sequence of agent tool calls is not itself a record. A release needs its own file.

Sponson is that file. The format is the product. A hosted approval inbox can come later. A new cloud does not.

## What it does

One release, one plan. Three commands.

| Command | What it does | Writes anything? |
|---|---|---|
| `sponson init` | Detects your Vercel and Neon projects and writes a starter plan. Run again to adopt resources the plan does not know about. | the plan file only |
| `sponson plan` | Reads live state, prints the diff and any drift. | no |
| `sponson apply` | Runs the plan in dependency order. Rolls back what this run created if a line fails. Writes a receipt. | yes |

- **Secrets are references.** `{ secret: "env://NAME" }`, or any other [secret scheme](docs/plan-format.md#secret-schemes). Every command resolves them, `plan` and `apply --destroy` included (so a scheme backed by a secret manager's CLI runs that CLI on `plan` too), and registers each value for masking before anything is printed; only `apply` hands values to an adapter. They are redacted from every byte of output. A literal that looks like a secret is rejected at parse time.
- **References cross lines.** `{ from: db.connection_string }` reads another line's output. Outputs that only exist after an external event (a deploy) stop the run with status `partial`; the next `apply` continues from there. Same command, no flags.
- **Drift is reported, never silently overwritten.** Something changed in a console since the last apply? `plan` says so; `apply` refuses that line until you pass `--reconcile`. Something exists that the plan does not mention? It is listed and left alone.
- **Receipts are the agent's memory.** Each run writes what actually happened to an orphan branch of your repo, one per environment and scope (`sponson-receipts/<env>/<scope>`, so unrelated pull requests never wait on each other): a ledger of every resource the scope owns (kept across failed, refused and crashed runs), what each line did, and which commits were applied. Creates are recorded before they are sent, so even a write whose response was lost is never forgotten. The agent reads the receipt, not its own last tool call.
- **Adopting is not copying.** `sponson init` adopts existing resources as `{ keep: true }`: Sponson takes over that they exist, keeps their live values, and never destroys them.
- **Production needs a human.** `--env production` without `--approved-by` is refused before any adapter is touched. The default environment is always `preview`; nothing is inferred from a branch name.
- **Destroy is symmetric.** `sponson apply --destroy` removes what Sponson created, in reverse order, and never touches resources it merely adopted.

## Quick start

Sponson is not published to npm yet; run it from source:

```bash
git clone https://github.com/MishaBear94/Sponson ~/sponson && (cd ~/sponson && pnpm install && pnpm build)
alias sponson="node ~/sponson/packages/cli/dist/bin.js"
```

Then, in your app's repository:

```bash
sponson init          # writes release.plan.yaml, adds .sponson/ to .gitignore
sponson plan          # read-only diff
sponson apply         # creates the branch, injects the variable, waits for the deploy
```

Third-party adapters and secret sources load as plugins: `SPONSON_PLUGINS=sponson-adapter-x,./local-adapter.mjs`, each module exporting `register(registry)`.

Credentials come from the providers' own conventions (`VERCEL_TOKEN` for Vercel; every adapter's variable is listed under [built-in ops](docs/plan-format.md#built-in-ops)). Sponson has no credential store of its own.

In GitHub Actions, one workflow with three triggers calls the same action:

```yaml
on:
  pull_request: { types: [opened, synchronize, closed] }
  deployment_status:
permissions: { contents: write, pull-requests: write, deployments: read }
jobs:
  sponson:
    runs-on: ubuntu-latest
    # only finished preview deployments; production has its own approved job (see action/README.md)
    if: >-
      github.event_name == 'pull_request' || (github.event.deployment_status.state == 'success' &&
      github.event.deployment.environment != 'Production' && github.event.deployment.environment != 'production')
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
    steps:
      - uses: actions/checkout@v4
        # full history lets Sponson recognise a late build of an older commit
        with: { ref: "${{ github.event.deployment.sha || github.sha }}", fetch-depth: 0 }
      - uses: MishaBear94/Sponson/action@<commit-sha>
        with:
          command: ${{ github.event.action == 'closed' && 'destroy' || 'apply' }}
```

The action comments the plan and the receipt on the pull request. See [action/README.md](action/README.md).

### For agents

`sponson mcp` exposes `sponson_plan`, `sponson_apply` and `sponson_receipt` over stdio. [SKILL.md](SKILL.md) tells an agent when to write a plan line, when to stop and show a human the diff, what `partial` and `blocked` mean, and why it must never write a secret value or approve production itself.

Every command (`init` included) takes `--json`, and every outcome, failures included, is one JSON document: `{ ok, command, ... }` or `{ ok: false, command, error: { code, message } }`. That holds for a mistyped flag (`USAGE`), a plan error, a provider failure (`PROVIDER_*`) and an unexpected crash (`INTERNAL`) alike, and the MCP tools return the same envelope as the first line of every result. `ok` is true exactly when the exit code is 0. Pending, secret and sensitive values are `null` next to an explicit `state`, never placeholder text; display strings exist only in the human-readable output. Secrets are masked in every form a provider may echo them (raw, JSON-escaped, URL-encoded, base64, the password inside a connection string) before anything is printed, logged or written to a receipt, and JSON is masked field by field so redaction can never change its structure.

## How it works

```text
release.plan.yaml ──▶ sponson plan ──▶ diff + drift        (reads adapters, writes nothing)
                 └──▶ sponson apply ─▶ receipt            (dependency order, rollback on failure)
                                        │
                        ┌───────────────┼────────────────┐
                        ▼               ▼                ▼
                   neon.branch     vercel.env      clerk.redirect_allow
                                        │
                                   ── deploy ──   external event: stop, record `waiting`,
                                        │         resume on the next apply
                                        ▼
                                   preview_url ──▶ callback
```

A plan is a flat list. Each line is one adapter op, filtered by `environments:`. Order is derived from references. Every value has a state (`literal`, `resolved`, `pending`, `secret` or `kept`), and the JSON output carries it explicitly so an agent never has to parse prose.

Receipts live on an orphan git branch so CI runs, which start from nothing, can still see what the last run did. The store is an interface; `local` is the alternative, and a hosted one is where a control plane would plug in.

## Verification without a cloud account

This repository was built and accepted entirely against a local fake cloud, because no real provider account was available during development.

- `packages/sim` serves the API subsets the adapters use, with a chaos endpoint: latency, failing or hanging the next N requests matching a rule, `429` with `Retry-After`, lost responses after a successful write, pagination, Neon's asynchronous operations, deployment lifecycles, and console-style drift (edit, delete, delete-and-recreate).
- `scenarios/` holds the acceptance scenarios: one YAML file per failure mode (anywhere under `scenarios/`, grouped by failure family such as mid-run failure, concurrency, drift, secrets, the deploy barrier and mistakes agents or humans make), each run end to end through the CLI by `scenarios/runner.test.ts`.
- `scenarios/journeys/` holds long system tests, one directory per dimension: among them a week of a team's CI lifecycle, many actors at once on real git receipts (including SIGKILL mid-apply), providers misbehaving like real clouds, an agent driving Sponson only through MCP and JSON, humans editing consoles and refactoring plans, and every channel a secret could leak through (including the receipts branches' history and PR comments).
- `property/` generates random plans, failures (including lost responses) and drift, and checks the invariants numbered at the top of `property/engine.property.test.ts`, among them that `plan` writes nothing and that nothing Sponson created survives a successful destroy, over hundreds of generated cases per run (`SPONSON_PROPERTY_RUNS` sets how many).

What the fake cannot prove is that the real APIs behave as assumed. The assumptions are numbered at the top of each provider's routes file in `packages/sim/src/routes/`, each marked verified or unverified.

- **Checked against the published specifications** (Vercel's and Neon's OpenAPI documents, Clerk's Backend API OpenAPI and, for one list envelope, Clerk's own SDKs): every HTTP call the adapters make (path, version, query parameters, request body, response fields read, statuses handled) and every assumption the specifications can settle. The check found and fixed real mismatches, among them Vercel's deployment `gitSource` missing the required repository id and Neon connection strings hard-coded to a new project's database and role names. [docs/api-verification.md](docs/api-verification.md) has the per-call tables, sources and dates.
- **Still needs a live run**: what no specification states, such as how fast an env write reaches a deployment, which Neon requests answer `423` while a branch is created, whether a Neon branch being deleted still lists, and which status Clerk gives a duplicate redirect URL. `scenarios/contract.test.ts` pins the critical ones: it runs against the sim by default and against the real APIs with `pnpm test:live` (see the file header for the required variables). It has not yet been run against real accounts.

## Status

Format, engine, the [built-in adapters](docs/plan-format.md#built-in-ops) and [secret schemes](docs/plan-format.md#secret-schemes), local and git-branch receipt stores, CLI, MCP server, GitHub Action. Not yet: feature-flag targeting, social-login callbacks beyond Clerk, a hosted approval inbox, garbage collection of scopes whose PR closed without the action running.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how a `plan` and an `apply` run through the code, the ledger, scopes, redaction.
- [docs/plan-format.md](docs/plan-format.md): every key of `release.plan.yaml`, value forms, `${ctx.*}`, the built-in ops.
- [docs/errors.md](docs/errors.md): every error code, its exit code and remedy (generated from the code).
- [docs/adr/](docs/adr/README.md): the design decisions and why they were made.
- [examples/](examples/README.md): complete, tested plans to start from.

Editors with the YAML language server validate and complete the plan file from its JSON Schema. Add this as the first
line of `release.plan.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/MishaBear94/Sponson/main/schema/release.plan.schema.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full adapter checklist: the adapter file, its registration (or a plugin loaded with `SPONSON_PLUGINS`), one sim routes file, and one scenario.

## License

Apache-2.0.
